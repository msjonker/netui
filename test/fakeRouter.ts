// An in-memory router behind the api/ubus.ts boundary, for component tests.
// Reads serve the recorded fixtures; uci writes are staged per package and
// reported by `uci changes` in the recorded format, and apply/confirm follow
// the semantics recorded in uci.apply-semantics.json (status 5 when nothing
// is pending, staged changes cleared by apply).
//
// Use with:
//   vi.mock('../api/ubus', async (orig) =>
//     (await import('../../test/fakeRouter')).fakeUbusModule(await orig()));
//
// Nothing here imports api/ubus at runtime: the mock factory loads this file,
// so a static import would be circular. Errors come from the real module.

import type * as Ubus from '../src/api/ubus';
import type { UciChange, UciConfig, UciSection, UciValue } from '../src/api/types';
import type { UciOp } from '../src/api/uci';
import { fixtures, vmFixtures, type VmScenarioName } from './fixtures';

/**
 * Extra read handlers, one module per feature in test/fakeReads/. Each exports
 * `handle(object, method, args, router)` returning the response, or undefined
 * when the call is not its own. They only see calls the built-in switch below
 * does not answer; change built-in answers per test with `router.overrides`.
 */
export type FakeReadHandler = (object: string, method: string, args: Record<string, unknown>, router: FakeRouter) => unknown;
const extraReads = Object.values(
  import.meta.glob<{ handle: FakeReadHandler }>('./fakeReads/*.ts', { eager: true }),
).map((m) => m.handle);

export interface CallRecord {
  object: string;
  method: string;
  args: Record<string, unknown>;
}

const clone = <T,>(v: T): T => structuredClone(v);

// libubus status codes, mirrored from api/ubus.ts.
const UbusStatus = { NOT_FOUND: 4, NO_DATA: 5, PERMISSION_DENIED: 6, METHOD_NOT_FOUND: 3 } as const;
let UbusError: typeof Ubus.UbusError;

export class FakeRouter {
  configs: Record<string, UciConfig>;
  /** Working copies with staged changes applied. */
  private working: Record<string, UciConfig> = {};
  private changes: Record<string, UciChange[]> = {};
  private pending = false;
  /** What a pending rollback restores: configs and staged changes before apply. */
  private snapshot?: { configs: Record<string, UciConfig>; working: Record<string, UciConfig>; changes: Record<string, UciChange[]> };
  private nextId = 0x0a0000;
  calls: CallRecord[] = [];
  /** Hooks to override a method: return undefined to fall through. */
  overrides: ((c: CallRecord) => unknown)[] = [];
  /** Files written through cgi-io upload, by path. */
  uploads = new Map<string, Blob>();
  /** Answer every call after this long (polling tests, with fake timers). */
  latencyMs = 0;
  /** Per call (object.method and its args): requests waiting for an answer, and the most there ever were. */
  inFlight = new Map<string, number>();
  maxInFlight = new Map<string, number>();
  /** Per call: how many were sent. */
  sent = new Map<string, number>();

  /** Live state (device status, interface dump, board.json) the reads return. */
  live: { deviceStatus: () => unknown; ifaceDump: () => unknown; board: () => unknown };

  /** `scenario` serves a test VM recording (test/fixtures/ubus/vm) instead of the dev container. */
  constructor(extra: Record<string, UciConfig> = {}, scenario?: VmScenarioName) {
    const src = scenario ? vmFixtures(scenario) : fixtures;
    this.configs = {
      network: src.uci.network(),
      dhcp: src.uci.dhcp(),
      firewall: src.uci.firewall(),
      ...extra,
    };
    this.live = { deviceStatus: src.deviceStatus, ifaceDump: src.ifaceDump, board: src.board };
  }

  /** Configs as they would be after the staged changes. */
  current(pkg: string): UciConfig | undefined {
    return this.working[pkg] ?? this.configs[pkg];
  }

  writes(): CallRecord[] {
    return this.calls.filter((c) => c.object === 'uci' && ['set', 'add', 'delete'].includes(c.method));
  }

  /**
   * The rollback timer firing: restore the configs, and (as recorded) the
   * staged changes too, which the UI then has to revert.
   */
  rollBack(): void {
    if (!this.pending || !this.snapshot) return;
    ({ configs: this.configs, working: this.working, changes: this.changes } = this.snapshot);
    this.pending = false;
    this.snapshot = undefined;
  }

  handle(object: string, method: string, args: Record<string, unknown> = {}): unknown {
    const rec = { object, method, args };
    this.calls.push(rec);
    for (const o of this.overrides) {
      const r = o(rec);
      if (r !== undefined) {
        if (r instanceof Error) throw r;
        return r;
      }
    }
    const fail = (status: number) => {
      throw new UbusError(status, object, method);
    };
    const key = `${object}.${method}`;
    switch (key) {
      case 'network.interface.dump':
        return this.live.ifaceDump();
      case 'network.device.status':
        return this.live.deviceStatus();
      case 'luci-rpc.getBoardJSON':
        return this.live.board();
      case 'system.info':
        return fixtures.systemInfo();
      case 'system.board':
        return fixtures.systemBoard();
      case 'luci-rpc.getDHCPLeases':
        return fixtures.leases();
      case 'luci-rpc.getHostHints':
        return fixtures.hints();
      case 'iwinfo.devices':
        return { devices: [] };
    }
    if (object !== 'uci') {
      for (const h of extraReads) {
        const r = h(object, method, args, this);
        if (r !== undefined) return r;
      }
      return fail(UbusStatus.METHOD_NOT_FOUND);
    }

    const config = args.config as string;
    const section = args.section as string;
    const stage = () => {
      if (!this.configs[config]) fail(UbusStatus.NOT_FOUND);
      this.working[config] ??= clone(this.configs[config]!);
      this.changes[config] ??= [];
      return this.working[config]!;
    };
    switch (method) {
      case 'get': {
        const cfg = this.current(config);
        if (!cfg) return fail(UbusStatus.NOT_FOUND);
        return { values: clone(cfg) };
      }
      case 'changes':
        return { changes: clone(this.changes) };
      case 'set': {
        const w = stage();
        const s = w[section] ?? fail(UbusStatus.NOT_FOUND);
        for (const [k, v] of Object.entries(args.values as Record<string, UciValue>)) {
          if (v === '') {
            delete s[k];
            this.changes[config]!.push(['remove', section, k]);
          } else {
            s[k] = v;
            if (Array.isArray(v)) {
              this.changes[config]!.push(['remove', section, k]);
              for (const x of v) this.changes[config]!.push(['list-add', section, k, x]);
            } else this.changes[config]!.push(['set', section, k, v]);
          }
        }
        return undefined;
      }
      case 'add': {
        const w = stage();
        const name = (args.name as string | undefined) ?? `cfg${(this.nextId++).toString(16)}`;
        const type = args.type as string;
        const s: UciSection = {
          '.anonymous': !args.name,
          '.index': Object.keys(w).length,
          '.name': name,
          '.type': type,
          ...(args.values as Record<string, UciValue>),
        };
        w[name] = s;
        this.changes[config]!.push(['add', name, type]);
        for (const [k, v] of Object.entries((args.values as Record<string, UciValue>) ?? {})) {
          if (Array.isArray(v)) v.forEach((x) => this.changes[config]!.push(['list-add', name, k, x]));
          else this.changes[config]!.push(['set', name, k, v]);
        }
        return { section: name };
      }
      case 'delete': {
        const w = stage();
        const s = w[section] ?? fail(UbusStatus.NOT_FOUND);
        const options = args.options as string[] | undefined;
        if (options) {
          for (const o of options) {
            if (!(o in s)) fail(UbusStatus.NOT_FOUND);
            delete s[o];
            this.changes[config]!.push(['remove', section, o]);
          }
        } else {
          delete w[section];
          this.changes[config]!.push(['remove', section]);
        }
        return undefined;
      }
      case 'revert': {
        if (!this.changes[config]?.length) return fail(UbusStatus.NOT_FOUND);
        delete this.working[config];
        delete this.changes[config];
        return undefined;
      }
      case 'apply': {
        if (this.pending) return fail(UbusStatus.PERMISSION_DENIED);
        if (args.rollback) this.snapshot = clone({ configs: this.configs, working: this.working, changes: this.changes });
        for (const [pkg, cfg] of Object.entries(this.working)) this.configs[pkg] = cfg;
        this.working = {};
        this.changes = {};
        this.pending = !!args.rollback;
        return undefined;
      }
      case 'confirm':
      case 'rollback': {
        if (!this.pending) return fail(UbusStatus.NO_DATA);
        if (method === 'rollback') this.rollBack();
        this.pending = false;
        this.snapshot = undefined;
        return undefined;
      }
    }
    return fail(UbusStatus.METHOD_NOT_FOUND);
  }
}

export let router = new FakeRouter();

export function resetRouter(extra?: Record<string, UciConfig>, scenario?: VmScenarioName): FakeRouter {
  router = new FakeRouter(extra, scenario);
  return router;
}

/** Module factory for vi.mock('…/api/ubus'): read/call go to `router`. */
export function fakeUbusModule(actual: typeof Ubus): typeof Ubus {
  UbusError = actual.UbusError;
  const run = async <T,>(object: string, method: string, args: object = {}): Promise<T> => {
    const r0 = router;
    const key = `${object}.${method} ${JSON.stringify(args)}`;
    const n = (r0.inFlight.get(key) ?? 0) + 1;
    r0.inFlight.set(key, n);
    r0.maxInFlight.set(key, Math.max(n, r0.maxInFlight.get(key) ?? 0));
    r0.sent.set(key, (r0.sent.get(key) ?? 0) + 1);
    try {
      if (r0.latencyMs) await new Promise((done) => setTimeout(done, r0.latencyMs));
      else await Promise.resolve();
      // A handler returning null stands for rpcd's bare [0]: success, no data.
      const r = r0.handle(object, method, args as Record<string, unknown>);
      return (r === null ? undefined : r) as T;
    } finally {
      r0.inFlight.set(key, (r0.inFlight.get(key) ?? 1) - 1);
    }
  };
  return {
    ...actual,
    read: run,
    call: (object: string, method: string, args?: object) => run(object, method, args),
    cgiBackup: async () => {
      router.calls.push({ object: 'cgi-io', method: 'backup', args: {} });
      return new Blob(['backup']);
    },
    cgiUpload: async (path: string, file: Blob) => {
      router.calls.push({ object: 'cgi-io', method: 'upload', args: { path } });
      router.uploads.set(path, file);
      return { size: file.size, checksum: '' };
    },
  } as typeof Ubus;
}

/** Stage ops on a router directly, the way api/uci.ts stage() calls ubus, and return the result. */
export function stageOn(r: FakeRouter, ops: UciOp[]): Record<string, UciConfig> {
  for (const o of ops) {
    if (o.op === 'set') r.handle('uci', 'set', { config: o.config, section: o.section, values: o.values });
    else if (o.op === 'unset') r.handle('uci', 'delete', { config: o.config, section: o.section, options: o.options });
    else if (o.op === 'add') r.handle('uci', 'add', { config: o.config, type: o.type, name: o.name, values: o.values });
    else r.handle('uci', 'delete', { config: o.config, section: o.section });
  }
  return Object.fromEntries(['network', 'dhcp', 'firewall'].map((p) => [p, r.current(p)!]));
}
