import type { UciConfig, UciValue } from '../api/types';
import { bool, diffSection, sectionsOfType, str, type UciOp } from '../api/uci';
import { normalizeMac } from '../lib/mac';

// Speed limits per device. Each is a `netui_limit` section in the firewall
// config (mac, download and upload in Mbit/s, name), which fw4 ignores; the
// netui package's /usr/share/netui/limits.sh, run by fw4 through a script
// include on every firewall start and reload, turns them into nftables rules
// that drop what goes over the rate (see that script). Changing them is a
// firewall change, so it goes through apply/rollback like any other.

export const LIMIT_TYPE = 'netui_limit';
export const LIMIT_INCLUDE = 'netui_limits';
export const LIMIT_SCRIPT = '/usr/share/netui/limits.sh';

export interface SpeedLimit {
  section: string;
  /** Normalized lowercase MAC. */
  mac: string;
  name: string;
  /** Mbit/s as stored, '' for no limit that way. */
  download: string;
  upload: string;
  enabled: boolean;
}

export function normalizeLimits(fw: UciConfig): SpeedLimit[] {
  const out: SpeedLimit[] = [];
  for (const s of sectionsOfType(fw, LIMIT_TYPE)) {
    const mac = normalizeMac(str(s.mac) ?? '');
    if (!mac) continue;
    out.push({
      section: s['.name'],
      mac,
      name: str(s.name) ?? '',
      download: str(s.download) ?? '',
      upload: str(s.upload) ?? '',
      enabled: bool(s.enabled, true),
    });
  }
  return out;
}

/** Whether the script include is in place and points at netui's script. */
function includeOk(fw: UciConfig): boolean {
  const s = fw[LIMIT_INCLUDE];
  return s?.['.type'] === 'include' && str(s.path) === LIMIT_SCRIPT && str(s.type) === 'script' && bool(s.enabled, true);
}

export interface LimitDraft {
  /** Mbit/s as typed; empty for no limit. */
  download: string;
  upload: string;
}

const RATE = /^\d+(\.\d+)?$/;

export function validateLimit(d: LimitDraft): string | null {
  for (const [label, v] of [
    ['Download', d.download],
    ['Upload', d.upload],
  ] as const) {
    if (!v) continue;
    if (!RATE.test(v) || +v <= 0) return `${label} is a speed in Mbit/s, e.g. 10 or 0.5.`;
    if (+v > 10000) return `${label} is at most 10000 Mbit/s.`;
  }
  return null;
}

/**
 * Ops to give `mac` this limit (both empty: none). The script include is
 * added with the first limit and kept afterwards: with no limits the script
 * only removes its table.
 */
export function limitOps(fw: UciConfig, mac: string, name: string, d: LimitDraft): UciOp[] {
  const m = normalizeMac(mac) ?? mac.toLowerCase();
  const mine = normalizeLimits(fw).filter((l) => l.mac === m);
  const ops: UciOp[] = [];
  const none = !d.download && !d.upload;
  // Extra sections for the same device (written elsewhere) would add rules of their own.
  for (const l of none ? mine : mine.slice(1)) ops.push({ op: 'delete', config: 'firewall', section: l.section });
  if (none) return ops;
  const values: Record<string, UciValue> = { name: name.slice(0, 64), mac: m.toUpperCase(), download: d.download, upload: d.upload };
  const first = mine[0];
  if (first) ops.push(...diffSection('firewall', first.section, fw[first.section], { ...values, enabled: '' }));
  else ops.push({ op: 'add', config: 'firewall', type: LIMIT_TYPE, values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')) });
  return [...ops, ...includeOps(fw)];
}

/**
 * Ops that put the script include in place (shared with People's pause and
 * bedtime, which the same script applies); empty when it already is.
 */
export function includeOps(fw: UciConfig): UciOp[] {
  if (includeOk(fw)) return [];
  const include = { type: 'script', path: LIMIT_SCRIPT, enabled: '' };
  if (fw[LIMIT_INCLUDE]) return diffSection('firewall', LIMIT_INCLUDE, fw[LIMIT_INCLUDE], include);
  return [{ op: 'add', config: 'firewall', type: 'include', name: LIMIT_INCLUDE, values: { type: 'script', path: LIMIT_SCRIPT } }];
}

/** "10 down, 2 up" style summary, Mbit/s. */
export function limitSummary(l: Pick<SpeedLimit, 'download' | 'upload'>): string {
  const parts = [l.download && `${l.download} Mbit/s down`, l.upload && `${l.upload} Mbit/s up`].filter(Boolean);
  return parts.join(', ');
}

/** Hardware flow offloading sends traffic past the rules that apply limits. */
export function hardwareOffload(fw: UciConfig): boolean {
  return sectionsOfType(fw, 'defaults').some((s) => bool(s.flow_offloading, false) && bool(s.flow_offloading_hw, false));
}
