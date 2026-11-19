// The demo router's netui.history: the plugin's behaviour over the demo's
// committed configs, in memory (a reload starts over, like the rest).

import type { HistoryEntry, UciConfig } from '../api/types';
import type { UciStore } from './uci';

interface Stored extends HistoryEntry {
  before: Record<string, UciConfig | null>;
  after: Record<string, UciConfig | null>;
}

type Args = Record<string, unknown>;

const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const now = () => Math.floor(Date.now() / 1000);

export class DemoHistory {
  private entries: Stored[] = [];
  private pending?: Record<string, UciConfig>;
  private next = 1;

  constructor(private uci: UciStore) {}

  private latest(pkg: string): UciConfig | null | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) if (pkg in this.entries[i]!.after) return this.entries[i]!.after[pkg];
    return undefined;
  }

  begin(a: Args) {
    const pending: Record<string, UciConfig> = {};
    const outside: Stored = { id: 0, time: now(), packages: [], outside: true, before: {}, after: {} };
    for (const p of (a.packages as string[]) ?? []) {
      const cfg = this.uci.committed(p);
      pending[p] = clone(cfg);
      const last = this.latest(p);
      if (last && !same(last, cfg)) {
        outside.packages.push(p);
        outside.before[p] = clone(last);
        outside.after[p] = clone(cfg);
      }
    }
    if (outside.packages.length) this.entries.push({ ...outside, id: this.next++ });
    this.pending = pending;
    return { result: true };
  }

  record(a: Args) {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return { error: 'nothing to record' };
    const e: Stored = { id: 0, time: now(), packages: [], before: {}, after: {} };
    if (a.user) e.user = String(a.user);
    if (a.page) e.page = String(a.page);
    for (const [p, before] of Object.entries(pending)) {
      const after = this.uci.committed(p);
      if (same(before, after)) continue;
      e.packages.push(p);
      e.before[p] = before;
      e.after[p] = clone(after);
    }
    if (!e.packages.length) return { result: true, recorded: false };
    this.entries.push({ ...e, id: this.next++ });
    return { result: true, recorded: true, id: this.next - 1 };
  }

  list() {
    const pkgs = new Set(this.entries.flatMap((e) => e.packages));
    return {
      entries: [...this.entries].reverse().map(({ before: _b, after: _a, ...meta }) => meta),
      changed: [...pkgs].filter((p) => !same(this.latest(p), this.uci.committed(p))).sort(),
    };
  }

  get(a: Args) {
    const e = this.entries.find((x) => x.id === Number(a.id));
    return e ? { id: e.id, time: e.time, before: clone(e.before), after: clone(e.after) } : { error: 'no such entry' };
  }
}
