import type { DeviceStatusMap, InterfaceDump, InterfaceStatus, SystemBoard, SystemInfo, UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import {
  hostAt,
  hostOffset,
  inSubnet,
  isIPv4,
  netmaskToPrefix,
  networkAddress,
  parseCidr,
  prefixToNetmask,
} from '../lib/ip';
import { isHostname, readDhcpDns, readDhcpDomain, setDhcpOption, type DhcpDns } from './dns';

// ---------------------------------------------------------------------------
// Live interface state

export interface Uplink {
  name: string;
  up: boolean;
  proto: string;
  device?: string;
  address?: string;
  prefix?: number;
  gateway?: string;
  dns: string[];
  uptime?: number;
}

function defaultRoute(i: InterfaceStatus) {
  return i.route?.find((r) => r.target === '0.0.0.0' && r.mask === 0);
}

/**
 * The internet uplink: the interface carrying the IPv4 default route, else
 * the one named "wan". Undefined on a router with neither.
 */
export function findUplink(dump: InterfaceDump): Uplink | undefined {
  const ifaces = dump.interface;
  const i = ifaces.find((x) => x.up && defaultRoute(x)) ?? ifaces.find((x) => x.interface === 'wan');
  if (!i) return undefined;
  const addr = i['ipv4-address']?.[0];
  return {
    name: i.interface,
    up: i.up,
    proto: i.proto,
    device: i.l3_device ?? i.device,
    address: addr?.address,
    prefix: addr?.mask,
    gateway: defaultRoute(i)?.nexthop,
    dns: i['dns-server'] ?? [],
    uptime: i.uptime,
  };
}

/**
 * Online means up with a default route and, when the device is known, a
 * carrier. Static interfaces stay "up" with no cable (netifd force_link), so
 * up + gateway alone would report an unplugged WAN as online.
 */
export function uplinkOnline(uplink: Uplink | undefined, devices?: DeviceStatusMap): boolean {
  if (!uplink?.up || !uplink.gateway) return false;
  const dev = uplink.device ? devices?.[uplink.device] : undefined;
  return dev?.carrier !== false;
}

/** Interfaces in the firewall's wan zone, or just "wan"/"wan6" without a firewall config. */
export function wanNetworks(firewall: UciConfig | undefined): Set<string> {
  const out = new Set<string>();
  for (const z of firewall ? sectionsOfType(firewall, 'zone') : []) {
    if (str(z.name) === 'wan' || bool(z.masq, false)) for (const n of list(z.network)) out.add(n);
  }
  if (out.size === 0) ['wan', 'wan6'].forEach((n) => out.add(n));
  return out;
}

// ---------------------------------------------------------------------------
// Networks (UCI interface + its DHCP pool + live state)

/** How the address was stored, so edits write it back in the same form. */
export type AddressForm = 'cidr-list' | 'cidr' | 'netmask';

export interface DhcpPool {
  section: string;
  enabled: boolean;
  start: number;
  limit: number;
  leasetime: string;
}

export interface Network {
  /** UCI section name, e.g. "lan". */
  id: string;
  proto: string;
  device?: string;
  address?: string;
  prefix?: number;
  addressForm: AddressForm;
  /** Additional addresses beyond the first, preserved on write. */
  extraAddresses: string[];
  dhcp?: DhcpPool;
  up?: boolean;
  uptime?: number;
}

function readAddress(s: Record<string, unknown>): Pick<Network, 'address' | 'prefix' | 'addressForm' | 'extraAddresses'> {
  const raw = s.ipaddr;
  const netmask = str(s.netmask);
  if (Array.isArray(raw)) {
    const [first, ...rest] = list(raw);
    const c = first ? parseCidr(first) : null;
    return { address: c?.address, prefix: c?.prefix, addressForm: 'cidr-list', extraAddresses: rest };
  }
  if (typeof raw === 'string') {
    if (raw.includes('/')) {
      const c = parseCidr(raw);
      return { address: c?.address, prefix: c?.prefix, addressForm: 'cidr', extraAddresses: [] };
    }
    const prefix = netmask ? netmaskToPrefix(netmask) : null;
    return { address: raw, prefix: prefix ?? undefined, addressForm: 'netmask', extraAddresses: [] };
  }
  return { addressForm: 'cidr-list', extraAddresses: [] };
}

/** UCI values to write a new address back in the form it was read in. */
export function writeAddress(n: Pick<Network, 'addressForm' | 'extraAddresses'>, address: string, prefix: number) {
  switch (n.addressForm) {
    case 'cidr-list':
      return { ipaddr: [`${address}/${prefix}`, ...n.extraAddresses] };
    case 'cidr':
      return { ipaddr: `${address}/${prefix}` };
    case 'netmask':
      return { ipaddr: address, netmask: prefixToNetmask(prefix) };
  }
}

/** Local networks: UCI interfaces that are not loopback and not in the wan zone. */
export function normalizeNetworks(
  network: UciConfig,
  dhcp: UciConfig | undefined,
  firewall: UciConfig | undefined,
  dump: InterfaceDump | undefined,
): Network[] {
  const wan = wanNetworks(firewall);
  const pools = dhcp ? sectionsOfType(dhcp, 'dhcp') : [];
  return sectionsOfType(network, 'interface')
    // VPN tunnels are managed on the VPN page.
    .filter((s) => s['.name'] !== 'loopback' && !wan.has(s['.name']) && str(s.proto) !== 'wireguard')
    .map((s) => {
      const id = s['.name'];
      const pool = pools.find((p) => str(p.interface) === id);
      const live = dump?.interface.find((i) => i.interface === id);
      return {
        id,
        proto: str(s.proto) ?? 'none',
        device: str(s.device) ?? str(s.ifname),
        ...readAddress(s),
        dhcp: pool && {
          section: pool['.name'],
          enabled: !bool(pool.ignore, false),
          start: Number(str(pool.start) ?? 100),
          limit: Number(str(pool.limit) ?? 150),
          leasetime: str(pool.leasetime) ?? '12h',
        },
        up: live?.up,
        uptime: live?.uptime,
      };
    });
}

export interface Subnet {
  network: string;
  /** Network address, e.g. "192.168.1.0". */
  address: string;
  prefix: number;
  /** The router's own address on it. */
  gateway: string;
}

/**
 * Local IPv4 subnets, preferring the live address (netifd) over UCI so a
 * pending or failed edit does not misplace clients.
 */
export function localSubnets(
  network: UciConfig,
  firewall: UciConfig | undefined,
  dump: InterfaceDump | undefined,
): Subnet[] {
  return normalizeNetworks(network, undefined, firewall, dump).flatMap((n) => {
    const live = dump?.interface.find((i) => i.interface === n.id)?.['ipv4-address']?.[0];
    const gateway = live?.address ?? n.address;
    const prefix = live?.mask ?? n.prefix;
    const address = gateway && prefix !== undefined ? networkAddress(gateway, prefix) : null;
    return address && gateway && prefix !== undefined ? [{ network: n.id, address, prefix, gateway }] : [];
  });
}

/**
 * Every subnet the router is attached to, local or not, for overlap checks: a
 * LAN moved into the WAN's subnet breaks routing even though netui would still
 * reach it. Local subnets first, then any other interface with a live address.
 */
export function attachedSubnets(local: Subnet[], dump: InterfaceDump | undefined): Subnet[] {
  const seen = new Set(local.map((s) => s.network));
  const rest = (dump?.interface ?? []).flatMap((i) => {
    const a = i['ipv4-address']?.[0];
    if (seen.has(i.interface) || !a || a.address.startsWith('127.')) return [];
    const address = networkAddress(a.address, a.mask);
    return address ? [{ network: i.interface, address, prefix: a.mask, gateway: a.address }] : [];
  });
  return [...local, ...rest];
}

/** Display name for a UCI interface name: "lan" -> "LAN", "guest" -> "Guest". */
export function networkLabel(id: string): string {
  if (/^(lan|wan|iot|vpn|dmz)\d*$/i.test(id)) return id.toUpperCase();
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
}

/** "12h", "30m", "2d", "3600" (seconds) -> seconds. Null for "infinite" or garbage. */
export function parseLeasetime(v: string): number | null {
  const m = /^(\d+)([smhdw]?)$/.exec(v.trim());
  if (!m) return null;
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as '' | 's' | 'm' | 'h' | 'd' | 'w'];
  return Number(m[1]) * mult;
}

// ---------------------------------------------------------------------------
// Physical ports

export interface Port {
  name: string;
  up: boolean;
  carrier: boolean;
  /** Mbit/s, undefined when unknown. */
  speed?: number;
  duplex?: 'full' | 'half';
  /** Bridge or interface this port belongs to. */
  role: 'wan' | 'lan' | 'other';
  rxBytes: number;
  txBytes: number;
}

/** "1000F" -> 1000 Mbit/s full duplex. "-1" or absent -> unknown. */
export function parseSpeed(s: string | undefined): Pick<Port, 'speed' | 'duplex'> {
  const m = s ? /^(\d+)([FH])$/.exec(s) : null;
  if (!m) return {};
  return { speed: Number(m[1]), duplex: m[2] === 'F' ? 'full' : 'half' };
}

/** Ethernet ports, in name order, tagged by whether they serve the uplink or a bridge. */
export function normalizePorts(devices: DeviceStatusMap, uplink: Uplink | undefined): Port[] {
  const bridged = new Set(Object.values(devices).flatMap((d) => d['bridge-members'] ?? []));
  return Object.entries(devices)
    .filter(([, d]) => d.devtype === 'ethernet')
    .map(([name, d]) => ({
      name,
      up: d.up,
      carrier: d.carrier,
      ...parseSpeed(d.speed),
      role: (name === uplink?.device ? 'wan' : bridged.has(name) ? 'lan' : 'other') as Port['role'],
      rxBytes: d.statistics.rx_bytes,
      txBytes: d.statistics.tx_bytes,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** MAC addresses belonging to the router itself, to keep it out of the client list. */
export function routerMacs(devices: DeviceStatusMap): Set<string> {
  return new Set(
    Object.values(devices)
      .map((d) => d.macaddr?.toLowerCase())
      .filter((m): m is string => !!m),
  );
}

// ---------------------------------------------------------------------------
// System

export interface SystemSummary {
  hostname: string;
  model: string;
  version: string;
  target: string;
  kernel: string;
  uptime: number;
  /** 0..1 */
  memoryUsed: number;
  memoryTotal: number;
  load1: number;
}

export function normalizeSystem(board: SystemBoard, info: SystemInfo): SystemSummary {
  const m = info.memory;
  const available = m.available ?? m.free + m.buffered + (m.cached ?? 0);
  return {
    hostname: board.hostname,
    model: board.model,
    version: board.release.version,
    target: board.release.target,
    kernel: board.kernel,
    uptime: info.uptime,
    memoryUsed: m.total ? 1 - available / m.total : 0,
    memoryTotal: m.total,
    load1: info.load[0] / 65536,
  };
}

// ---------------------------------------------------------------------------
// Editing a network: router address and DHCP pool

export interface NetworkDraft {
  address: string;
  prefix: number;
  dhcpEnabled: boolean;
  /** First and last address of the pool, as typed. */
  rangeStart: string;
  rangeEnd: string;
  leasetime: string;
}

export function networkDraft(n: Network): NetworkDraft {
  const address = n.address ?? '';
  const prefix = n.prefix ?? 24;
  const start = n.dhcp?.start ?? 100;
  const limit = n.dhcp?.limit ?? 150;
  return {
    address,
    prefix,
    dhcpEnabled: n.dhcp?.enabled ?? false,
    rangeStart: (address && hostAt(address, prefix, start)) || '',
    rangeEnd: (address && hostAt(address, prefix, start + limit - 1)) || '',
    leasetime: n.dhcp?.leasetime ?? '12h',
  };
}

/**
 * Move the pool along with a new router address, keeping its offsets, so
 * changing 192.168.1.1 to 10.0.0.1 turns .100-.249 into 10.0.0.100-249.
 */
export function moveDraft(d: NetworkDraft, address: string, prefix: number): NetworkDraft {
  const next = { ...d, address, prefix };
  const oldNet = d.address && networkAddress(d.address, d.prefix);
  if (!oldNet || !isIPv4(address)) return next;
  const s = hostOffset(d.rangeStart, oldNet, d.prefix);
  const e = hostOffset(d.rangeEnd, oldNet, d.prefix);
  if (s !== null) next.rangeStart = hostAt(address, prefix, s) ?? d.rangeStart;
  if (e !== null) next.rangeEnd = hostAt(address, prefix, e) ?? d.rangeEnd;
  return next;
}

function hostCount(prefix: number): number {
  return 2 ** (32 - prefix) - 2;
}

export function validateNetwork(d: NetworkDraft, others: Subnet[]): Partial<Record<keyof NetworkDraft, string>> {
  const errors: Partial<Record<keyof NetworkDraft, string>> = {};
  if (!isIPv4(d.address)) errors.address = 'Enter an IPv4 address.';
  else if (d.prefix < 8 || d.prefix > 30) errors.prefix = 'Use a prefix between /8 and /30.';
  else {
    const offset = hostOffset(d.address, d.address, d.prefix)!;
    if (offset === 0 || offset === hostCount(d.prefix) + 1) errors.address = 'That is the network or broadcast address.';
    const clash = others.find(
      (o) => inSubnet(o.address, d.address, Math.min(o.prefix, d.prefix)),
    );
    if (clash) errors.address = `Overlaps the ${clash.network} network (${clash.address}/${clash.prefix}).`;
  }
  if (d.dhcpEnabled && !errors.address && !errors.prefix) {
    const net = networkAddress(d.address, d.prefix)!;
    const s = isIPv4(d.rangeStart) ? hostOffset(d.rangeStart, net, d.prefix) : null;
    const e = isIPv4(d.rangeEnd) ? hostOffset(d.rangeEnd, net, d.prefix) : null;
    const max = hostCount(d.prefix);
    if (s === null || s < 1 || s > max) errors.rangeStart = `Must be inside ${net}/${d.prefix}.`;
    if (e === null || e < 1 || e > max) errors.rangeEnd = `Must be inside ${net}/${d.prefix}.`;
    else if (s !== null && e < s) errors.rangeEnd = 'Must not be before the start.';
    if (!parseLeasetime(d.leasetime) && d.leasetime !== 'infinite') errors.leasetime = 'Use e.g. 12h, 30m or 7d.';
  }
  return errors;
}

/** Ops for the interface and its DHCP pool. Pool options are only touched when DHCP is on. */
export function networkOps(d: NetworkDraft, n: Network, network: UciConfig, dhcp: UciConfig): UciOp[] {
  const ops: UciOp[] = [];
  if (d.address !== n.address || d.prefix !== n.prefix) {
    ops.push(...diffSection('network', n.id, network[n.id], writeAddress(n, d.address, d.prefix)));
  }
  const net = networkAddress(d.address, d.prefix)!;
  const start = hostOffset(d.rangeStart, net, d.prefix);
  const end = hostOffset(d.rangeEnd, net, d.prefix);
  const pool =
    d.dhcpEnabled && start !== null && end !== null
      ? { ignore: '', start: String(start), limit: String(end - start + 1), leasetime: d.leasetime }
      : { ignore: '1' };
  if (n.dhcp) {
    ops.push(...diffSection('dhcp', n.dhcp.section, dhcp[n.dhcp.section], pool));
  } else if (d.dhcpEnabled) {
    // dhcp pools are conventionally named after their interface.
    const { ignore: _, ...values } = pool as Record<string, string>;
    ops.push({ op: 'add', config: 'dhcp', type: 'dhcp', name: n.id, values: { interface: n.id, ...values } });
  }
  return ops;
}

/** DHCP reservations (host sections) whose address falls in a subnet. */
export function reservationsIn(dhcp: UciConfig, address: string, prefix: number) {
  return sectionsOfType(dhcp, 'host')
    .filter((h) => {
      const ip = str(h.ip);
      return ip && inSubnet(ip, address, prefix);
    })
    .map((h) => ({ section: h['.name'], name: str(h.name), ip: str(h.ip)!, macs: list(h.mac) }));
}

// ---------------------------------------------------------------------------
// Per-network extras: DNS and domain handed out by DHCP (options 6 and 15,
// helpers in model/dns.ts), IPv6 prefix assignment and RA/DHCPv6, and IGMP
// snooping on the network's bridge.

export interface NetworkExtras {
  /** "custom" is an option-6 entry netui did not write; it is kept unless the mode changes. */
  dnsMode: DhcpDns['mode'];
  dns1: string;
  dns2: string;
  /** The raw option-6 entries, for display in custom mode. */
  dnsRaw: string[];
  /** Option 15, '' for none. */
  domain: string;
  ipv6: 'none' | 'pd';
  /** Prefix length handed to this network, e.g. "64". */
  ip6assign: string;
  /** odhcpd modes on the pool: "server", "relay", "hybrid" or '' (disabled). */
  ra: string;
  dhcpv6: string;
  slaac: boolean;
  /** Undefined when the network is not on a bridge netui can find. */
  igmp?: boolean;
  bridge?: string;
}

/** The bridge `device` section carrying a network, e.g. br-lan for "br-lan" or "br-lan.20". */
export function bridgeOf(device: string | undefined, network: UciConfig) {
  if (!device) return undefined;
  const base = device.split('.')[0];
  return sectionsOfType(network, 'device').find((s) => str(s.type) === 'bridge' && str(s.name) === base);
}

export function networkExtras(n: Network, network: UciConfig, dhcp: UciConfig): NetworkExtras {
  const pool = n.dhcp ? dhcp[n.dhcp.section] : undefined;
  const options = list(pool?.dhcp_option);
  const dns = readDhcpDns(options);
  const ip6assign = str(network[n.id]?.ip6assign) ?? '';
  const br = bridgeOf(n.device, network);
  return {
    dnsMode: dns.mode,
    dns1: dns.servers[0] ?? '',
    dns2: dns.servers[1] ?? '',
    dnsRaw: dns.raw,
    domain: readDhcpDomain(options),
    ipv6: ip6assign ? 'pd' : 'none',
    ip6assign: ip6assign || '64',
    ra: str(pool?.ra) ?? '',
    dhcpv6: str(pool?.dhcpv6) ?? '',
    slaac: bool(pool?.ra_slaac, true),
    igmp: br ? bool(br.igmp_snooping, false) : undefined,
    bridge: br ? str(br.name) : undefined,
  };
}

export function validateExtras(x: NetworkExtras): Partial<Record<'dns1' | 'dns2' | 'domain' | 'ip6assign', string>> {
  const e: Partial<Record<'dns1' | 'dns2' | 'domain' | 'ip6assign', string>> = {};
  if (x.dnsMode === 'manual') {
    if (!isIPv4(x.dns1)) e.dns1 = 'Enter an IPv4 address.';
    if (x.dns2 && !isIPv4(x.dns2)) e.dns2 = 'Enter an IPv4 address, or leave empty.';
  }
  if (x.domain && !isHostname(x.domain)) e.domain = 'Use letters, digits, hyphens and dots.';
  if (x.ipv6 === 'pd' && !(/^\d+$/.test(x.ip6assign) && +x.ip6assign >= 48 && +x.ip6assign <= 64)) {
    e.ip6assign = 'Use a prefix size between /48 and /64.';
  }
  return e;
}

/**
 * Ops for the fields that changed between `before` (from networkExtras) and
 * `x`. `pool` is the dhcp section to write, which may be one networkOps is
 * creating in the same change; without one only interface options are written.
 */
export function networkExtrasOps(
  x: NetworkExtras,
  before: NetworkExtras,
  n: Network,
  network: UciConfig,
  dhcp: UciConfig,
  pool: string | undefined,
): UciOp[] {
  const ops: UciOp[] = [];
  const iface: Record<string, string> = {};
  const v6Changed = x.ipv6 !== before.ipv6;
  if (v6Changed || (x.ipv6 === 'pd' && x.ip6assign !== before.ip6assign)) iface.ip6assign = x.ipv6 === 'pd' ? x.ip6assign : '';
  ops.push(...diffSection('network', n.id, network[n.id], iface));

  if (pool) {
    const p = dhcp[pool];
    const after: Record<string, string | string[]> = {};
    let options = list(p?.dhcp_option);
    const servers = [x.dns1, x.dns2].filter(Boolean);
    const dnsChanged =
      x.dnsMode !== before.dnsMode || (x.dnsMode === 'manual' && (x.dns1 !== before.dns1 || x.dns2 !== before.dns2));
    if (dnsChanged && x.dnsMode !== 'custom') options = setDhcpOption(options, 6, x.dnsMode === 'manual' ? servers : []);
    if (x.domain !== before.domain) options = setDhcpOption(options, 15, x.domain ? [x.domain] : []);
    if (dnsChanged || x.domain !== before.domain) after.dhcp_option = options;
    if (x.ipv6 === 'none') {
      if (v6Changed) Object.assign(after, { ra: '', dhcpv6: '' });
    } else {
      if (x.ra !== before.ra || v6Changed) after.ra = x.ra;
      if (x.dhcpv6 !== before.dhcpv6 || v6Changed) after.dhcpv6 = x.dhcpv6;
      if (x.slaac !== before.slaac) after.ra_slaac = x.slaac ? '1' : '0';
    }
    ops.push(...diffSection('dhcp', pool, p, after));
  }

  const br = bridgeOf(n.device, network);
  if (br && x.igmp !== undefined && x.igmp !== before.igmp) {
    ops.push(...diffSection('network', br['.name'], br, { igmp_snooping: x.igmp ? '1' : '' }));
  }
  return ops;
}
