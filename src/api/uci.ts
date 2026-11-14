// UCI wrappers. Reads go through the coalescing read() so a page's configs
// share one request. Writes only ever stage changes in this session; the only
// way they reach flash is apply({rollback: true}) followed by confirm, driven
// by api/apply.ts. There is deliberately no commit() and no apply without
// rollback here.

import { call, read, UbusError, UbusStatus, type CallOptions } from './ubus';
import type { UciChange, UciChangesAll, UciConfig, UciGet, UciSection, UciValue } from './types';

export const APPLY_TIMEOUT_S = 30;

/** Packages the netui ACL may write. */
export type UciPackage =
  | 'network'
  | 'wireless'
  | 'dhcp'
  | 'firewall'
  | 'system'
  | 'sqm'
  | 'upnpd'
  | 'ddns'
  | 'wifi_schedule'
  | 'usteer'
  | 'nlbwmon'
  | 'mwan3'
  | 'adblock-fast'
  | 'opennds';

export async function getConfig(config: string): Promise<UciConfig> {
  const r = await read<UciGet>('uci', 'get', { config });
  return r.values;
}

export async function getChanges(): Promise<Record<string, UciChange[]>> {
  const r = await read<UciChangesAll>('uci', 'changes');
  return r.changes ?? {};
}

// ---------------------------------------------------------------------------
// Staging

/** One staged edit. A list of these is what a settings form produces. */
export type UciOp =
  | { op: 'set'; config: UciPackage; section: string; values: Record<string, UciValue> }
  | { op: 'unset'; config: UciPackage; section: string; options: string[] }
  | {
      op: 'add';
      config: UciPackage;
      type: string;
      values: Record<string, UciValue>;
      /** Named section; anonymous when omitted. */
      name?: string;
    }
  | { op: 'delete'; config: UciPackage; section: string };

/** Stage ops in order. Returns the touched packages, for review and revert. */
export async function stage(ops: UciOp[]): Promise<UciPackage[]> {
  const touched = new Set<UciPackage>();
  for (const o of ops) {
    touched.add(o.config);
    switch (o.op) {
      case 'set':
        if (Object.keys(o.values).length) {
          await call('uci', 'set', { config: o.config, section: o.section, values: o.values });
        }
        break;
      case 'unset':
        if (o.options.length) {
          await call('uci', 'delete', { config: o.config, section: o.section, options: o.options });
        }
        break;
      case 'add':
        await call<{ section: string }>('uci', 'add', {
          config: o.config,
          type: o.type,
          ...(o.name ? { name: o.name } : {}),
          values: o.values,
        });
        break;
      case 'delete':
        await call('uci', 'delete', { config: o.config, section: o.section });
        break;
    }
  }
  return [...touched];
}

/**
 * Compare an edited copy of a section against what the router returned and
 * produce the minimal set/unset ops. Empty strings and empty lists mean
 * "remove the option". Meta keys (".name" etc.) are ignored.
 */
export function diffSection(
  config: UciPackage,
  section: string,
  before: UciSection | undefined,
  after: Record<string, UciValue | undefined>,
): UciOp[] {
  const values: Record<string, UciValue> = {};
  const removed: string[] = [];
  for (const [key, next] of Object.entries(after)) {
    if (key.startsWith('.')) continue;
    const prev = before?.[key];
    const empty = next === undefined || next === '' || (Array.isArray(next) && next.length === 0);
    if (empty) {
      if (prev !== undefined) removed.push(key);
      continue;
    }
    if (!sameValue(prev, next)) values[key] = next;
  }
  const ops: UciOp[] = [];
  if (Object.keys(values).length) ops.push({ op: 'set', config, section, values });
  if (removed.length) ops.push({ op: 'unset', config, section, options: removed });
  return ops;
}

function sameValue(a: unknown, b: UciValue): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Discard staged changes for the given packages. Unchanged packages are fine. */
export async function revert(packages: readonly string[], opts: CallOptions = {}): Promise<void> {
  for (const config of packages) {
    try {
      await call('uci', 'revert', { config }, opts);
    } catch (err) {
      // 4 (NOT_FOUND) means nothing was staged for this package.
      if (!(err instanceof UbusError && err.status === UbusStatus.NOT_FOUND)) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Apply / confirm. Status 6 here means "another apply is pending" or "the
// pending apply belongs to another session", not a lost session.

const APPLY_OPTS: CallOptions = { permissionDeniedIsAuth: false, deferExpiry: true };

export function applyWithRollback(timeoutS = APPLY_TIMEOUT_S): Promise<unknown> {
  return call('uci', 'apply', { rollback: true, timeout: timeoutS }, APPLY_OPTS);
}

export function confirm(timeoutMs = 4_000): Promise<unknown> {
  return call('uci', 'confirm', {}, { ...APPLY_OPTS, timeoutMs });
}

export function rollbackNow(): Promise<unknown> {
  return call('uci', 'rollback', {}, APPLY_OPTS);
}

// ---------------------------------------------------------------------------
// Value helpers for normalizers

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v.join(' ');
  return undefined;
}

/** Lists may be stored as a UCI list or as a space-separated option. */
export function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
  return [];
}

/** UCI booleans: 1/yes/on/true/enabled. */
export function bool(v: unknown, fallback: boolean): boolean {
  const s = str(v);
  if (s === undefined) return fallback;
  return ['1', 'yes', 'on', 'true', 'enabled'].includes(s);
}

export function sectionsOfType(cfg: UciConfig, type: string): UciSection[] {
  return Object.values(cfg)
    .filter((s) => s['.type'] === type)
    .sort((a, b) => a['.index'] - b['.index']);
}
