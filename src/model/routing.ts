import type { InterfaceDump, UciConfig } from '../api/types';
import { bool, diffSection, sectionsOfType, str, type UciOp } from '../api/uci';
import { inSubnet, isIPv4, netmaskToPrefix, networkAddress, parseCidr, prefixToNetmask } from '../lib/ip';

// Static routes (network `route` sections) and the routes netifd reports as
// active per interface.

export interface StaticRoute {
  section?: string;
  name: string;
  enabled: boolean;
  /** "10.0.0.0/24". */
  target: string;
  /** Empty for an interface (on-link) route. */
  gateway: string;
  interface: string;
  /** Empty for the default metric. */
  metric: string;
}

function readTarget(s: Record<string, unknown>): string {
  const t = str(s.target) ?? '';
  if (t.includes('/')) return t;
  const mask = str(s.netmask);
  const prefix = mask ? netmaskToPrefix(mask) : 32;
  return t ? `${t}/${prefix ?? 32}` : '';
}

export function normalizeStaticRoutes(network: UciConfig): StaticRoute[] {
  return sectionsOfType(network, 'route').map((s) => ({
    section: s['.name'],
    name: str(s.name) ?? '',
    enabled: !bool(s.disabled, false),
    target: readTarget(s),
    gateway: str(s.gateway) ?? '',
    interface: str(s.interface) ?? '',
    metric: str(s.metric) ?? '',
  }));
}

export function newStaticRoute(iface = 'lan'): StaticRoute {
  return { name: '', enabled: true, target: '', gateway: '', interface: iface, metric: '' };
}

export function validateStaticRoute(
  r: StaticRoute,
  ctx: { interfaces: string[]; routes: StaticRoute[] },
): Partial<Record<keyof StaticRoute, string>> {
  const e: Partial<Record<keyof StaticRoute, string>> = {};
  const c = parseCidr(r.target);
  if (!c || !r.target.includes('/')) e.target = 'Enter a destination network, e.g. 10.20.0.0/16.';
  else if (networkAddress(c.address, c.prefix) !== c.address) {
    e.target = `Host bits are set; did you mean ${networkAddress(c.address, c.prefix)}/${c.prefix}?`;
  } else if (
    ctx.routes.some((o) => o.section !== r.section && o.target === r.target && o.metric === r.metric && o.interface === r.interface)
  ) {
    e.target = 'A route to this network already exists.';
  }
  if (r.gateway && !isIPv4(r.gateway)) e.gateway = 'Enter an IPv4 address, or leave empty for an interface route.';
  if (!r.interface || !ctx.interfaces.includes(r.interface)) e.interface = 'Choose an interface.';
  if (r.metric && (!/^\d+$/.test(r.metric) || Number(r.metric) > 4294967295)) e.metric = 'Enter a whole number.';
  if (r.name && /['"\\]/.test(r.name)) e.name = 'Quotes and backslashes are not allowed.';
  return e;
}

export function staticRouteOps(r: StaticRoute, network: UciConfig): UciOp[] {
  const before = r.section ? network[r.section] : undefined;
  const values: Record<string, string> = {
    name: r.name.trim(),
    interface: r.interface,
    target: r.target,
    gateway: r.gateway,
    metric: r.metric,
    disabled: r.enabled ? '' : '1',
  };
  if (before && str(before.netmask) !== undefined) {
    // Keep the address/netmask form the section was written in.
    const c = parseCidr(r.target)!;
    values.target = c.address;
    values.netmask = prefixToNetmask(c.prefix);
  }
  if (r.section) return diffSection('network', r.section, before, values);
  const add = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  return [{ op: 'add', config: 'network', type: 'route', values: add }];
}

/** Whether `gateway` is directly reachable on one of the interface's live subnets. */
export function gatewayOnLink(gateway: string, iface: string, dump: InterfaceDump | undefined): boolean | undefined {
  const i = dump?.interface.find((x) => x.interface === iface);
  if (!i?.up) return undefined;
  return (i['ipv4-address'] ?? []).some((a) => inSubnet(gateway, a.address, a.mask));
}

// ---------------------------------------------------------------------------
// Active routes

export interface ActiveRoute {
  /** "0.0.0.0/0", "10.0.0.0/24", "::/0". */
  target: string;
  /** Empty for connected networks and on-link routes. */
  via: string;
  interface: string;
  device?: string;
  kind: 'connected' | 'route';
}

/** Connected subnets and netifd routes of every up interface, IPv4 first. */
export function activeRoutes(dump: InterfaceDump): ActiveRoute[] {
  const out: ActiveRoute[] = [];
  for (const i of dump.interface) {
    if (!i.up || i.interface === 'loopback') continue;
    const device = i.l3_device ?? i.device;
    for (const a of [...(i['ipv4-address'] ?? []), ...(i['ipv6-address'] ?? [])]) {
      const v4 = isIPv4(a.address);
      const net = v4 ? networkAddress(a.address, a.mask) : a.address;
      out.push({ target: `${net}/${a.mask}`, via: '', interface: i.interface, device, kind: 'connected' });
    }
    for (const r of i.route ?? []) {
      const onLink = !r.nexthop || r.nexthop === '0.0.0.0' || r.nexthop === '::';
      out.push({ target: `${r.target}/${r.mask}`, via: onLink ? '' : r.nexthop, interface: i.interface, device, kind: 'route' });
    }
  }
  const v6 = (r: ActiveRoute) => (r.target.includes(':') ? 1 : 0);
  return out.sort((a, b) => v6(a) - v6(b));
}
