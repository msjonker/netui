// Events: the router's syslog (`log read`) turned into readable events.
//
// Line formats are typed against test/fixtures/ubus/dl-wrx36/plain/log.read.json
// (real, OpenWrt SNAPSHOT) and the hand-written log.read.synthetic.json next to
// it for lines the test router had not produced yet (hostapd station events,
// WAN up/down, failed logins). Anything unrecognized is kept as a raw System
// event with the syslog severity, so nothing in the log is ever hidden from
// the raw view.
//
// The parser is pure: names come from the merged client list passed in.

import type { LogEntry } from '../api/types';
import { normalizeMac } from '../lib/mac';
import type { Client } from './clients';
import { networkLabel } from './network';
import { BAND_LABEL, frequencyBand, type LiveDevice, type WifiModel } from './wifi';

export type EventCategory = 'clients' | 'internet' | 'wifi' | 'dhcp' | 'admin' | 'system';

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  clients: 'Clients',
  internet: 'Internet',
  wifi: 'WiFi',
  dhcp: 'DHCP',
  admin: 'Security & Admin',
  system: 'System',
};

export type Severity = 'error' | 'warning' | 'info' | 'debug';

export type EventKind =
  | 'client-connected'
  | 'client-disconnected'
  | 'wrong-password'
  | 'wifi-up'
  | 'wifi-down'
  | 'dhcp-lease'
  | 'dhcp-release'
  | 'dhcp-refused'
  | 'internet-up'
  | 'internet-down'
  | 'network-up'
  | 'network-down'
  | 'port-up'
  | 'port-down'
  | 'admin-login'
  | 'admin-login-failed'
  | 'router-started'
  | 'router-ready'
  | 'router-restarting'
  | 'firewall-reload'
  | 'raw';

/** Message text, with client references the UI renders as links. */
export type EventPart = string | { mac: string; label: string };

export interface NetEvent {
  /** logd line id: the only reliable order (the router clock may be wrong). */
  id: number;
  /** ms since the epoch by the router's clock. */
  time: number;
  category: EventCategory;
  severity: Severity;
  kind: EventKind;
  parts: EventPart[];
  /** `parts` as plain text, for search and notifications. */
  text: string;
  /** Worth a notification: internet up/down, admin logins, router restarts. */
  important: boolean;
  mac?: string;
  ip?: string;
  /** Not recognized; `text` is the line itself. */
  raw: boolean;
  /** "kernel" for kernel lines, else the syslog tag ("dnsmasq-dhcp", "hostapd"). */
  process: string;
  /** "daemon.notice" etc., as logread prints it. */
  level: string;
  /** The line as logged. */
  line: string;
}

export interface EventContext {
  clients?: Client[];
  /** iwinfo/hostapd ifname ("phy0-ap0") -> SSID and band label it serves. */
  wifi?: Record<string, { ssid?: string; band?: string }>;
  /** UCI interfaces that are the internet uplink. Default wan, wan6. */
  wanNetworks?: Set<string>;
  /** Physical ports by netdev name, with whether each is the WAN port. */
  ports?: Record<string, 'wan' | 'lan' | 'unused'>;
}

const FACILITY = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];
const LEVEL = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];

export function syslogSeverity(priority: number): Severity {
  const s = priority & 7;
  return s <= 3 ? 'error' : s === 4 ? 'warning' : s === 7 ? 'debug' : 'info';
}

export function syslogLevel(priority: number): string {
  return `${FACILITY[priority >> 3] ?? 'unknown'}.${LEVEL[priority & 7]}`;
}

/** Kernel lines carry "[  611.716545] " (seconds since boot); syslog lines "tag[pid]: ". */
export function splitLine(e: LogEntry): { process: string; text: string; uptime?: number } {
  let msg = e.msg;
  let uptime: number | undefined;
  if (e.source === 0) {
    const k = /^\[\s*(\d+\.\d+)\]\s?([\s\S]*)$/.exec(msg);
    if (k) {
      uptime = Number(k[1]);
      msg = k[2]!;
    }
    // procd logs to the kernel buffer while booting and shutting down.
    const p = /^(procd): ([\s\S]*)$/.exec(msg);
    return p ? { process: 'procd', text: p[2]!, uptime } : { process: 'kernel', text: msg, uptime };
  }
  const m = /^([^\s:[\]]+)(?:\[\d+\])?: ?([\s\S]*)$/.exec(msg);
  return m ? { process: m[1]!, text: m[2]! } : { process: '', text: msg };
}

/**
 * ifname -> SSID/band from the WiFi model. Some builds leave `ssid` out of
 * iwinfo info (the DL-WRX36 SNAPSHOT does), so the model cannot tie an
 * ifname to its SSID; then the live frequency gives the band, and the band's
 * radio gives the SSID if it serves exactly one.
 */
export function wifiIfnames(
  model: WifiModel | undefined,
  live: LiveDevice[] = [],
): Record<string, { ssid?: string; band?: string }> {
  const out: Record<string, { ssid?: string; band?: string }> = {};
  for (const w of model?.wlans ?? []) {
    for (const m of w.members) if (m.ifname) out[m.ifname] = { ssid: w.ssid, band: m.bandLabel };
  }
  for (const a of model?.assoc ?? []) if (a.ssid) out[a.ifname] ??= { ssid: a.ssid, band: a.band };
  for (const d of live) {
    if (out[d.ifname] || (d.info?.mode ?? 'Master') !== 'Master') continue;
    const band = frequencyBand(d.info?.frequency);
    const radio = model?.radios.find((r) => r.band && r.band === band);
    if (!band || !radio) continue;
    const ssids = (model?.wlans ?? []).filter((w) => w.members.some((m) => m.radio === radio.section && m.enabled));
    out[d.ifname] = { ssid: d.info?.ssid ?? (ssids.length === 1 ? ssids[0]!.ssid : undefined), band: BAND_LABEL[band] };
  }
  return out;
}

const MAC = '([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})';

type Draft = Pick<NetEvent, 'category' | 'severity' | 'kind' | 'parts'> &
  Partial<Pick<NetEvent, 'important' | 'mac' | 'ip'>>;

interface Resolver {
  client(mac: string, fallback?: string): { mac: string; label: string };
  /** A client link plus the address, or just the address. */
  host(ip: string): EventPart[];
  /** "netui-test (5 GHz)", or the bare ifname when the radio is unknown. */
  wifi(ifname: string): string;
  wan(iface: string): boolean;
}

function resolver(ctx: EventContext): Resolver {
  const byMac = new Map<string, Client>();
  const byIp = new Map<string, Client>();
  for (const c of ctx.clients ?? []) {
    byMac.set(c.mac, c);
    if (c.ip) byIp.set(c.ip, c);
    for (const o of c.otherAddresses ?? []) byIp.set(o.ip, c);
  }
  const wan = ctx.wanNetworks ?? new Set(['wan', 'wan6']);
  return {
    client(raw, fallback) {
      const mac = normalizeMac(raw) ?? raw.toLowerCase();
      return { mac, label: byMac.get(mac)?.name ?? fallback ?? mac };
    },
    host(ip) {
      const c = byIp.get(ip);
      return c?.name ? [{ mac: c.mac, label: c.name }, ` (${ip})`] : [ip];
    },
    wifi(ifname) {
      const w = ctx.wifi?.[ifname];
      if (!w?.ssid) return ifname;
      return w.band ? `${w.ssid} (${w.band})` : w.ssid;
    },
    wan: (iface) => wan.has(iface),
  };
}

type Rule = (text: string, r: Resolver, ctx: EventContext) => Draft | undefined;

const hostapd: Rule = (text, r) => {
  let m = new RegExp(`^(\\S+): AP-STA-(CONNECTED|DISCONNECTED) ${MAC}`).exec(text);
  if (m) {
    const c = r.client(m[3]!);
    const on = m[2] === 'CONNECTED';
    return {
      category: 'clients',
      severity: 'info',
      kind: on ? 'client-connected' : 'client-disconnected',
      parts: [c, `${on ? ' connected to' : ' disconnected from'} ${r.wifi(m[1]!)}`],
      mac: c.mac,
    };
  }
  m = new RegExp(`^(\\S+): AP-STA-POSSIBLE-PSK-MISMATCH ${MAC}`).exec(text);
  if (m) {
    const c = r.client(m[2]!);
    return {
      category: 'admin',
      severity: 'warning',
      kind: 'wrong-password',
      parts: [c, ` tried to join ${r.wifi(m[1]!)} with the wrong password`],
      mac: c.mac,
    };
  }
  m = /^(\S+): AP-(ENABLED|DISABLED)$/.exec(text);
  if (m) {
    const on = m[2] === 'ENABLED';
    return {
      category: 'wifi',
      severity: 'info',
      kind: on ? 'wifi-up' : 'wifi-down',
      parts: [`WiFi ${r.wifi(m[1]!)} ${on ? 'is on' : 'turned off'}`],
    };
  }
  return undefined;
};

const dhcp: Rule = (text, r) => {
  const m = new RegExp(`^DHCP(ACK|RELEASE|NAK|DECLINE)\\((\\S+)\\) (\\S+) ${MAC}(?: (.*))?$`).exec(text);
  if (!m) return undefined;
  const [, op, , ip, mac, rest] = m;
  // DHCPACK's trailing field is the hostname the client sent; NAK's is a reason.
  const c = r.client(mac!, op === 'ACK' ? rest?.trim() || undefined : undefined);
  switch (op) {
    case 'ACK':
      return { category: 'dhcp', severity: 'info', kind: 'dhcp-lease', parts: [`Assigned ${ip} to `, c], mac: c.mac, ip };
    case 'RELEASE':
      return { category: 'dhcp', severity: 'info', kind: 'dhcp-release', parts: [c, ` released ${ip}`], mac: c.mac, ip };
    default:
      return {
        category: 'dhcp',
        severity: 'warning',
        kind: 'dhcp-refused',
        parts: [op === 'NAK' ? `Refused ${ip} to ` : `Address ${ip} declined by `, c, rest ? ` (${rest.trim()})` : ''],
        mac: c.mac,
        ip,
      };
  }
};

const netifd: Rule = (text, r, ctx) => {
  let m = /^Interface '([^']+)' is now (up|down)$/.exec(text);
  if (m) {
    const [, iface, state] = m;
    const up = state === 'up';
    if (r.wan(iface!)) {
      const which = /6$/.test(iface!) ? ' (IPv6)' : iface === 'wan' ? '' : ` (${iface})`;
      return {
        category: 'internet',
        severity: up ? 'info' : 'warning',
        kind: up ? 'internet-up' : 'internet-down',
        parts: [up ? `Internet connected${which}` : `Internet connection lost${which}`],
        important: true,
      };
    }
    if (iface === 'loopback') return undefined;
    return {
      category: 'system',
      severity: 'info',
      kind: up ? 'network-up' : 'network-down',
      parts: [`Network ${networkLabel(iface!)} ${up ? 'is up' : 'went down'}`],
    };
  }
  m = /^Network device '([^']+)' link is (up|down)$/.exec(text);
  if (m) {
    const [, dev, state] = m;
    const role = ctx.ports?.[dev!];
    if (!role) return undefined;
    const up = state === 'up';
    return {
      category: role === 'wan' ? 'internet' : 'system',
      severity: !up && role === 'wan' ? 'warning' : 'info',
      kind: up ? 'port-up' : 'port-down',
      parts: [`${role === 'wan' ? 'WAN port' : `Port ${dev}`} ${up ? 'connected' : 'disconnected'}`],
    };
  }
  return undefined;
};

/** "1.2.3.4:5555", "[fe80::1]:22" -> address. */
const stripPort = (s: string) => s.replace(/^\[(.*)\]:\d+$/, '$1').replace(/^([^:]+):\d+$/, '$1');

const dropbear: Rule = (text, r) => {
  // "..., extra auth required" is half of a two-factor login; the second half logs again.
  let m = /^(?:(?:Password|Pubkey) auth|Auth) succeeded (with blank password )?for '([^']+)'.* from (\S+)$/.exec(text);
  if (m) {
    const ip = stripPort(m[3]!);
    const user = m[2] === 'root' ? '' : `, ${m[2]}`;
    const blank = !!m[1];
    return {
      category: 'admin',
      severity: blank ? 'warning' : 'info',
      kind: 'admin-login',
      parts: ['Admin login from ', ...r.host(ip), ` (SSH${user}${blank ? ', no password set' : ''})`],
      ip,
      important: true,
    };
  }
  m = /^(?:Bad (?:password|PAM password) attempt for '([^']+)'|Login attempt (?:for nonexistent user|with wrong user \S+)) from (\S+)$/.exec(text);
  if (m) {
    const ip = stripPort(m[2]!);
    return {
      category: 'admin',
      severity: 'warning',
      kind: 'admin-login-failed',
      parts: ['Failed admin login from ', ...r.host(ip), m[1] ? ` (SSH, ${m[1]})` : ' (SSH, unknown user)'],
      ip,
      important: true,
    };
  }
  return undefined;
};

// LuCI's dispatcher logs its logins under the "dispatcher.uc" (ucode) tag.
const luci: Rule = (text, r) => {
  const m = /^luci: (accepted|failed) login on \S+ for (\S+) from (\S+)$/.exec(text);
  if (!m) return undefined;
  const ok = m[1] === 'accepted';
  const ip = m[3]!;
  const user = m[2] === 'root' ? '' : `, ${m[2]}`;
  return {
    category: 'admin',
    severity: ok ? 'info' : 'warning',
    kind: ok ? 'admin-login' : 'admin-login-failed',
    parts: [ok ? 'Admin login from ' : 'Failed admin login from ', ...r.host(ip), ` (LuCI${user})`],
    ip,
    important: true,
  };
};

const kernel: Rule = (text) =>
  /^Linux version (\S+)/.test(text)
    ? {
        category: 'system',
        severity: 'info',
        kind: 'router-started',
        parts: [`Router started (Linux ${/^Linux version (\S+)/.exec(text)![1]})`],
        important: true,
      }
    : undefined;

const procd: Rule = (text) => {
  if (text === '- init complete -') {
    return { category: 'system', severity: 'info', kind: 'router-ready', parts: ['Router finished starting up'] };
  }
  if (text === '- reboot -' || text === '- shutdown -') {
    return {
      category: 'system',
      severity: 'warning',
      kind: 'router-restarting',
      parts: [text === '- reboot -' ? 'Router is restarting' : 'Router is shutting down'],
      important: true,
    };
  }
  return undefined;
};

const firewall: Rule = (text) => {
  const m = /^Reloading firewall due to (\S+) of (\S+)/.exec(text);
  if (!m) return undefined;
  const why = m[1] === 'ifup' ? 'came up' : m[1] === 'ifdown' ? 'went down' : 'changed';
  return {
    category: 'system',
    severity: 'info',
    kind: 'firewall-reload',
    parts: [`Firewall reloaded (${networkLabel(m[2]!)} ${why})`],
  };
};

const RULES: Record<string, Rule> = {
  hostapd,
  'dnsmasq-dhcp': dhcp,
  netifd,
  dropbear,
  'dispatcher.uc': luci,
  luci,
  kernel,
  procd,
  firewall,
};

export function eventText(parts: EventPart[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.label)).join('');
}

/** Newest first. Every entry becomes an event; unrecognized ones are `raw`. */
export function parseEvents(entries: LogEntry[], ctx: EventContext = {}): NetEvent[] {
  const r = resolver(ctx);
  const out: NetEvent[] = [];
  for (const e of entries) {
    const { process, text } = splitLine(e);
    const d = RULES[process]?.(text, r, ctx);
    const base = { id: e.id, time: e.time, process, level: syslogLevel(e.priority), line: e.msg };
    if (d) {
      out.push({ ...base, ...d, important: d.important ?? false, raw: false, text: eventText(d.parts) });
    } else {
      const shown = process && process !== 'kernel' ? `${process}: ${text}` : text;
      out.push({
        ...base,
        category: 'system',
        severity: syslogSeverity(e.priority),
        kind: 'raw',
        parts: [shown],
        text: shown,
        important: false,
        raw: true,
      });
    }
  }
  return out.sort((a, b) => b.id - a.id);
}

/**
 * Shown in the event list (as opposed to the raw syslog view): every
 * recognized event, plus unrecognized lines logged as warnings or errors.
 */
export function isListed(e: NetEvent): boolean {
  return e.severity !== 'debug' && (!e.raw || e.severity === 'error' || e.severity === 'warning');
}

/** Adjacent events with the same text (repeated ssh logins, reload storms) as one row. */
export function collapseRepeats(events: NetEvent[]): { event: NetEvent; count: number }[] {
  const out: { event: NetEvent; count: number }[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last.event.text === e.text && last.event.kind === e.kind) last.count++;
    else out.push({ event: e, count: 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the log incrementally

/**
 * Merge a fresh `log read` into what was read before, by id. logd restarts
 * ids at boot, so a fresh read whose ids are lower than what we have, or that
 * disagrees about a line we already hold, replaces everything.
 */
export function mergeLog(prev: LogEntry[], fresh: LogEntry[], cap = 2000): LogEntry[] {
  if (fresh.length === 0) return prev;
  if (prev.length === 0) return [...fresh].sort((a, b) => a.id - b.id).slice(-cap);
  const byId = new Map(prev.map((e) => [e.id, e]));
  const prevMax = prev[prev.length - 1]!.id;
  const freshMax = Math.max(...fresh.map((e) => e.id));
  const restarted =
    freshMax < prevMax || fresh.some((e) => byId.has(e.id) && (byId.get(e.id)!.time !== e.time || byId.get(e.id)!.msg !== e.msg));
  if (restarted) return [...fresh].sort((a, b) => a.id - b.id).slice(-cap);
  const added = fresh.filter((e) => !byId.has(e.id));
  if (added.length === 0) return prev;
  return [...prev, ...added].sort((a, b) => a.id - b.id).slice(-cap);
}

// ---------------------------------------------------------------------------
// Time. The router may have no NTP (no WAN): its clock can be off by a year.
// Kernel lines tie the clock to uptime, which system.info reports exactly.

const SKEW_IGNORE_MS = 120_000;

/**
 * Milliseconds to add to a log `time` to get this browser's clock. `info` is
 * system.info as sampled at `sampledAt` (browser ms).
 */
export function clockSkew(
  entries: LogEntry[],
  info: { uptime: number; localtime: number } | undefined,
  sampledAt: number,
): number {
  if (!info || !sampledAt) return 0;
  let skew: number | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.source !== 0) continue;
    const { uptime } = splitLine(e);
    if (uptime === undefined) continue;
    // Boot time by the router's clock, then "now" by the router's clock.
    const routerNow = e.time - uptime * 1000 + info.uptime * 1000;
    skew = sampledAt - routerNow;
    break;
  }
  if (skew === undefined) {
    // localtime includes the router's time zone offset, so only a gap larger
    // than any zone offset says the clock itself is wrong.
    skew = sampledAt - info.localtime * 1000;
    if (Math.abs(skew) < 15 * 3600_000) return 0;
  }
  return Math.abs(skew) < SKEW_IGNORE_MS ? 0 : skew;
}

export function relativeTime(t: number, now: number): string {
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dayLabel(t: number, now: number): string {
  const d = new Date(t);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

// ---------------------------------------------------------------------------
// Notifications

/** The last event the user has seen. `time` identifies the line across reboots. */
export interface SeenMarker {
  id: number;
  time: number;
}

/** MAC -> id of the event that first showed it; 0 for MACs known before tracking began. */
export type KnownMacs = Record<string, number>;

const JOINS: EventKind[] = ['client-connected', 'dhcp-lease'];

/**
 * Record MACs from join events. The first call (no map yet) takes everything
 * in the log as already known, so only later arrivals count as new.
 * Returns `known` itself when nothing changed.
 */
export function trackMacs(events: NetEvent[], known: KnownMacs | null): KnownMacs {
  const joins = [...events].filter((e) => e.mac && JOINS.includes(e.kind)).sort((a, b) => a.id - b.id);
  if (!known) return Object.fromEntries(joins.map((e) => [e.mac!, 0]));
  let out = known;
  for (const e of joins) {
    if (e.mac! in out) continue;
    if (out === known) out = { ...known };
    out[e.mac!] = e.id;
  }
  return out;
}

/** The event is the first time this MAC appeared since tracking began. */
export function isNewClient(e: NetEvent, known: KnownMacs | null): boolean {
  return !!e.mac && JOINS.includes(e.kind) && !!known && known[e.mac] === e.id;
}

/** Events worth a notification, newest first. */
export function notableEvents(events: NetEvent[], known: KnownMacs | null): NetEvent[] {
  return events.filter((e) => e.important || isNewClient(e, known));
}

/**
 * Notable events after `seen`. If the log restarted since (the marker's id
 * is past the end, or now names a different line), everything is new.
 */
export function unreadEvents(notable: NetEvent[], all: NetEvent[], seen: SeenMarker | null): NetEvent[] {
  if (!seen) return [];
  const maxId = all.reduce((m, e) => Math.max(m, e.id), -1);
  const same = all.find((e) => e.id === seen.id);
  if (maxId < seen.id || (same && same.time !== seen.time)) return notable;
  return notable.filter((e) => e.id > seen.id);
}

export function latestMarker(all: NetEvent[]): SeenMarker | null {
  const e = all.reduce<NetEvent | undefined>((m, x) => (!m || x.id > m.id ? x : m), undefined);
  return e ? { id: e.id, time: e.time } : null;
}
