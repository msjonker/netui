import type { UciConfig } from '../api/types';
import { bool, diffSection, sectionsOfType, str, type UciOp } from '../api/uci';

// Smart Queues: one sqm-scripts `queue` on the WAN, cake with
// piece_of_cake.qos, limits stored in kbit/s and edited in Mbps.

export interface SqmQueue {
  section: string;
  enabled: boolean;
  interface: string;
  /** kbit/s; 0 leaves that direction unshaped. */
  download: number;
  upload: number;
}

export interface SqmDraft {
  enabled: boolean;
  /** Mbps as typed. */
  down: string;
  up: string;
}

/** The queue on `wanL3` if one exists, else the first queue. */
export function normalizeSqm(cfg: UciConfig, wanL3?: string): SqmQueue | undefined {
  const qs = sectionsOfType(cfg, 'queue');
  const q = qs.find((x) => str(x.interface) === wanL3) ?? qs[0];
  return (
    q && {
      section: q['.name'],
      enabled: bool(q.enabled, false),
      interface: str(q.interface) ?? '',
      download: Number(str(q.download) ?? 0) || 0,
      upload: Number(str(q.upload) ?? 0) || 0,
    }
  );
}

const toMbps = (kbit: number) => (kbit ? String(Math.round(kbit / 10) / 100) : '');

export function sqmDraft(q: SqmQueue | undefined): SqmDraft {
  return { enabled: q?.enabled ?? false, down: toMbps(q?.download ?? 0), up: toMbps(q?.upload ?? 0) };
}

export function validateSqm(d: SqmDraft): Partial<Record<keyof SqmDraft, string>> {
  const e: Partial<Record<keyof SqmDraft, string>> = {};
  if (!d.enabled) return e;
  const bad = (v: string) => !/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0 || Number(v) > 100_000;
  if (bad(d.down)) e.down = 'Enter your download speed in Mbps.';
  if (bad(d.up)) e.up = 'Enter your upload speed in Mbps.';
  return e;
}

/**
 * Ops to save the card. Enabling points the queue at the real WAN device
 * (factory configs name a port that may not exist) and pins cake.
 */
export function sqmOps(d: SqmDraft, q: SqmQueue | undefined, cfg: UciConfig, wanL3: string): UciOp[] {
  const kbit = (v: string) => (v ? String(Math.round(Number(v) * 1000)) : undefined);
  const values = {
    enabled: d.enabled ? '1' : '0',
    ...(d.enabled ? { interface: wanL3, qdisc: 'cake', script: 'piece_of_cake.qos' } : {}),
    download: kbit(d.down),
    upload: kbit(d.up),
  };
  if (q) return diffSection('sqm', q.section, cfg[q.section], values);
  if (!d.enabled) return [];
  const add = Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => !!e[1]));
  return [{ op: 'add', config: 'sqm', type: 'queue', name: 'wan', values: { ...add, linklayer: 'none' } }];
}
