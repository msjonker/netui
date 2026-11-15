// DNS over HTTPS with https-dns-proxy (optional package). Shapes recorded on
// the DL-WRX36: test/fixtures/ubus/dl-wrx36/plain/uci.get.https-dns-proxy.json
// and uci.get.dhcp.doh-active.json.
//
// The package starts on install. While running it rewrites dnsmasq's section
// in `dhcp` itself (server = 127.0.0.1#<port> per resolver, noresolv, and a
// `doh_server` list naming its own entries) and undoes that when stopped, so
// `doh_server` tells whether it is active. It has no on/off option: switching
// is enable + start or stop + disable of its init script (api/services.ts),
// run after a confirmed apply.
//
// Two traps, both seen on the DL-WRX36 with 2026.05.06:
// - Its backup of dnsmasq's servers breaks when it starts while already
//   running (procd reloads it on every change to its config): an empty list is
//   backed up as '', which reads as "no backup", so its own entries get backed
//   up and later "restored". Every change netui makes therefore also puts
//   dnsmasq's section back as before the proxy, so it backs up a clean state.
// - That procd reload races with a stop run right after the apply and starts
//   it again. Switching off therefore changes nothing in its config.

import type { UciConfig, UciValue } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { dnsmasqSection } from './dns';

export interface DohProvider {
  id: string;
  label: string;
  url: string;
  /** Plain DNS used once, to look up the provider's own name. */
  bootstrap: string;
}

export const DOH_PROVIDERS: DohProvider[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    url: 'https://cloudflare-dns.com/dns-query',
    bootstrap: '1.1.1.1,1.0.0.1,2606:4700:4700::1111,2606:4700:4700::1001',
  },
  {
    id: 'cloudflare-family',
    label: 'Cloudflare for Families (blocks malware and adult sites)',
    url: 'https://family.cloudflare-dns.com/dns-query',
    bootstrap: '1.1.1.3,1.0.0.3,2606:4700:4700::1113,2606:4700:4700::1003',
  },
  {
    id: 'quad9',
    label: 'Quad9 (blocks malware)',
    url: 'https://dns.quad9.net/dns-query',
    bootstrap: '9.9.9.9,149.112.112.112,2620:fe::fe,2620:fe::9',
  },
  {
    id: 'google',
    label: 'Google',
    url: 'https://dns.google/dns-query',
    bootstrap: '8.8.8.8,8.8.4.4,2001:4860:4860::8888,2001:4860:4860::8844',
  },
  {
    id: 'mullvad',
    label: 'Mullvad',
    url: 'https://dns.mullvad.net/dns-query',
    bootstrap: '194.242.2.2,2a07:e340::2',
  },
];

/** Bootstrap for a custom URL: two well-known public resolvers. */
const CUSTOM_BOOTSTRAP = '1.1.1.1,8.8.8.8';
const PORT = '5053';

export interface Doh {
  /** Running: dnsmasq points at the proxy. */
  active: boolean;
  /** Resolver URLs, one per instance. */
  urls: string[];
}

export function normalizeDoh(cfg: UciConfig, dhcp: UciConfig | undefined): Doh {
  return {
    active: list(dhcp && dnsmasqSection(dhcp)?.doh_server).length > 0,
    urls: sectionsOfType(cfg, 'https-dns-proxy')
      .map((s) => str(s.resolver_url))
      .filter((u): u is string => !!u),
  };
}

export interface DohDraft {
  enabled: boolean;
  /** A DOH_PROVIDERS id, or 'custom'. */
  provider: string;
  customUrl: string;
}

export function dohDraft(d: Doh): DohDraft {
  const known = DOH_PROVIDERS.find((p) => p.url === d.urls[0]);
  return {
    enabled: d.active,
    provider: known?.id ?? (d.urls[0] ? 'custom' : DOH_PROVIDERS[0]!.id),
    customUrl: known ? '' : (d.urls[0] ?? ''),
  };
}

export function validateDoh(d: DohDraft): Partial<Record<keyof DohDraft, string>> {
  if (d.provider !== 'custom') return {};
  let url: URL | undefined;
  try {
    url = new URL(d.customUrl);
  } catch {
    url = undefined;
  }
  return url?.protocol === 'https:'
    ? {}
    : { customUrl: 'A DNS over HTTPS address, like https://dns.example/dns-query.' };
}

const urlOf = (d: DohDraft) => DOH_PROVIDERS.find((p) => p.id === d.provider)?.url ?? d.customUrl.trim();

/** Domains the proxy answers itself so browsers keep using the router's DNS (force_dns). */
const CANARIES = ['/mask.icloud.com/', '/mask-h2.icloud.com/', '/use-application-dns.net/'];

/**
 * Ops that return dnsmasq's section to its state before the proxy: the
 * user's servers (current and backed up) without the proxy's own entries,
 * noresolv as backed up, and none of the proxy's bookkeeping options.
 */
export function dohDhcpCleanOps(dhcp: UciConfig, cfg: UciConfig): UciOp[] {
  const s = dnsmasqSection(dhcp);
  if (!s) return [];
  const doh = list(s.doh_server);
  const ports = new Set([
    PORT,
    '5054',
    ...sectionsOfType(cfg, 'https-dns-proxy').map((x) => str(x.listen_port)),
    ...doh.map((v) => v.split('#')[1]),
  ]);
  const own = (v: string) => {
    const m = /^(?:127\.0\.0\.1|::1)#(\d+)$/.exec(v);
    return doh.includes(v) || CANARIES.includes(v) || (!!m && ports.has(m[1]));
  };
  const servers = [...new Set([...list(s.server), ...list(s.doh_backup_server)])].filter((v) => v && !own(v));
  const nr = str(s.doh_backup_noresolv);
  return diffSection('dhcp', s['.name'], s, {
    server: servers,
    noresolv: nr === undefined ? str(s.noresolv) : nr === '-1' ? '' : nr,
    doh_server: [],
    doh_backup_server: [],
    doh_backup_noresolv: '',
  });
}

/**
 * Config ops for a draft. Switching off only cleans up dnsmasq's section (the
 * stop follows the apply). Switching on or choosing a provider writes the
 * instances (a new provider replaces them with one; the package ships two)
 * and cleans up first. Empty when only a start or stop is needed.
 */
export function dohOps(d: DohDraft, before: Doh, cfg: UciConfig, dhcp: UciConfig): UciOp[] {
  if (!d.enabled) return before.active ? dohDhcpCleanOps(dhcp, cfg) : [];
  const ops: UciOp[] = [];
  if (urlOf(d) !== urlOf(dohDraft(before))) {
    for (const s of sectionsOfType(cfg, 'https-dns-proxy')) ops.push({ op: 'delete', config: 'https-dns-proxy', section: s['.name'] });
    const p = DOH_PROVIDERS.find((x) => x.id === d.provider);
    const values: Record<string, UciValue> = { resolver_url: urlOf(d), bootstrap_dns: p?.bootstrap ?? CUSTOM_BOOTSTRAP, listen_port: PORT };
    ops.push({ op: 'add', config: 'https-dns-proxy', type: 'https-dns-proxy', values });
  }
  return ops.length || !before.active ? [...ops, ...dohDhcpCleanOps(dhcp, cfg)] : [];
}

/** Whether the service must be started (true) or stopped (false) after the apply. */
export function dohSwitch(d: DohDraft, before: Doh): boolean | undefined {
  return d.enabled === before.active ? undefined : d.enabled;
}
