// Change history: compare two states of a UCI package, and turn the current
// state back into an earlier one with ordinary staged ops (so an undo goes
// through review and apply/rollback like any change).
//
// Anonymous sections have no stable identity: their names (cfgXXXXXX) come
// from their position, so the same rule can have another name in an older
// snapshot. Sections are therefore matched per type: identical ones first
// (longest common subsequence), the rest by position. UCI can only append a
// new section, so where restoring needs one in the middle of its type, the
// sections from there on are rewritten in place instead, which keeps the
// order (it matters for firewall rules) at the cost of a longer review.

import type { UciConfig, UciSection, UciValue } from '../api/types';
import { diffSection, type UciOp, type UciPackage } from '../api/uci';

/** Options whose values are never shown (WiFi keys, provider passwords, tokens). */
export const SECRET_OPTION = /(^|_)(key|password|psk|token|secret)$/;

export function options(s: UciSection): Record<string, UciValue> {
  const out: Record<string, UciValue> = {};
  for (const [k, v] of Object.entries(s)) if (!k.startsWith('.')) out[k] = v as UciValue;
  return out;
}

const canon = (s: UciSection) =>
  JSON.stringify(
    Object.entries(options(s)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

const byIndex = (cfg: UciConfig) => Object.values(cfg).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));

export interface Pair {
  /** Present now. */
  cur?: UciSection;
  /** Present in the other state. */
  tgt?: UciSection;
}

function lcs(a: UciSection[], b: UciSection[]): [number, number][] {
  const ka = a.map(canon);
  const kb = b.map(canon);
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i]![j] = ka[i] === kb[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ka[i] === kb[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/** Match one type's anonymous sections, in order. */
function alignList(a: UciSection[], b: UciSection[]): Pair[] {
  const out: Pair[] = [];
  const positional = (ia: number, ib: number) => {
    for (; ia < a.length || ib < b.length; ia++, ib++) out.push({ ...(ia < a.length ? { cur: a[ia] } : {}), ...(ib < b.length ? { tgt: b[ib] } : {}) });
  };
  let ia = 0;
  let ib = 0;
  for (const [ai, bj] of [...lcs(a, b), [a.length, b.length] as [number, number]]) {
    const ga = ai - ia;
    const gb = bj - ib;
    const k = Math.min(ga, gb);
    for (let x = 0; x < k; x++) out.push({ cur: a[ia + x], tgt: b[ib + x] });
    if (gb > ga && ai < a.length) {
      // A section has to go before ones that stay: rewrite from here on.
      positional(ia + k, ib + k);
      return out;
    }
    for (let x = k; x < ga; x++) out.push({ cur: a[ia + x] });
    for (let x = k; x < gb; x++) out.push({ tgt: b[ib + x] });
    if (ai < a.length) out.push({ cur: a[ai], tgt: b[bj] });
    ia = ai + 1;
    ib = bj + 1;
  }
  return out;
}

/** Every section of `cur` and `tgt`, matched up. */
export function alignConfigs(cur: UciConfig, tgt: UciConfig): Pair[] {
  const out: Pair[] = [];
  const named = new Set([...Object.values(cur), ...Object.values(tgt)].filter((s) => !s['.anonymous']).map((s) => s['.name']));
  for (const name of named) {
    const c = cur[name] && !cur[name]['.anonymous'] ? cur[name] : undefined;
    const t = tgt[name] && !tgt[name]['.anonymous'] ? tgt[name] : undefined;
    if (c && t && c['.type'] !== t['.type']) out.push({ cur: c }, { tgt: t });
    else out.push({ ...(c ? { cur: c } : {}), ...(t ? { tgt: t } : {}) });
  }
  const anon = (cfg: UciConfig) => {
    const m = new Map<string, UciSection[]>();
    for (const s of byIndex(cfg)) if (s['.anonymous']) m.set(s['.type'], [...(m.get(s['.type']) ?? []), s]);
    return m;
  };
  const ca = anon(cur);
  const ta = anon(tgt);
  for (const type of new Set([...ca.keys(), ...ta.keys()])) out.push(...alignList(ca.get(type) ?? [], ta.get(type) ?? []));
  return out;
}

// ---------------------------------------------------------------------------
// What changed

export interface OptionChange {
  option: string;
  /** Joined with ", " for lists; undefined when absent. Secrets are masked. */
  before?: string;
  after?: string;
}

export interface SectionChange {
  kind: 'add' | 'remove' | 'change';
  /** The section as it reads after (or before, when removed). */
  section: UciSection;
  options: OptionChange[];
}

const show = (option: string, v: UciValue | undefined) =>
  v === undefined ? undefined : SECRET_OPTION.test(option) ? '••••••••' : Array.isArray(v) ? v.join(', ') : String(v);

function optionChanges(before: Record<string, UciValue>, after: Record<string, UciValue>): OptionChange[] {
  const out: OptionChange[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({ option: k, before: show(k, a), after: show(k, b) });
  }
  return out;
}

/** Sections added, removed and changed from `before` to `after`. */
export function diffConfigs(before: UciConfig | null, after: UciConfig | null): SectionChange[] {
  const out: SectionChange[] = [];
  for (const p of alignConfigs(before ?? {}, after ?? {})) {
    if (p.cur && p.tgt) {
      const changes = optionChanges(options(p.cur), options(p.tgt));
      if (changes.length) out.push({ kind: 'change', section: p.tgt, options: changes });
    } else if (p.tgt) out.push({ kind: 'add', section: p.tgt, options: optionChanges({}, options(p.tgt)) });
    else if (p.cur) out.push({ kind: 'remove', section: p.cur, options: [] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Going back

/**
 * Ops that make package `pkg` read like `target` again, from `current`.
 * Empty when they already match.
 */
export function restoreOps(pkg: string, current: UciConfig, target: UciConfig): UciOp[] {
  const config = pkg as UciPackage;
  const deletes: UciOp[] = [];
  const sets: UciOp[] = [];
  const adds: UciOp[] = [];
  for (const p of alignConfigs(current, target)) {
    if (p.cur && p.tgt) {
      const want: Record<string, UciValue> = options(p.tgt);
      for (const k of Object.keys(options(p.cur))) if (!(k in want)) want[k] = '';
      sets.push(...diffSection(config, p.cur['.name'], p.cur, want));
    } else if (p.cur) {
      deletes.push({ op: 'delete', config, section: p.cur['.name'] });
    } else if (p.tgt) {
      adds.push({
        op: 'add',
        config,
        type: p.tgt['.type'],
        values: options(p.tgt),
        ...(p.tgt['.anonymous'] ? {} : { name: p.tgt['.name'] }),
      });
    }
  }
  return [...deletes, ...sets, ...adds];
}

/** Packages whose changes can move netui's address or cut the connection for a moment. */
export const DISRUPTIVE = new Set(['network', 'firewall', 'wireless']);

const PACKAGE_LABEL: Record<string, string> = {
  network: 'Networks',
  wireless: 'WiFi',
  dhcp: 'DHCP & DNS',
  firewall: 'Firewall',
  system: 'System',
  sqm: 'Smart Queues',
  upnpd: 'UPnP',
  ddns: 'Dynamic DNS',
  wifi_schedule: 'WiFi schedule',
  usteer: 'Client steering',
  nlbwmon: 'Usage history',
  mwan3: 'Multi-WAN',
  'adblock-fast': 'Ad blocking',
  opennds: 'Guest portal',
  'https-dns-proxy': 'DNS over HTTPS',
  cloudflared: 'Tunnel',
};

export const packageLabel = (pkg: string) => PACKAGE_LABEL[pkg] ?? pkg;

/** The netui page an entry was applied from, as a name: "/settings/wifi" -> "WiFi". */
export function pageLabel(page: string | undefined): string | undefined {
  if (!page) return undefined;
  const PAGES: [RegExp, string][] = [
    [/^\/clients/, 'Client Devices'],
    [/^\/people/, 'People'],
    [/^\/devices/, 'Devices'],
    [/^\/setup/, 'Setup'],
    [/^\/settings\/wifi/, 'WiFi'],
    [/^\/settings\/networks/, 'Networks'],
    [/^\/settings\/ports/, 'Ports'],
    [/^\/settings\/internet/, 'Internet'],
    [/^\/settings\/security/, 'Firewall & Security'],
    [/^\/settings\/vpn/, 'VPN'],
    [/^\/settings\/routing/, 'Routing & DNS'],
    [/^\/settings\/system/, 'System'],
    [/^\/settings\/health/, 'Health Check'],
    [/^\/settings\/history/, 'Change History'],
  ];
  return PAGES.find(([re]) => re.test(page))?.[1];
}
