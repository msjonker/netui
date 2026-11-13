import type { UciConfig, UciSection } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { isIPv4 } from '../lib/ip';

// dnsmasq settings (the first `dnsmasq` section), local DNS records (`domain`
// and `cname` sections) and the per-network DHCP options for DNS (6) and
// domain (15). Everything here reads and writes the dhcp package.

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/** A DNS name: dot-separated labels of letters, digits and hyphens. */
export function isHostname(v: string): boolean {
  if (!v || v.length > 253) return false;
  return v.replace(/\.$/, '').split('.').every((l) => HOST_LABEL.test(l));
}

/** Loose IPv6 check: hex groups and colons, at most one "::". */
export function isIPv6(v: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(v) || !v.includes(':')) return false;
  const dbl = v.split('::').length - 1;
  if (dbl > 1) return false;
  const groups = v.split(':').filter(Boolean);
  return groups.every((g) => g.length <= 4) && (dbl ? groups.length < 8 : groups.length === 8);
}

export const isIP = (v: string) => isIPv4(v) || isIPv6(v);

// ---------------------------------------------------------------------------
// DHCP options 6 (DNS servers) and 15 (domain name)
//
// A pool's `dhcp_option` list may hold entries other features own (content
// filtering, NTP, tagged options). Only the entry for the one option being
// edited is ever replaced; every other entry keeps its value and position.

const OPTION_NAMES: Record<number, string> = { 6: 'dns-server', 15: 'domain-name' };

function optionCode(entry: string): number | null {
  const m = /^(?:(\d+)|option:([a-z0-9-]+)),/.exec(entry.trim());
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  const hit = Object.entries(OPTION_NAMES).find(([, n]) => n === m[2]);
  return hit ? Number(hit[0]) : null;
}

/** The untagged entries for `code`, as written in UCI. */
export function findDhcpOption(options: string[], code: number): string[] {
  return options.filter((o) => optionCode(o) === code);
}

/**
 * Replace the untagged entries for `code` with `code,values...`, or drop them
 * when `values` is empty. Other entries are preserved in order; the new entry
 * takes the place of the first one it replaces.
 */
export function setDhcpOption(options: string[], code: number, values: string[]): string[] {
  const entry = values.length ? `${code},${values.join(',')}` : null;
  const out: string[] = [];
  let placed = false;
  for (const o of options) {
    if (optionCode(o) !== code) out.push(o);
    else if (!placed && entry) {
      out.push(entry);
      placed = true;
    }
  }
  if (entry && !placed) out.push(entry);
  return out;
}

export interface DhcpDns {
  /** "auto": clients use the router. "manual": up to two plain IPv4 servers. "custom": an entry netui did not write. */
  mode: 'auto' | 'manual' | 'custom';
  servers: string[];
  /** The raw entries, shown as-is in custom mode. */
  raw: string[];
}

/** DNS servers a pool hands out, from its option 6. */
export function readDhcpDns(options: string[]): DhcpDns {
  const raw = findDhcpOption(options, 6);
  if (raw.length === 0) return { mode: 'auto', servers: [], raw };
  const m = raw.length === 1 ? /^6,(.+)$/.exec(raw[0]!) : null;
  const servers = m ? m[1]!.split(',') : [];
  if (m && servers.length <= 2 && servers.every(isIPv4)) return { mode: 'manual', servers, raw };
  return { mode: 'custom', servers: [], raw };
}

/** The domain a pool hands out via option 15, if any. */
export function readDhcpDomain(options: string[]): string {
  const e = findDhcpOption(options, 15)[0];
  return e ? e.slice(e.indexOf(',') + 1) : '';
}

// ---------------------------------------------------------------------------
// dnsmasq settings

export interface DnsSettings {
  section: string;
  /** Plain upstream servers (no "/domain/" forwarding entries). Empty = the ISP's. */
  servers: string[];
  domain: string;
  rebindProtection: boolean;
  /** Domains allowed to resolve to private addresses. */
  rebindAllowed: string[];
}

export function dnsmasqSection(dhcp: UciConfig): UciSection | undefined {
  return sectionsOfType(dhcp, 'dnsmasq')[0];
}

const isForwarding = (s: string) => s.startsWith('/');

export function normalizeDnsSettings(dhcp: UciConfig): DnsSettings | undefined {
  const s = dnsmasqSection(dhcp);
  if (!s) return undefined;
  return {
    section: s['.name'],
    servers: list(s.server).filter((x) => !isForwarding(x)),
    domain: str(s.domain) ?? '',
    rebindProtection: bool(s.rebind_protection, false),
    rebindAllowed: list(s.rebind_domain),
  };
}

/** Upstream server: an IP with an optional #port. */
function isUpstream(v: string): boolean {
  const [ip, port, ...rest] = v.split('#');
  if (rest.length || !ip || !isIP(ip)) return false;
  return port === undefined || (/^\d{1,5}$/.test(port) && Number(port) <= 65535);
}

export function validateDnsSettings(d: DnsSettings): Partial<Record<keyof DnsSettings, string>> {
  const e: Partial<Record<keyof DnsSettings, string>> = {};
  const bad = d.servers.find((s) => !isUpstream(s));
  if (bad !== undefined) e.servers = `"${bad}" is not an IP address.`;
  if (d.domain && !isHostname(d.domain)) e.domain = 'Use letters, digits, hyphens and dots, e.g. lan or home.arpa.';
  const badDomain = d.rebindAllowed.find((x) => !isHostname(x));
  if (badDomain !== undefined) e.rebindAllowed = `"${badDomain}" is not a domain name.`;
  return e;
}

/**
 * Ops for the dnsmasq section. Manual servers also set `noresolv` so the
 * ISP's servers stop being used; clearing them restores the default.
 * Conditional forwarding entries ("/domain/ip") in `server` are kept.
 */
export function dnsSettingsOps(d: DnsSettings, dhcp: UciConfig): UciOp[] {
  const s = dhcp[d.section];
  const forwarding = list(s?.server).filter(isForwarding);
  const prevDomain = str(s?.domain) ?? '';
  const local = str(s?.local);
  const plain = list(s?.server).filter((x) => !isForwarding(x));
  const after: Record<string, string | string[]> = {
    server: [...d.servers, ...forwarding],
    domain: d.domain,
    rebind_protection: d.rebindProtection ? '1' : '0',
    rebind_domain: d.rebindAllowed,
  };
  // Only touch noresolv when the servers change, so editing the domain does
  // not stop a hand-made "ISP plus extra servers" setup from using the ISP.
  if (plain.join(' ') !== d.servers.join(' ')) after.noresolv = d.servers.length ? '1' : '';
  // `local` normally mirrors the domain ("/lan/"); follow it unless customised.
  if (d.domain !== prevDomain && (!local || local === `/${prevDomain}/`)) after.local = d.domain ? `/${d.domain}/` : '';
  return diffSection('dhcp', d.section, s, after);
}

// ---------------------------------------------------------------------------
// Local DNS records

export type DnsRecord =
  | { kind: 'A'; section?: string; name: string; value: string }
  | { kind: 'CNAME'; section?: string; name: string; value: string };

export function normalizeDnsRecords(dhcp: UciConfig): DnsRecord[] {
  const a = sectionsOfType(dhcp, 'domain').map(
    (s): DnsRecord => ({ kind: 'A', section: s['.name'], name: str(s.name) ?? '', value: str(s.ip) ?? '' }),
  );
  const c = sectionsOfType(dhcp, 'cname').map(
    (s): DnsRecord => ({ kind: 'CNAME', section: s['.name'], name: str(s.cname) ?? '', value: str(s.target) ?? '' }),
  );
  return [...a, ...c];
}

export function validateDnsRecord(r: DnsRecord, all: DnsRecord[]): Partial<Record<'name' | 'value', string>> {
  const e: Partial<Record<'name' | 'value', string>> = {};
  if (!isHostname(r.name)) e.name = 'Enter a host name, e.g. nas or nas.lan.';
  else if (all.some((o) => o.section !== r.section && o.name.toLowerCase() === r.name.toLowerCase() && (o.kind === 'CNAME' || r.kind === 'CNAME'))) {
    e.name = `${r.name} already has a record; an alias cannot share its name.`;
  }
  if (r.kind === 'A' && !isIP(r.value)) e.value = 'Enter an IPv4 or IPv6 address.';
  if (r.kind === 'CNAME') {
    if (!isHostname(r.value)) e.value = 'Enter the host name this alias points to.';
    else if (r.value.toLowerCase() === r.name.toLowerCase()) e.value = 'An alias cannot point to itself.';
  }
  return e;
}

export function dnsRecordOps(r: DnsRecord, prev: DnsRecord | undefined, dhcp: UciConfig): UciOp[] {
  const values: Record<string, string> = r.kind === 'A' ? { name: r.name, ip: r.value } : { cname: r.name, target: r.value };
  const type = r.kind === 'A' ? 'domain' : 'cname';
  if (prev?.section && prev.kind === r.kind) return diffSection('dhcp', prev.section, dhcp[prev.section], values);
  const ops: UciOp[] = prev?.section ? [{ op: 'delete', config: 'dhcp', section: prev.section }] : [];
  return [...ops, { op: 'add', config: 'dhcp', type, values }];
}

/** Split a typed list ("a, b c") into entries. */
export const splitList = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);
