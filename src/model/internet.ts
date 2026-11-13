import type { InterfaceDump, UciConfig, UciSection, UciValue } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { inSubnet, isIPv4, netmaskToPrefix, parseCidr } from '../lib/ip';
import { normalizeMac } from '../lib/mac';
import { wanNetworks, writeAddress, type AddressForm } from './network';

// The primary WAN: the UCI interface (usually "wan"), its IPv6 sibling
// ("wan6"), the port's `config device` section (MAC override) and the
// 802.1q tag carried in the device name ("wan.100").

export type WanProto = 'dhcp' | 'static' | 'pppoe';
export const WAN_PROTOS: WanProto[] = ['dhcp', 'static', 'pppoe'];

export interface Wan {
  section: string;
  proto: string;
  /** Configured device, e.g. "wan" or "wan.100". */
  device: string;
  /** Physical port under any VLAN tag. */
  port: string;
  vlan?: number;
  address?: string;
  prefix?: number;
  addressForm: AddressForm;
  gateway?: string;
  username?: string;
  hasPassword: boolean;
  /** peerdns: use the DNS servers the ISP hands out. */
  autoDns: boolean;
  dns: string[];
  /** `macaddr` on the port's device section. */
  mac?: string;
  macSection?: string;
  /** PPPoE's own IPv6 (`ipv6 '0'` turns it off). */
  pppIpv6: string | undefined;
  /** The IPv6 interface (wan6), if any. */
  v6?: { section: string; proto: string; device?: string; enabled: boolean };
}

/** "wan.100" -> port "wan", vlan 100. */
export function splitVlan(device: string): { port: string; vlan?: number } {
  const m = /^(.+)\.(\d{1,4})$/.exec(device);
  const vid = m ? Number(m[2]) : 0;
  return m && vid >= 1 && vid <= 4094 ? { port: m[1]!, vlan: vid } : { port: device };
}

function readAddress(s: UciSection): Pick<Wan, 'address' | 'prefix' | 'addressForm'> {
  const raw = s.ipaddr;
  if (Array.isArray(raw)) {
    const c = raw[0] ? parseCidr(raw[0]) : null;
    return { address: c?.address, prefix: c?.prefix, addressForm: 'cidr-list' };
  }
  if (typeof raw === 'string') {
    if (raw.includes('/')) {
      const c = parseCidr(raw);
      return { address: c?.address, prefix: c?.prefix, addressForm: 'cidr' };
    }
    const mask = str(s.netmask);
    return { address: raw, prefix: (mask ? netmaskToPrefix(mask) : null) ?? undefined, addressForm: 'netmask' };
  }
  return { addressForm: 'cidr-list' };
}

const isV6Proto = (p: string | undefined) => p === 'dhcpv6' || p === '6in4' || p === '6rd' || p === '6to4';

/** The primary WAN section: "wan" if present, else the first IPv4 interface in the wan zone. */
export function normalizeWan(network: UciConfig, firewall: UciConfig | undefined): Wan | undefined {
  const zone = [...wanNetworks(firewall)];
  const ifaces = sectionsOfType(network, 'interface').filter((s) => zone.includes(s['.name']));
  const s = ifaces.find((x) => x['.name'] === 'wan') ?? ifaces.find((x) => !isV6Proto(str(x.proto)));
  if (!s) return undefined;
  const device = str(s.device) ?? str(s.ifname) ?? '';
  const { port, vlan } = splitVlan(device);
  const dev = sectionsOfType(network, 'device').find((d) => str(d.name) === port);
  const v6s =
    ifaces.find((x) => x['.name'] === `${s['.name']}6`) ??
    ifaces.find((x) => x !== s && isV6Proto(str(x.proto)));
  return {
    section: s['.name'],
    proto: str(s.proto) ?? 'none',
    device,
    port,
    vlan,
    ...readAddress(s),
    gateway: str(s.gateway),
    username: str(s.username),
    hasPassword: !!str(s.password),
    autoDns: bool(s.peerdns, true),
    dns: list(s.dns),
    pppIpv6: str(s.ipv6),
    mac: str(dev?.macaddr),
    macSection: dev?.['.name'],
    v6: v6s && {
      section: v6s['.name'],
      proto: str(v6s.proto) ?? 'dhcpv6',
      device: str(v6s.device) ?? str(v6s.ifname),
      enabled: !bool(v6s.disabled, false) && bool(v6s.auto, true),
    },
  };
}

/** The layer 3 device traffic leaves on: what SQM must shape. */
export function wanL3Device(wan: Pick<Wan, 'section' | 'proto' | 'device'>, dump?: InterfaceDump): string {
  const live = dump?.interface.find((i) => i.interface === wan.section);
  if (live?.up && live.l3_device) return live.l3_device;
  return wan.proto === 'pppoe' ? `pppoe-${wan.section}` : wan.device;
}

// ---------------------------------------------------------------------------
// Editing

export interface WanDraft {
  proto: string;
  address: string;
  prefix: string;
  gateway: string;
  username: string;
  /** Empty means keep the stored password. */
  password: string;
  autoDns: boolean;
  /** Comma or space separated. */
  dns: string;
  vlan: string;
  mac: string;
  ipv6: boolean;
}

export function wanDraft(w: Wan): WanDraft {
  return {
    proto: w.proto,
    address: w.address ?? '',
    prefix: w.prefix != null ? String(w.prefix) : '24',
    gateway: w.gateway ?? '',
    username: w.username ?? '',
    password: '',
    autoDns: w.proto === 'static' ? false : w.autoDns,
    dns: w.dns.join(', '),
    vlan: w.vlan ? String(w.vlan) : '',
    mac: w.mac ?? '',
    ipv6: w.proto === 'pppoe' ? w.pppIpv6 !== '0' && (w.v6?.enabled ?? true) : (w.v6?.enabled ?? false),
  };
}

export const splitList = (v: string) => v.split(/[\s,]+/).filter(Boolean);

export function validateWan(d: WanDraft, w: Wan): Partial<Record<keyof WanDraft, string>> {
  const e: Partial<Record<keyof WanDraft, string>> = {};
  if (d.proto === 'static') {
    const prefix = Number(d.prefix);
    if (!isIPv4(d.address)) e.address = 'Enter an IPv4 address.';
    if (!/^\d{1,2}$/.test(d.prefix) || prefix < 1 || prefix > 32) e.prefix = 'A prefix length from 1 to 32.';
    if (!isIPv4(d.gateway)) e.gateway = 'Enter the gateway’s IPv4 address.';
    else if (!e.address && !e.prefix && !inSubnet(d.gateway, d.address, prefix)) e.gateway = 'Not in the WAN subnet.';
    else if (d.gateway === d.address) e.gateway = 'Same as the WAN address.';
  }
  if (d.proto === 'pppoe') {
    if (!d.username.trim()) e.username = 'Enter the username from your ISP.';
    if (!d.password && !(w.proto === 'pppoe' && w.hasPassword)) e.password = 'Enter the password from your ISP.';
  }
  if (!d.autoDns || d.proto === 'static') {
    const bad = splitList(d.dns).find((x) => !isIPv4(x) && !/^[0-9a-f:]+$/i.test(x));
    if (bad) e.dns = `${bad} is not an IP address.`;
    else if (d.proto !== 'static' && splitList(d.dns).length === 0) e.dns = 'Enter at least one DNS server.';
  }
  if (d.vlan && (!/^\d{1,4}$/.test(d.vlan) || Number(d.vlan) < 1 || Number(d.vlan) > 4094)) e.vlan = 'A VLAN ID from 1 to 4094.';
  if (d.mac) {
    const m = normalizeMac(d.mac);
    if (!m) e.mac = 'A MAC address like 02:11:22:33:44:55.';
    else if (parseInt(m.slice(0, 2), 16) & 1) e.mac = 'That is a multicast address.';
  }
  return e;
}

/**
 * Ops for a WAN edit. Options of the protocols not chosen are removed, a
 * VLAN tag moves wan6 along with wan, and an enabled SQM queue follows the
 * new layer 3 device.
 */
export function wanOps(d: WanDraft, w: Wan, network: UciConfig, sqm?: UciConfig): UciOp[] {
  const s = network[w.section];
  const device = d.vlan ? `${w.port}.${Number(d.vlan)}` : w.port;
  const isStatic = d.proto === 'static';
  const isPppoe = d.proto === 'pppoe';
  const dns = splitList(d.dns);
  const values: Record<string, UciValue | undefined> = {
    proto: d.proto,
    // Legacy `ifname` is left alone unless the device actually changes.
    ...(device !== w.device || s?.device !== undefined ? { device } : {}),
    ipaddr: undefined,
    netmask: undefined,
    gateway: isStatic ? d.gateway : '',
    username: isPppoe ? d.username.trim() : '',
    password: isPppoe ? d.password || str(s?.password) : '',
    peerdns: isStatic || d.autoDns ? '' : '0',
    dns: isStatic || !d.autoDns ? dns : [],
    // PPPoE brings IPv6 up itself (ipv6 auto); honour the toggle there too.
    ipv6: isPppoe ? (d.ipv6 ? (w.pppIpv6 === '0' ? '' : w.pppIpv6) : '0') : w.proto === 'pppoe' ? '' : w.pppIpv6,
  };
  if (isStatic) Object.assign(values, writeAddress({ addressForm: w.addressForm, extraAddresses: [] }, d.address, Number(d.prefix)));
  else Object.assign(values, { ipaddr: '', netmask: '' });
  // A protocol this form does not model (L2TP, QMI, ...) keeps its own options.
  if (!(WAN_PROTOS as string[]).includes(d.proto)) {
    for (const k of ['ipaddr', 'netmask', 'gateway', 'username', 'password', 'ipv6']) delete values[k];
    if (d.autoDns) delete values.dns;
  }
  if (device !== w.device && s?.device === undefined && s?.ifname !== undefined) values.ifname = '';
  const ops = diffSection('network', w.section, s, values);

  if (w.v6) {
    const v6 = network[w.v6.section];
    const follow = w.v6.device === w.device && device !== w.device;
    const enabled = w.v6.enabled === d.ipv6 ? {} : d.ipv6 ? { disabled: '', auto: '' } : { disabled: '1' };
    ops.push(...diffSection('network', w.v6.section, v6, { ...(follow ? { device } : {}), ...enabled }));
  }

  const mac = d.mac ? normalizeMac(d.mac)! : '';
  if (w.macSection) ops.push(...diffSection('network', w.macSection, network[w.macSection], { macaddr: mac }));
  else if (mac) ops.push({ op: 'add', config: 'network', type: 'device', values: { name: w.port, macaddr: mac } });

  if (sqm) {
    const l3 = isPppoe ? `pppoe-${w.section}` : device;
    const old = [w.device, w.port, `pppoe-${w.section}`];
    for (const q of sectionsOfType(sqm, 'queue')) {
      const iface = str(q.interface) ?? '';
      if (bool(q.enabled, false) && iface !== l3 && old.includes(iface)) {
        ops.push({ op: 'set', config: 'sqm', section: q['.name'], values: { interface: l3 } });
      }
    }
  }
  return ops;
}
