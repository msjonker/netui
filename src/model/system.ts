import type { LuciTimezones, SystemBoard, SystemInfo, UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { isHostname } from './dns';

// The system package: device name, timezone and NTP. Hardware and firmware
// facts come from `system board` / `system info`.

export interface SystemSettings {
  /** The first `system` section. */
  section: string;
  hostname: string;
  /** Olson-style name as LuCI stores it, spaces and all ("America/New York"). */
  zonename: string;
  /** NTP section, undefined when the config has none. */
  ntpSection?: string;
  ntpEnabled: boolean;
  ntpServer: boolean;
  ntpServers: string[];
}

export function normalizeSystemSettings(cfg: UciConfig): SystemSettings | undefined {
  const s = sectionsOfType(cfg, 'system')[0];
  if (!s) return undefined;
  const ntp = sectionsOfType(cfg, 'timeserver')[0];
  return {
    section: s['.name'],
    hostname: str(s.hostname) ?? '',
    zonename: str(s.zonename) ?? 'UTC',
    ntpSection: ntp?.['.name'],
    ntpEnabled: ntp ? bool(ntp.enabled, true) : false,
    ntpServer: ntp ? bool(ntp.enable_server, false) : false,
    ntpServers: ntp ? list(ntp.server) : [],
  };
}

export interface Timezone {
  name: string;
  tz: string;
}

/** Zones from `luci getTimezones`, sorted, with UTC first. */
export function normalizeTimezones(z: LuciTimezones): Timezone[] {
  const out = Object.entries(z)
    .map(([name, v]) => ({ name, tz: v.tzstring }))
    .filter((x) => x.name !== 'UTC')
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ name: 'UTC', tz: 'GMT0' }, ...out];
}

export function validateSystem(d: SystemSettings, zones: Timezone[] | undefined): Partial<Record<keyof SystemSettings, string>> {
  const e: Partial<Record<keyof SystemSettings, string>> = {};
  if (!d.hostname || !isHostname(d.hostname)) e.hostname = 'Letters, digits and hyphens only, e.g. home-router.';
  if (zones && !zones.some((z) => z.name === d.zonename)) e.zonename = 'Pick a timezone from the list.';
  const bad = d.ntpServers.find((s) => !isHostname(s));
  if (bad !== undefined) e.ntpServers = `"${bad}" is not a host name or address.`;
  else if (d.ntpEnabled && d.ntpServers.length === 0) e.ntpServers = 'Add at least one server.';
  return e;
}

export function systemOps(d: SystemSettings, cfg: UciConfig, zones: Timezone[] | undefined): UciOp[] {
  const sys = cfg[d.section];
  const after: Record<string, string> = { hostname: d.hostname };
  if (d.zonename !== (str(sys?.zonename) ?? 'UTC')) {
    after.zonename = d.zonename;
    // Without the POSIX string the zone name alone does nothing.
    after.timezone = zones?.find((z) => z.name === d.zonename)?.tz ?? '';
  }
  const ops = diffSection('system', d.section, sys, after);
  const ntp = {
    enabled: d.ntpEnabled ? '1' : '0',
    enable_server: d.ntpServer ? '1' : '0',
    server: d.ntpServers,
  };
  if (d.ntpSection) ops.push(...diffSection('system', d.ntpSection, cfg[d.ntpSection], ntp));
  else if (d.ntpEnabled || d.ntpServer) {
    const { server, ...flags } = ntp;
    ops.push({ op: 'add', config: 'system', type: 'timeserver', name: 'ntp', values: server.length ? ntp : flags });
  }
  return ops;
}

/** Router clock minus browser clock, in seconds. */
export function clockSkew(routerEpoch: number, browserMs: number): number {
  return Math.round(routerEpoch - browserMs / 1000);
}

/** Skews beyond this are worth telling the user about. */
export const SKEW_WARN_S = 120;

// ---------------------------------------------------------------------------
// Hardware and firmware

export interface SystemDetails {
  model: string;
  board: string;
  firmware: string;
  target: string;
  kernel: string;
  cpu: string;
  uptime: number;
  load: [number, number, number];
  memory: { used: number; total: number };
  /** Overlay (writable) storage, when reported. */
  storage?: { used: number; total: number };
}

export function systemDetails(board: SystemBoard, info: SystemInfo): SystemDetails {
  const m = info.memory;
  const available = m.available ?? m.free + m.buffered + (m.cached ?? 0);
  const root = info.root;
  return {
    model: board.model,
    board: board.board_name,
    firmware: board.release.description,
    target: board.release.target,
    kernel: board.kernel,
    cpu: board.system,
    uptime: info.uptime,
    load: [info.load[0] / 65536, info.load[1] / 65536, info.load[2] / 65536],
    memory: { used: m.total - available, total: m.total },
    // rpcd reports root in KiB.
    storage: root && { used: root.used * 1024, total: root.total * 1024 },
  };
}
