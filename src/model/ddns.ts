import type { DdnsServiceStatus, UciConfig, UciValue } from '../api/types';
import { bool, diffSection, sectionsOfType, str, type UciOp } from '../api/uci';

// ddns-scripts `service` sections. Providers come from a short curated list
// of service_name values shipped in /usr/share/ddns/default (some need an
// extra ddns-scripts-<provider> package); anything else configured
// elsewhere is shown as-is and left alone.

export const DDNS_PROVIDERS: { value: string; label: string }[] = [
  { value: 'duckdns.org', label: 'Duck DNS' },
  { value: 'dyndns.org', label: 'Dyn (dyndns.org)' },
  { value: 'dynv6.com', label: 'dynv6' },
  { value: 'desec.io', label: 'deSEC' },
  { value: 'afraid.org-keyauth', label: 'FreeDNS (afraid.org)' },
  { value: 'he.net', label: 'Hurricane Electric' },
  { value: 'dynu.com', label: 'Dynu' },
  { value: 'namecheap.com', label: 'Namecheap' },
  { value: 'ydns.io', label: 'YDNS' },
  { value: 'no-ip.com', label: 'No-IP (needs ddns-scripts-noip)' },
  { value: 'cloudflare.com-v4', label: 'Cloudflare (needs ddns-scripts-cloudflare)' },
];

/** A service with a hand-written update_url instead of a service_name. */
export const CUSTOM = '';

export interface DdnsService {
  section: string;
  enabled: boolean;
  /** service_name, or CUSTOM when update_url is used. */
  provider: string;
  updateUrl?: string;
  hostname: string;
  domain: string;
  username: string;
  hasPassword: boolean;
  ipv6: boolean;
  source: string;
  /** The factory example (example.com placeholders) rather than a real service. */
  placeholder: boolean;
}

export function normalizeDdns(cfg: UciConfig): DdnsService[] {
  return sectionsOfType(cfg, 'service').map((s) => {
    const hostname = str(s.lookup_host) ?? '';
    const domain = str(s.domain) ?? '';
    const url = str(s.update_url);
    return {
      section: s['.name'],
      enabled: bool(s.enabled, false),
      provider: str(s.service_name) ?? CUSTOM,
      updateUrl: url,
      hostname,
      domain,
      username: str(s.username) ?? '',
      hasPassword: !!str(s.password),
      ipv6: bool(s.use_ipv6, false),
      source: str(s.ip_source) ?? 'network',
      placeholder:
        /(^|\.)example\.com$/.test(hostname || domain) || !!url?.includes('your.provider.net') || (!url && !str(s.service_name)),
    };
  });
}

export function providerLabel(p: string): string {
  return p === CUSTOM ? 'Custom URL' : (DDNS_PROVIDERS.find((x) => x.value === p)?.label ?? p);
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

/** One-word state for the service list. */
export function ddnsState(s: DdnsService, st: DdnsServiceStatus | undefined): { tone: Tone; label: string } {
  if (s.placeholder) return { tone: 'neutral', label: 'Not configured' };
  if (!s.enabled) return { tone: 'neutral', label: 'Disabled' };
  if (st?.pid) return { tone: 'ok', label: 'Running' };
  return { tone: 'warn', label: st?.next_update === 'Stopped' || !st ? 'Stopped' : (st.next_update ?? 'Stopped') };
}

// ---------------------------------------------------------------------------
// Editing

export interface DdnsDraft {
  enabled: boolean;
  provider: string;
  hostname: string;
  /** What the provider calls the record; empty means the hostname. */
  domain: string;
  username: string;
  /** Empty keeps the stored password. */
  password: string;
  ipv6: boolean;
  /** "network": the WAN's own address; "web": a public "what is my IP" lookup (behind CGNAT). */
  source: string;
}

export function ddnsDraft(s?: DdnsService): DdnsDraft {
  if (!s || s.placeholder) {
    return {
      enabled: true,
      provider: s?.provider || DDNS_PROVIDERS[0]!.value,
      hostname: '',
      domain: '',
      username: '',
      password: '',
      ipv6: s?.ipv6 ?? false,
      source: 'network',
    };
  }
  return {
    enabled: s.enabled,
    provider: s.provider,
    hostname: s.hostname,
    domain: s.domain === s.hostname ? '' : s.domain,
    username: s.username,
    password: '',
    ipv6: s.ipv6,
    source: s.source === 'web' ? 'web' : 'network',
  };
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9_]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function validateDdns(d: DdnsDraft, s?: DdnsService): Partial<Record<keyof DdnsDraft, string>> {
  const e: Partial<Record<keyof DdnsDraft, string>> = {};
  if (!HOST_RE.test(d.hostname.trim())) e.hostname = 'Enter the full hostname, e.g. myhome.duckdns.org.';
  else if (/(^|\.)example\.com$/.test(d.hostname.trim())) e.hostname = 'Replace the example hostname with yours.';
  if (!d.password && !(s?.hasPassword && !s.placeholder)) e.password = 'Enter the password or token from your provider.';
  return e;
}

/** A free section name derived from the hostname, e.g. "home_duckdns_org". */
export function ddnsSectionName(hostname: string, ipv6: boolean, cfg: UciConfig): string {
  const base = (hostname.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ddns') + (ipv6 ? '_v6' : '');
  let name = /^[a-z]/.test(base) ? base : `ddns_${base}`;
  for (let i = 2; cfg[name]; i++) name = `${base}_${i}`;
  return name;
}

/**
 * Ops to add (`s` undefined) or edit a service. `wan`/`wan6` are the network
 * sections whose address is published and whose ifup triggers an update.
 */
export function ddnsOps(d: DdnsDraft, s: DdnsService | undefined, cfg: UciConfig, wan: string, wan6: string | undefined): UciOp[] {
  const hostname = d.hostname.trim();
  const iface = d.ipv6 ? (wan6 ?? wan) : wan;
  const values: Record<string, UciValue | undefined> = {
    enabled: d.enabled ? '1' : '0',
    // A custom update_url is kept as written; picking a provider replaces it.
    ...(d.provider === CUSTOM ? {} : { service_name: d.provider, update_url: '' }),
    lookup_host: hostname,
    domain: d.domain.trim() || hostname,
    username: d.username.trim(),
    password: d.password || (s && !s.placeholder ? str(cfg[s.section]?.password) : ''),
    use_ipv6: d.ipv6 ? '1' : '',
    interface: iface,
    ip_source: d.source,
    ip_network: d.source === 'network' ? iface : '',
  };
  if (s) return diffSection('ddns', s.section, cfg[s.section], values);
  const set = Object.fromEntries(Object.entries(values).filter((e): e is [string, UciValue] => !!e[1]));
  return [{ op: 'add', config: 'ddns', type: 'service', name: ddnsSectionName(hostname, d.ipv6, cfg), values: set }];
}
