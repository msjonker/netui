// netui.history for component tests: the plugin's behaviour over the fake
// router's committed configs (shapes as in
// test/fixtures/ubus/dl-wrx36/plain/netui.history.*.json).

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import type { HistoryEntry, UciConfig } from '../../src/api/types';

interface Stored extends HistoryEntry {
  before: Record<string, UciConfig | null>;
  after: Record<string, UciConfig | null>;
}

interface State {
  entries: Stored[];
  pending?: Record<string, UciConfig>;
  next: number;
}

const states = new WeakMap<FakeRouter, State>();
const stateOf = (r: FakeRouter) => {
  let s = states.get(r);
  if (!s) states.set(r, (s = { entries: [], next: 1 }));
  return s;
};

const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let clock = 1_795_000_000;

function latest(s: State, pkg: string): UciConfig | null | undefined {
  for (let i = s.entries.length - 1; i >= 0; i--) if (pkg in s.entries[i]!.after) return s.entries[i]!.after[pkg];
  return undefined;
}

/** Seed an entry directly, as if netui had recorded it. */
export function seedHistory(r: FakeRouter, e: Omit<Stored, 'id' | 'time'>): void {
  const s = stateOf(r);
  s.entries.push({ ...clone(e), id: s.next++, time: clock++ });
}

export const handle: FakeReadHandler = (object, method, args, router) => {
  if (object !== 'netui.history') return undefined;
  const s = stateOf(router);
  switch (method) {
    case 'begin': {
      const pending: Record<string, UciConfig> = {};
      const outside: Stored = { id: 0, time: clock++, packages: [], outside: true, before: {}, after: {} };
      for (const p of (args.packages as string[]) ?? []) {
        const cfg = router.configs[p];
        if (!cfg) continue;
        pending[p] = clone(cfg);
        const last = latest(s, p);
        if (last && !same(last, cfg)) {
          outside.packages.push(p);
          outside.before[p] = clone(last);
          outside.after[p] = clone(cfg);
        }
      }
      if (outside.packages.length) s.entries.push({ ...outside, id: s.next++ });
      s.pending = pending;
      return { result: true };
    }
    case 'record': {
      const pending = s.pending;
      s.pending = undefined;
      if (!pending) return { error: 'nothing to record' };
      const e: Stored = { id: 0, time: clock++, packages: [], before: {}, after: {}, user: args.user as string, page: args.page as string };
      for (const [p, before] of Object.entries(pending)) {
        const after = router.configs[p];
        if (!after || same(before, after)) continue;
        e.packages.push(p);
        e.before[p] = before;
        e.after[p] = clone(after);
      }
      if (!e.packages.length) return { result: true, recorded: false };
      s.entries.push({ ...e, id: s.next++ });
      return { result: true, recorded: true, id: s.next - 1 };
    }
    case 'list': {
      const pkgs = new Set(s.entries.flatMap((e) => e.packages));
      return {
        entries: [...s.entries].reverse().map(({ before: _b, after: _a, ...meta }) => meta),
        changed: [...pkgs].filter((p) => !same(latest(s, p), router.configs[p])).sort(),
      };
    }
    case 'get': {
      const e = s.entries.find((x) => x.id === Number(args.id));
      return e ? { id: e.id, time: e.time, before: clone(e.before), after: clone(e.after) } : { error: 'no such entry' };
    }
  }
  return undefined;
};
