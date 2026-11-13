// Traffic rules, simply: block or allow a network, some devices or some
// addresses from reaching the internet, a network or an address, optionally
// on a schedule. Each is one fw4 `rule` section. netui owns rules whose name
// starts with RULE_PREFIX; anything else is listed read-only.
//
// fw4 (checked on the DL-WRX36, fw4.uc parse_rule): weekdays is a string of
// day names or prefixes ("Mon Tue"), start_time/stop_time are H[H]:MM[:SS] in
// router local time, an unset proto means tcp+udp, so "any" is written "all".
// A stop time before the start time is a range across midnight (nft accepts
// `meta hour "22:00"-"06:00"`).

import type { UciConfig, UciSection, UciValue } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { isIPv4, parseCidr } from '../lib/ip';
import { isMac, normalizeMac } from '../lib/mac';
import { isPortSpec, normalizeBlockRules } from './firewall';
import type { Subnet } from './network';
import { internetZone, zoneList, zoneOfNetwork } from './policy';

export const RULE_PREFIX = 'netui: rule ';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Day = (typeof DAYS)[number];

export type RuleProto = 'all' | 'tcp udp' | 'tcp' | 'udp' | 'icmp';

export interface TrafficRuleDraft {
  name: string;
  enabled: boolean;
  action: 'block' | 'allow';
  source: 'network' | 'devices' | 'ip';
  srcNetwork: string;
  /** Lowercase MACs. */
  macs: string[];
  /** Addresses or subnets, space separated. */
  srcIp: string;
  dest: 'internet' | 'network' | 'ip';
  destNetwork: string;
  destIp: string;
  proto: RuleProto;
  /** Ports and ranges, space separated; tcp/udp only. */
  port: string;
  schedule: 'always' | 'custom';
  /** Empty means every day. */
  days: Day[];
  /** "HH:MM", or empty for start/end of day. */
  start: string;
  stop: string;
}

export interface TrafficRule {
  section: string;
  /** Without RULE_PREFIX. */
  name: string;
  managed: boolean;
  enabled: boolean;
  target: string;
  /** Set when netui wrote it and it still reads back as a draft. */
  draft?: TrafficRuleDraft;
  raw: UciSection;
}

export interface RuleCtx {
  fw: UciConfig;
  subnets: Subnet[];
}

export function newTrafficRule(network = 'lan'): TrafficRuleDraft {
  return {
    name: '',
    enabled: true,
    action: 'block',
    source: 'network',
    srcNetwork: network,
    macs: [],
    srcIp: '',
    dest: 'internet',
    destNetwork: '',
    destIp: '',
    proto: 'all',
    port: '',
    schedule: 'always',
    days: [],
    start: '',
    stop: '',
  };
}

const cidr = (s: Subnet) => `${s.address}/${s.prefix}`;

/** Zone and, when the zone holds other networks too, the subnet narrowing it to this one. */
function networkMatch(network: string, ctx: RuleCtx): { zone?: string; ip: string } {
  const z = zoneOfNetwork(ctx.fw, network);
  const s = ctx.subnets.find((x) => x.network === network);
  return { zone: z?.name, ip: z && z.networks.length > 1 && s ? cidr(s) : '' };
}

const splitList = (v: string) => v.split(/[\s,]+/).filter(Boolean);
const hasPorts = (p: RuleProto) => p === 'tcp udp' || p === 'tcp' || p === 'udp';

export function ruleValues(d: TrafficRuleDraft, ctx: RuleCtx): Record<string, UciValue> {
  const src = d.source === 'network' ? networkMatch(d.srcNetwork, ctx) : { zone: '*', ip: d.source === 'ip' ? d.srcIp : '' };
  const dest =
    d.dest === 'internet'
      ? { zone: internetZone(ctx.fw), ip: '' }
      : d.dest === 'network'
        ? networkMatch(d.destNetwork, ctx)
        : { zone: '*', ip: d.destIp };
  const timed = d.schedule === 'custom';
  return {
    name: `${RULE_PREFIX}${d.name.trim()}`.slice(0, 64),
    src: src.zone ?? '',
    src_ip: splitList(src.ip),
    src_mac: d.source === 'devices' ? d.macs.map((m) => m.toUpperCase()) : [],
    dest: dest.zone ?? '',
    dest_ip: splitList(dest.ip),
    proto: d.proto,
    dest_port: hasPorts(d.proto) ? splitList(d.port).join(' ') : '',
    target: d.action === 'block' ? 'REJECT' : 'ACCEPT',
    enabled: d.enabled ? '' : '0',
    weekdays: timed && d.days.length > 0 && d.days.length < 7 ? DAYS.filter((x) => d.days.includes(x)).join(' ') : '',
    start_time: timed ? d.start : '',
    stop_time: timed ? d.stop : '',
  };
}

export function trafficRuleOps(d: TrafficRuleDraft, section: string | undefined, ctx: RuleCtx): UciOp[] {
  const values = ruleValues(d, ctx);
  if (section) return diffSection('firewall', section, ctx.fw[section], values);
  const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v.length > 0));
  return [{ op: 'add', config: 'firewall', type: 'rule', values: set }];
}

// ---------------------------------------------------------------------------
// Reading back

function readDays(v: unknown): Day[] | null {
  const out: Day[] = [];
  for (const w of list(v)) {
    const d = DAYS.find((x) => w.length >= 2 && x.toLowerCase().startsWith(w.slice(0, 3).toLowerCase()));
    if (!d) return null;
    out.push(d);
  }
  return out;
}

/** Network whose zone (and subnet, if given) a rule's zone/ip pair names. */
function networkFor(zone: string | undefined, ips: string[], ctx: RuleCtx): string | undefined {
  const z = zoneList(ctx.fw).find((x) => x.name === zone);
  if (!z) return undefined;
  if (ips.length === 0) return z.networks.length === 1 ? z.networks[0] : undefined;
  if (ips.length > 1) return undefined;
  return ctx.subnets.find((s) => z.networks.includes(s.network) && cidr(s) === ips[0])?.network;
}

/** Reverse of ruleValues, or undefined if the section has anything it cannot express. */
export function readDraft(s: UciSection, ctx: RuleCtx): TrafficRuleDraft | undefined {
  const known = new Set(['name', 'src', 'src_ip', 'src_mac', 'dest', 'dest_ip', 'proto', 'dest_port', 'target', 'enabled', 'weekdays', 'start_time', 'stop_time']);
  if (Object.keys(s).some((k) => !k.startsWith('.') && !known.has(k))) return undefined;
  const target = (str(s.target) ?? '').toUpperCase();
  if (target !== 'REJECT' && target !== 'DROP' && target !== 'ACCEPT') return undefined;
  const d = newTrafficRule();
  d.name = (str(s.name) ?? '').slice(RULE_PREFIX.length);
  d.enabled = bool(s.enabled, true);
  d.action = target === 'ACCEPT' ? 'allow' : 'block';

  const srcZone = str(s.src);
  const srcIps = list(s.src_ip);
  const macs = list(s.src_mac);
  if (macs.length) {
    if (srcIps.length || srcZone !== '*') return undefined;
    d.source = 'devices';
    d.macs = macs.map(normalizeMac).filter((m): m is string => m !== null);
  } else if (srcZone === '*' && srcIps.length) {
    d.source = 'ip';
    d.srcIp = srcIps.join(' ');
  } else {
    const n = networkFor(srcZone, srcIps, ctx);
    if (!n) return undefined;
    d.srcNetwork = n;
  }

  const destZone = str(s.dest);
  const destIps = list(s.dest_ip);
  if (destZone === internetZone(ctx.fw) && destIps.length === 0) d.dest = 'internet';
  else if (destZone === '*' && destIps.length) {
    d.dest = 'ip';
    d.destIp = destIps.join(' ');
  } else {
    const n = networkFor(destZone, destIps, ctx);
    if (!n) return undefined;
    d.dest = 'network';
    d.destNetwork = n;
  }

  const proto = list(s.proto).join(' ') || 'tcp udp';
  const p = (['all', 'tcp udp', 'tcp', 'udp', 'icmp'] as const).find((x) => x === proto || (x === 'tcp udp' && proto === 'udp tcp'));
  if (!p) return undefined;
  d.proto = p;
  d.port = list(s.dest_port).join(' ');

  const days = readDays(s.weekdays);
  if (!days) return undefined;
  const start = str(s.start_time) ?? '';
  const stop = str(s.stop_time) ?? '';
  if (days.length || start || stop) {
    d.schedule = 'custom';
    d.days = days;
    d.start = start.replace(/^(\d{1,2}:\d{2}):00$/, '$1');
    d.stop = stop.replace(/^(\d{1,2}:\d{2}):00$/, '$1');
  }
  return d;
}

/** Sections shown elsewhere: client blocks and content filters. */
function shownElsewhere(fw: UciConfig): Set<string> {
  const out = new Set(normalizeBlockRules(fw).map((b) => b.section));
  for (const s of sectionsOfType(fw, 'rule')) if ((str(s.name) ?? '').startsWith('netui: filter ')) out.add(s['.name']);
  return out;
}

/**
 * Forward rules between zones: netui's own, plus any other rule with a
 * destination. Input rules (no dest) are router access, listed separately.
 */
export function normalizeTrafficRules(ctx: RuleCtx): TrafficRule[] {
  const skip = shownElsewhere(ctx.fw);
  return sectionsOfType(ctx.fw, 'rule')
    .filter((s) => !skip.has(s['.name']) && (str(s.name)?.startsWith(RULE_PREFIX) || !!s.dest))
    .map((s) => {
      const full = str(s.name) ?? '';
      const managed = full.startsWith(RULE_PREFIX);
      return {
        section: s['.name'],
        name: managed ? full.slice(RULE_PREFIX.length) : full || s['.name'],
        managed,
        enabled: bool(s.enabled, true),
        target: (str(s.target) ?? 'DROP').toUpperCase(),
        draft: managed ? readDraft(s, ctx) : undefined,
        raw: s,
      };
    });
}

// ---------------------------------------------------------------------------
// Validation

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

function validAddress(a: string): boolean {
  return isIPv4(a) || parseCidr(a) !== null;
}

export function validateTrafficRule(d: TrafficRuleDraft, ctx: RuleCtx): Partial<Record<keyof TrafficRuleDraft, string>> {
  const e: Partial<Record<keyof TrafficRuleDraft, string>> = {};
  if (!d.name.trim()) e.name = 'Give the rule a name.';
  else if (d.name.length > 50) e.name = 'Keep the name under 50 characters.';
  if (d.source === 'network') {
    if (!ctx.subnets.some((s) => s.network === d.srcNetwork)) e.srcNetwork = 'Choose a network.';
    else if (!zoneOfNetwork(ctx.fw, d.srcNetwork)) e.srcNetwork = 'This network has no firewall zone.';
  } else if (d.source === 'devices') {
    if (d.macs.length === 0) e.macs = 'Choose at least one device.';
    else if (!d.macs.every(isMac)) e.macs = 'Not a MAC address.';
  } else if (splitList(d.srcIp).length === 0 || !splitList(d.srcIp).every(validAddress)) {
    e.srcIp = 'IPv4 addresses or subnets, e.g. 192.168.1.20 or 192.168.1.0/28.';
  }
  if (d.dest === 'network') {
    if (!ctx.subnets.some((s) => s.network === d.destNetwork)) e.destNetwork = 'Choose a network.';
    else if (!zoneOfNetwork(ctx.fw, d.destNetwork)) e.destNetwork = 'This network has no firewall zone.';
    else if (d.source === 'network' && d.destNetwork === d.srcNetwork) e.destNetwork = 'Pick a different network than the source.';
  } else if (d.dest === 'ip' && (splitList(d.destIp).length === 0 || !splitList(d.destIp).every(validAddress))) {
    e.destIp = 'IPv4 addresses or subnets, e.g. 203.0.113.5 or 10.0.0.0/8.';
  }
  if (hasPorts(d.proto) && d.port && !splitList(d.port).every(isPortSpec)) {
    e.port = 'Ports 1-65535 or ranges like 8000-8100, separated by spaces.';
  }
  if (d.schedule === 'custom') {
    if (d.start && !TIME.test(d.start)) e.start = 'Use HH:MM.';
    if (d.stop && !TIME.test(d.stop)) e.stop = 'Use HH:MM.';
    if (!e.start && !e.stop && d.start && d.start === d.stop) e.stop = 'Must differ from the start time.';
    if (!d.days.length && !d.start && !d.stop) e.days = 'Pick days or a time window, or use Always.';
  }
  return e;
}

/** "Mon-Fri 21:00-07:00", "Every day until 06:00", "Always". */
export function scheduleLabel(d: Pick<TrafficRuleDraft, 'schedule' | 'days' | 'start' | 'stop'>): string {
  if (d.schedule === 'always') return 'Always';
  const idx = DAYS.filter((x) => d.days.includes(x)).map((x) => DAYS.indexOf(x));
  let days = 'Every day';
  if (idx.length && idx.length < 7) {
    // Runs of three or more collapse: Mon-Thu, Sun.
    const runs: number[][] = [];
    for (const i of idx) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    }
    days = runs
      .flatMap((r) => (r.length > 2 ? [`${DAYS[r[0]!]}-${DAYS[r[r.length - 1]!]}`] : r.map((i) => DAYS[i]!)))
      .join(', ');
  }
  if (d.start && d.stop) return `${days} ${d.start}-${d.stop}`;
  if (d.start) return `${days} from ${d.start}`;
  if (d.stop) return `${days} until ${d.stop}`;
  return days;
}
