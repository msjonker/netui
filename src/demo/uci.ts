// The demo router's UCI: committed configs plus one session's staged changes,
// with rpcd's apply/confirm/rollback timing. Changes are reported in the
// same shape as `uci changes` so the review dialog reads them unchanged.

import { UbusStatus } from '../api/ubus';
import type { UciChange, UciConfig, UciSection, UciValue } from '../api/types';

/** A non-zero ubus status for the dispatcher to return. */
export class Status extends Error {
  constructor(readonly code: number) {
    super(`status ${code}`);
  }
}

const clone = <T>(v: T): T => structuredClone(v);

interface Staged {
  values: UciConfig;
  changes: UciChange[];
}

export class UciStore {
  private staged = new Map<string, Staged>();
  private pending: { snapshot: Record<string, UciConfig>; timer: ReturnType<typeof setTimeout> } | null = null;
  private serial = 0x1a2b;

  constructor(
    private live: Record<string, UciConfig>,
    /** Whether the package that owns a config is installed. */
    private exists: (config: string) => boolean,
    /** Called after the committed configs change (apply, rollback). */
    private onCommit: (configs: string[]) => void = () => {},
  ) {}

  /** The committed config, for the rest of the demo router to derive state from. */
  committed(config: string): UciConfig {
    return this.live[config] ?? {};
  }

  /** Change a committed config directly, as a service's own script does (not through netui). */
  patch(config: string, fn: (c: UciConfig) => void): void {
    if (this.live[config]) fn(this.live[config]);
  }

  /** Every committed config the router has. */
  names(): string[] {
    return Object.keys(this.live).filter((c) => this.exists(c));
  }

  private view(config: string): UciConfig {
    if (!this.exists(config) || !this.live[config]) throw new Status(UbusStatus.NOT_FOUND);
    return this.staged.get(config)?.values ?? this.live[config]!;
  }

  private stage(config: string): Staged {
    this.view(config);
    let s = this.staged.get(config);
    if (!s) {
      s = { values: clone(this.live[config]!), changes: [] };
      this.staged.set(config, s);
    }
    return s;
  }

  get(config: string): { values: UciConfig } {
    const values = clone(this.view(config));
    Object.values(values).forEach((s, i) => (s['.index'] = i));
    return { values };
  }

  set(config: string, section: string, values: Record<string, UciValue>): void {
    const s = this.stage(config);
    const sec = s.values[section];
    if (!sec) throw new Status(UbusStatus.NOT_FOUND);
    this.write(s, sec, values);
  }

  private write(s: Staged, sec: UciSection, values: Record<string, UciValue>): void {
    const name = sec['.name'];
    for (const [k, v] of Object.entries(values)) {
      if (Array.isArray(v)) {
        // rpcd stages a list as delete + list-add per item.
        if (sec[k] !== undefined) s.changes.push(['remove', name, k]);
        for (const item of v) s.changes.push(['list-add', name, k, String(item)]);
        sec[k] = v.map(String);
      } else {
        s.changes.push(['set', name, k, String(v)]);
        sec[k] = String(v);
      }
    }
  }

  add(config: string, type: string, name: string | undefined, values: Record<string, UciValue>): string {
    const s = this.stage(config);
    if (name && s.values[name]) throw new Status(UbusStatus.INVALID_ARGUMENT);
    const id = name ?? `cfg${(this.serial++).toString(16).padStart(4, '0')}${type.length.toString(16).padStart(2, '0')}`;
    s.values[id] = { '.anonymous': !name, '.index': Object.keys(s.values).length, '.name': id, '.type': type };
    s.changes.push(name ? ['set', id, type] : ['add', id, type]);
    this.write(s, s.values[id]!, values);
    return id;
  }

  delete(config: string, section: string, options?: string[]): void {
    const s = this.stage(config);
    const sec = s.values[section];
    if (!sec) throw new Status(UbusStatus.NOT_FOUND);
    if (!options) {
      delete s.values[section];
      s.changes.push(['remove', section]);
      return;
    }
    for (const o of options) {
      if (sec[o] === undefined) continue;
      delete sec[o];
      s.changes.push(['remove', section, o]);
    }
  }

  rename(config: string, section: string, name: string): void {
    const s = this.stage(config);
    const sec = s.values[section];
    if (!sec || s.values[name]) throw new Status(UbusStatus.INVALID_ARGUMENT);
    const next: UciConfig = {};
    for (const [k, v] of Object.entries(s.values)) {
      next[k === section ? name : k] = k === section ? { ...v, '.name': name, '.anonymous': false } : v;
    }
    s.values = next;
    s.changes.push(['rename', section, name]);
  }

  changes(config?: string): { changes: Record<string, UciChange[]> } | { changes: UciChange[] } {
    if (config) return { changes: clone(this.staged.get(config)?.changes ?? []) };
    const out: Record<string, UciChange[]> = {};
    for (const [c, s] of this.staged) if (s.changes.length) out[c] = clone(s.changes);
    return { changes: out };
  }

  revert(config: string): void {
    this.staged.delete(config);
  }

  /** Commit every staged config; with rollback, undo it unless confirmed in time. */
  apply(rollback: boolean, timeoutS: number): void {
    if (this.pending) throw new Status(UbusStatus.PERMISSION_DENIED);
    const touched = [...this.staged].filter(([, s]) => s.changes.length).map(([c]) => c);
    if (touched.length === 0) throw new Status(UbusStatus.NO_DATA);
    const snapshot: Record<string, UciConfig> = {};
    for (const c of touched) {
      snapshot[c] = this.live[c]!;
      this.live[c] = this.staged.get(c)!.values;
      this.staged.delete(c);
    }
    if (rollback) this.pending = { snapshot, timer: setTimeout(() => this.rollback(), timeoutS * 1000) };
    this.onCommit(touched);
  }

  confirm(): void {
    if (!this.pending) throw new Status(UbusStatus.NO_DATA);
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  rollback(): void {
    if (!this.pending) throw new Status(UbusStatus.NO_DATA);
    clearTimeout(this.pending.timer);
    Object.assign(this.live, this.pending.snapshot);
    const configs = Object.keys(this.pending.snapshot);
    this.pending = null;
    this.onCommit(configs);
  }
}
