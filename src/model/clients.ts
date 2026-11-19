import type { AssocStation, DhcpLeases, HostHints, UciConfig } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { inSubnet, isIPv4 } from '../lib/ip';
import { isLocallyAdministered, normalizeMac } from '../lib/mac';
import { ouiVendor, type DeviceKind } from '../lib/oui';
import type { BlockRule } from './firewall';
import type { SpeedLimit } from './speedLimit';
import type { Subnet } from './network';

export interface WirelessLink {
  /** iwinfo device the station is associated to, e.g. "phy0-ap0". */
  ifname: string;
  ssid?: string;
  band?: string;
  signal: number;
  /** Mbit/s */
  rxRate: number;
  txRate: number;
  connectedTime?: number;
  rxBytes?: number;
  txBytes?: number;
  /** ms since the station was last heard from. */
  inactive?: number;
  /** Filled in by withRadioInfo() from the serving device's iwinfo info. */
  channel?: number;
  /** e.g. "HE80"; bounds the link rate the station can reach. */
  htmode?: string;
  /** The adopted access point serving the station; absent for this router's own radios. */
  ap?: { mac: string; name: string };
}

export interface Reservation {
  section: string;
  name?: string;
  ip?: string;
}

export interface Client {
  /** Lowercase colon-separated MAC; the merge key. */
  mac: string;
  /** Best display name: reservation name, then DHCP hostname, then host hint. */
  name?: string;
  ip?: string;
  network?: string;
  /**
   * Further leases for the same MAC, e.g. a host with VLAN subinterfaces that
   * share one MAC and lease on several networks. `ip` is the lease with the
   * most time left.
   */
  otherAddresses?: { ip: string; network?: string }[];
  /** Associated to one of our radios right now. */
  wireless?: WirelessLink;
  /** Seconds left on the DHCP lease; false for a static lease. */
  leaseExpires?: number | false;
  reservation?: Reservation;
  block?: BlockRule;
  /** Speed limit (model/speedLimit). */
  limit?: SpeedLimit;
  /** Locally administered MAC, usually a phone's per-network random address. */
  randomMac: boolean;
  /** IPv6 addresses from host hints (neighbour table). */
  ip6?: string[];
  /** Has live connections in the router's connection table (set by the traffic model's hook). */
  active?: boolean;
}

export interface ClientSources {
  leases?: DhcpLeases;
  hints?: HostHints;
  /**
   * iwinfo assoclist results per device, with that device's SSID and band.
   * Entries from an adopted access point name it and carry its radio's
   * channel and width (its interface names can repeat the gateway's).
   */
  assoc?: {
    ifname: string;
    ssid?: string;
    band?: string;
    stations: AssocStation[];
    ap?: { mac: string; name: string };
    channel?: number;
    htmode?: string;
  }[];
  dhcp?: UciConfig;
  blocks?: BlockRule[];
  limits?: SpeedLimit[];
  /** MACs of the router's own interfaces. */
  routerMacs?: Set<string>;
  /** Local subnets; host hints outside them (the WAN gateway etc.) are dropped. */
  subnets?: Subnet[];
}

/**
 * Merge every source by MAC. A client appears if it holds a lease, is
 * associated, has a reservation or block, or is a host hint on a local
 * subnet. dnsmasq and luci-rpc report uppercase MACs; everything is
 * normalized before comparing.
 */
export function mergeClients(src: ClientSources): Client[] {
  const byMac = new Map<string, Client>();
  const skip = src.routerMacs ?? new Set<string>();
  const subnets = src.subnets ?? [];

  const get = (raw: string): Client | undefined => {
    const mac = normalizeMac(raw);
    if (!mac || skip.has(mac)) return undefined;
    let c = byMac.get(mac);
    if (!c) {
      c = { mac, randomMac: isLocallyAdministered(mac) };
      byMac.set(mac, c);
    }
    return c;
  };
  const subnetOf = (ip: string) => subnets.find((s) => inSubnet(ip, s.address, s.prefix));

  // Most time left first (static leases first of all): that lease becomes the
  // client's address and name, the rest go to otherAddresses.
  const remaining = (e: number | false) => (e === false ? Infinity : e);
  const leases = [...(src.leases?.dhcp_leases ?? [])].sort((a, b) => remaining(b.expires) - remaining(a.expires));
  const extra = new Map<Client, string[]>();
  for (const l of leases) {
    const c = get(l.macaddr);
    if (!c) continue;
    if (c.ip !== undefined) {
      if (c.ip !== l.ipaddr) extra.set(c, [...(extra.get(c) ?? []), l.ipaddr]);
      continue;
    }
    c.ip = l.ipaddr;
    c.leaseExpires = l.expires;
    if (l.hostname) c.name ??= l.hostname;
  }

  for (const a of src.assoc ?? []) {
    for (const st of a.stations) {
      const c = get(st.mac);
      if (!c) continue;
      c.wireless = {
        ifname: a.ifname,
        ssid: a.ssid,
        band: a.band,
        signal: st.signal,
        rxRate: st.rx.rate / 1000,
        txRate: st.tx.rate / 1000,
        connectedTime: st.connected_time,
        rxBytes: st.rx.bytes,
        txBytes: st.tx.bytes,
        inactive: st.inactive,
        ...(a.ap ? { ap: a.ap, channel: a.channel, htmode: a.htmode } : {}),
      };
    }
  }

  for (const h of src.dhcp ? sectionsOfType(src.dhcp, 'host') : []) {
    for (const raw of list(h.mac)) {
      const c = get(raw);
      if (!c) continue;
      c.reservation = { section: h['.name'], name: str(h.name), ip: str(h.ip) };
      if (c.reservation.name) c.name = c.reservation.name;
      c.ip ??= c.reservation.ip;
    }
  }

  for (const b of src.blocks ?? []) {
    for (const mac of b.macs) {
      const c = get(mac);
      if (c && (!c.block || (b.enabled && !c.block.enabled))) c.block = b;
    }
  }

  for (const l of src.limits ?? []) {
    const c = get(l.mac);
    if (c && !c.limit && l.enabled) c.limit = l;
  }

  // Hints last: they fill in names and addresses but only create a client
  // when the address is on a local subnet.
  for (const [raw, h] of Object.entries(src.hints ?? {})) {
    const mac = normalizeMac(raw);
    if (!mac || skip.has(mac)) continue;
    const local = h.ipaddrs.filter(isIPv4).filter((ip) => subnetOf(ip));
    const known = byMac.get(mac);
    if (!known && local.length === 0) continue;
    const c = get(mac)!;
    c.ip ??= local[0];
    // Hints carry mDNS/DNS names ("tv.local", "tv.lan"); show the host part.
    c.name ??= h.name?.split('.')[0] || h.name;
    if (h.ip6addrs.length) c.ip6 = h.ip6addrs;
  }

  for (const c of byMac.values()) if (c.ip) c.network = subnetOf(c.ip)?.network;
  for (const [c, ips] of extra) c.otherAddresses = ips.map((ip) => ({ ip, network: subnetOf(ip)?.network }));

  return [...byMac.values()].sort(compareClients);
}

function compareClients(a: Client, b: Client): number {
  return (a.name ?? a.mac).localeCompare(b.name ?? b.mac, undefined, { sensitivity: 'base' });
}

export function displayName(c: Client): string {
  return c.name ?? c.mac;
}

export type ClientFilter = 'all' | 'wired' | 'wireless' | 'blocked' | 'offline';

/**
 * Known but not connected: no association, no DHCP lease and no live
 * connections. Reservations and host hints keep such clients in the list.
 */
export function isOffline(c: Client): boolean {
  return !c.wireless && c.leaseExpires === undefined && !c.active;
}

/**
 * Without a neighbour table in the ACL there is no way to tell a wired client
 * from a wireless one that is currently disassociated, so "wired" means "not
 * associated to our radios right now".
 */
export function matchesFilter(c: Client, f: ClientFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'wireless':
      return !!c.wireless;
    case 'wired':
      return !c.wireless && !c.block?.enabled && !isOffline(c);
    case 'blocked':
      return !!c.block?.enabled;
    case 'offline':
      return isOffline(c);
  }
}

// ---------------------------------------------------------------------------
// Editing: alias + fixed IP live in a dhcp `host` section; blocking is a
// firewall rule (see model/firewall.ts).

export interface ClientSettings {
  /** DNS name for the client; empty for none. */
  alias: string;
  fixedIp: boolean;
  ip: string;
}

export function clientSettings(c: Client): ClientSettings {
  return {
    alias: c.reservation?.name ?? '',
    fixedIp: !!c.reservation?.ip,
    ip: c.reservation?.ip ?? c.ip ?? '',
  };
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** First problem with the settings, or null. */
export function validateClientSettings(
  s: ClientSettings,
  c: Client,
  subnets: Subnet[],
  dhcp: UciConfig | undefined,
): string | null {
  if (s.alias && !HOSTNAME.test(s.alias)) {
    return 'Alias is used as a DNS name: letters, digits and hyphens only, no spaces.';
  }
  if (!s.fixedIp) return null;
  if (!isIPv4(s.ip)) return 'Enter an IPv4 address.';
  const subnet = subnets.find((n) => inSubnet(s.ip, n.address, n.prefix));
  if (!subnet) return `${s.ip} is not in any local network.`;
  if (s.ip === subnet.gateway) return `${s.ip} is the router's own address.`;
  const taken = dhcp
    ? sectionsOfType(dhcp, 'host').find((h) => h['.name'] !== c.reservation?.section && str(h.ip) === s.ip)
    : undefined;
  if (taken) return `${s.ip} is already reserved for ${str(taken.name) ?? list(taken.mac)[0] ?? 'another device'}.`;
  return null;
}

/**
 * Ops that make the dhcp host section match `s`. A reservation with neither
 * a name nor an address is deleted. Shared reservations (several MACs) are
 * edited in place, which affects every MAC on them.
 */
export function clientSettingsOps(s: ClientSettings, c: Client, dhcp: UciConfig): UciOp[] {
  const values = { name: s.alias, ip: s.fixedIp ? s.ip : '' };
  const r = c.reservation;
  if (!s.alias && !s.fixedIp) return r ? [{ op: 'delete', config: 'dhcp', section: r.section }] : [];
  if (r) return diffSection('dhcp', r.section, dhcp[r.section], values);
  return [
    {
      op: 'add',
      config: 'dhcp',
      type: 'host',
      values: { mac: [c.mac.toUpperCase()], ...(s.alias ? { name: s.alias } : {}), ...(s.fixedIp ? { ip: s.ip } : {}) },
    },
  ];
}

// ---------------------------------------------------------------------------
// Presentation helpers for the client list (additive to the merge above).

/** Copy channel and width from each station's serving device into its link. */
export function withRadioInfo(
  clients: Client[],
  devices: { ifname: string; info?: { channel?: number; htmode?: string } }[],
): Client[] {
  const by = new Map(devices.map((d) => [d.ifname, d.info]));
  return clients.map((c) => {
    // A station on an access point already carries that radio's details.
    const info = c.wireless && !c.wireless.ap && by.get(c.wireless.ifname);
    return info ? { ...c, wireless: { ...c.wireless!, channel: info.channel, htmode: info.htmode } } : c;
  });
}

/** Every address the client is known by: lease, other leases, IPv6 hints. */
export function clientAddresses(c: Client): string[] {
  return [c.ip, ...(c.otherAddresses ?? []).map((o) => o.ip), ...(c.ip6 ?? [])].filter((x): x is string => !!x);
}

// Hostname patterns, checked before the OUI vendor's kind: names are set by
// the device itself and also cover private (randomized) MACs.
const NAME_KINDS: [RegExp, DeviceKind][] = [
  [/iphone|android|galaxy|pixel|redmi|oneplus|huawei|honor|oppo|vivo|xiaomi|moto|phone/i, 'phone'],
  [/ipad|tablet|kindle|fire-?hd/i, 'phone'],
  [/macbook|imac|mac-?mini|mac-?pro|desktop-|laptop|thinkpad|notebook|-pc\b|^pc-|surface|chromebook|ubuntu|fedora|debian|raspberrypi|workstation/i, 'computer'],
  [/apple-?tv|appletv|chromecast|roku|fire-?tv|aftm|webos|lgwebos|bravia|samsung-?tv|\btv\b|-tv|tv-|shield|vizio|tizen/i, 'tv'],
  [/playstation|ps[345]|xbox|nintendo|steam-?deck/i, 'console'],
  [/sonos|homepod|echo|alexa|google-?home|nest-?(mini|audio|hub)|speaker|bose/i, 'speaker'],
  [/cam(era)?\b|doorbell|ring-|reolink|hikvision|wyze|arlo/i, 'camera'],
  [/printer|epson|canon|brother|hp[0-9a-f]{6}|laserjet|officejet|deskjet/i, 'printer'],
  [/nas\b|synology|diskstation|qnap|truenas/i, 'nas'],
  [/esp[-_]|esp32|esp8266|tasmota|shelly|tuya|wled|hue|tradfri|zigbee|thermostat|ecobee|plug|bulb|sensor|vacuum|roborock|roomba|miio/i, 'iot'],
  [/router|openwrt|switch|access-?point|\bap\b|mesh|repeater|extender/i, 'network'],
];

/** Device type for the list icon: from the hostname, else from the OUI vendor. */
export function clientKind(c: Client): DeviceKind | undefined {
  const name = c.name ?? '';
  for (const [re, kind] of NAME_KINDS) if (re.test(name)) return kind;
  return ouiVendor(c.mac)?.kind;
}
