// WireGuard VPN server: one form creates the interface, its
// firewall zone, forwardings and the wan rule that opens the port; clients
// are the interface's `wireguard_<iface>` peer sections.
//
// Option names follow LuCI's protocol/wireguard.js and netifd's
// proto/wireguard.sh on the target (OpenWrt SNAPSHOT):
//   interface: proto wireguard, private_key, listen_port, addresses (list),
//              mtu, fwmark
//   peer (type wireguard_<iface>): description, public_key, preshared_key,
//              allowed_ips (list), route_allowed_ips, persistent_keepalive,
//              disabled
//
// netui-owned state:
//   - the interface options `netui_endpoint` (public host clients dial) and
//     `netui_dns` (DNS servers handed to clients). netifd ignores options it
//     does not know, so these live with the server they describe, go away
//     with it, and are visible to `uci show`.
//   - firewall sections named `netui_<iface>_*`. The name is the ownership
//     marker: delete removes exactly these and nothing a user wrote.
//
// Peer changes and netifd: wireguard.sh only reads peers in setup, and
// `network reload` restarts an interface only when one of its proto
// parameters (private_key, listen_port, mtu, fwmark) changed. So a peer
// added, removed or disabled through apply alone would not reach the kernel
// (LuCI's own hint says "Restart wireguard interface to apply changes").
// restartOps() flips `mtu` between unset and 1420, which is WireGuard's
// default MTU, so the interface is set up again with no change in behaviour.
// A removed client must stop working, so this is not optional.

import type { InterfaceDump, UciConfig, UciSection, UciValue, WgInstances } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { formatIPv4, hostAt, hostOffset, inSubnet, isIPv4, networkAddress, parseCidr, parseIPv4 } from '../lib/ip';
import { findUplink, wanZoneName, type Subnet } from './network';
import { dmzFollowOps } from './firewall';

export const DEFAULT_PORT = 51820;
/** WireGuard's default MTU; `ip link add type wireguard` uses it. */
export const WG_DEFAULT_MTU = '1420';
/** No handshake for this long means no session (WireGuard rekeys every 2 minutes). */
export const CONNECTED_WINDOW_S = 180;

export type VpnAccess = 'full' | 'internet';

export interface PeerLive {
  /** Unix seconds of the latest handshake. */
  handshake?: number;
  endpoint?: string;
  /** Bytes received from the client (its upload). */
  rx: number;
  /** Bytes sent to the client (its download). */
  tx: number;
  connected: boolean;
}

export interface VpnPeer {
  section: string;
  name: string;
  enabled: boolean;
  publicKey: string;
  hasPsk: boolean;
  allowedIps: string[];
  /** The client's tunnel address: its first /32 (or bare IPv4) allowed IP. */
  address?: string;
  keepalive?: string;
  live?: PeerLive;
}

export interface VpnServer {
  iface: string;
  listenPort?: number;
  /** Server's tunnel address and prefix, from the first IPv4 in `addresses`. */
  address?: string;
  prefix?: number;
  /** DNS servers for clients; defaults to the server address. */
  dns: string[];
  endpoint?: string;
  /** Derived from the zone's forwardings. */
  access: VpnAccess | 'custom';
  zone?: string;
  /** Created by netui: its firewall sections carry the netui_<iface>_ names. */
  managed: boolean;
  peers: VpnPeer[];
  up: boolean;
  /** From the running instance; absent while the interface is down. */
  publicKey?: string;
}

export interface VpnModel {
  servers: VpnServer[];
  /** WireGuard interfaces without a listen port: tunnels to elsewhere, left to LuCI. */
  others: string[];
}

// ---------------------------------------------------------------------------
// Firewall section names netui owns

export const fwSection = {
  zone: (iface: string) => `netui_${iface}_zone`,
  wan: (iface: string) => `netui_${iface}_wan`,
  lan: (iface: string) => `netui_${iface}_lan`,
  /** The wan input rule that opens the listen port. */
  port: (iface: string) => `netui_${iface}_port`,
  /** DNS from the VPN to the router, for internet-only servers. */
  dns: (iface: string) => `netui_${iface}_dns`,
};

const ownedSections = (iface: string) => Object.values(fwSection).map((f) => f(iface));

export const peerType = (iface: string) => `wireguard_${iface}`;

// ---------------------------------------------------------------------------
// Normalizing

function firstV4(addresses: string[]): { address: string; prefix: number } | undefined {
  for (const a of addresses) {
    const c = parseCidr(a);
    if (c) return c;
  }
  return undefined;
}

function zoneOf(fw: UciConfig | undefined, iface: string): UciSection | undefined {
  return fw ? sectionsOfType(fw, 'zone').find((z) => list(z.network).includes(iface)) : undefined;
}

function zoneName(z: UciSection): string {
  return str(z.name) ?? z['.name'];
}

/** The zone holding "lan", else the one named lan. */
function lanZoneName(fw: UciConfig): string | undefined {
  const zs = sectionsOfType(fw, 'zone');
  const z = zs.find((z) => list(z.network).includes('lan')) ?? zs.find((z) => str(z.name) === 'lan');
  return z && zoneName(z);
}

function accessOf(fw: UciConfig | undefined, zone: string | undefined): VpnServer['access'] {
  if (!fw || !zone) return 'custom';
  const dests = sectionsOfType(fw, 'forwarding')
    .filter((f) => str(f.src) === zone && bool(f.enabled, true))
    .map((f) => str(f.dest));
  const lan = lanZoneName(fw);
  if (lan && dests.includes(lan)) return 'full';
  if (dests.includes(wanZoneName(fw))) return 'internet';
  return 'custom';
}

export function normalizePeerLive(
  s: { latest_handshake: string; endpoint: string; transfer_rx: string; transfer_tx: string },
  nowS: number,
): PeerLive {
  const hs = Number(s.latest_handshake);
  const handshake = Number.isFinite(hs) && hs > 0 ? hs : undefined;
  return {
    handshake,
    endpoint: s.endpoint && s.endpoint !== '(none)' ? s.endpoint : undefined,
    rx: Number(s.transfer_rx) || 0,
    tx: Number(s.transfer_tx) || 0,
    connected: handshake !== undefined && nowS - handshake < CONNECTED_WINDOW_S,
  };
}

function normalizePeer(s: UciSection, live: WgInstances[string] | undefined, nowS: number): VpnPeer {
  const allowedIps = list(s.allowed_ips);
  const publicKey = str(s.public_key) ?? '';
  const host = allowedIps.map((a) => parseCidr(a)).find((c) => c && c.prefix === 32);
  const status = live?.peers.find((p) => p.public_key === publicKey);
  return {
    section: s['.name'],
    name: str(s.description) ?? '',
    enabled: !bool(s.disabled, false),
    publicKey,
    hasPsk: !!str(s.preshared_key),
    allowedIps,
    address: host?.address,
    keepalive: str(s.persistent_keepalive),
    live: status && normalizePeerLive(status, nowS),
  };
}

/**
 * WireGuard servers (proto wireguard with a listen port, or created by netui)
 * with their peers and live state. `nowS` is the browser clock in seconds;
 * handshakes are the router's, so this assumes both keep time.
 */
export function normalizeVpn(
  network: UciConfig,
  firewall: UciConfig | undefined,
  dump: InterfaceDump | undefined,
  wg: WgInstances | undefined,
  nowS: number,
): VpnModel {
  const servers: VpnServer[] = [];
  const others: string[] = [];
  for (const s of sectionsOfType(network, 'interface')) {
    if (str(s.proto) !== 'wireguard') continue;
    const iface = s['.name'];
    // The router as a client of a VPN service: model/vpnClient.
    if (network[`netui_${iface}_peer`]) continue;
    const managed = !!firewall?.[fwSection.zone(iface)];
    const port = Number(str(s.listen_port));
    if (!str(s.listen_port) && !managed) {
      others.push(iface);
      continue;
    }
    const addr = firstV4(list(s.addresses));
    const zone = zoneOf(firewall, iface);
    const live = wg?.[iface];
    const dns = list(s.netui_dns);
    servers.push({
      iface,
      listenPort: Number.isInteger(port) && port > 0 ? port : undefined,
      address: addr?.address,
      prefix: addr?.prefix,
      dns: dns.length ? dns : addr ? [addr.address] : [],
      endpoint: str(s.netui_endpoint),
      access: accessOf(firewall, zone && zoneName(zone)),
      zone: zone && zoneName(zone),
      managed,
      peers: sectionsOfType(network, peerType(iface)).map((p) => normalizePeer(p, live, nowS)),
      up: dump?.interface.find((i) => i.interface === iface)?.up ?? false,
      publicKey: live?.public_key && live.public_key !== '(none)' ? live.public_key : undefined,
    });
  }
  return { servers, others };
}

// ---------------------------------------------------------------------------
// Addressing

const overlaps = (a: { address: string; prefix: number }, b: { address: string; prefix: number }) =>
  inSubnet(a.address, b.address, Math.min(a.prefix, b.prefix));

/** Subnets a new VPN must not overlap: every attached subnet plus other WireGuard addresses. */
export function takenSubnets(attached: Subnet[], network: UciConfig): { address: string; prefix: number; network: string }[] {
  const wg = sectionsOfType(network, 'interface')
    .filter((s) => str(s.proto) === 'wireguard')
    .flatMap((s) =>
      list(s.addresses).flatMap((a) => {
        const c = parseCidr(a);
        return c ? [{ address: networkAddress(c.address, c.prefix)!, prefix: c.prefix, network: s['.name'] }] : [];
      }),
    );
  return [...attached.map((s) => ({ address: s.address, prefix: s.prefix, network: s.network })), ...wg];
}

/** A free private /24 for the VPN, as the server's "address/prefix" (the .1). */
export function suggestSubnet(taken: { address: string; prefix: number }[]): string {
  const candidates = [
    ...Array.from({ length: 249 }, (_, i) => `10.${i + 6}.0.0`),
    ...Array.from({ length: 16 }, (_, i) => `172.${i + 16}.100.0`),
  ];
  const free = candidates.find((c) => !taken.some((t) => overlaps({ address: c, prefix: 24 }, t)));
  return `${hostAt(free ?? '10.6.0.0', 24, 1)}/24`;
}

/** The next free client address in the server's subnet, or null when full. */
export function nextPeerAddress(server: Pick<VpnServer, 'address' | 'prefix' | 'peers'>): string | null {
  if (!server.address || server.prefix === undefined) return null;
  const net = networkAddress(server.address, server.prefix)!;
  const used = new Set<number>([parseIPv4(server.address)!]);
  for (const p of server.peers) {
    for (const a of p.allowedIps) {
      const c = parseCidr(a);
      if (c && c.prefix === 32) used.add(parseIPv4(c.address)!);
    }
  }
  const last = 2 ** (32 - server.prefix) - 2;
  for (let off = 1; off <= last; off++) {
    const ip = parseIPv4(net)! + off;
    if (!used.has(ip)) return formatIPv4(ip >>> 0);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Endpoint

/** Where clients should dial: an enabled DDNS hostname, else the WAN address. */
export function defaultEndpoint(ddns: UciConfig | undefined, dump: InterfaceDump | undefined): string {
  for (const s of ddns ? sectionsOfType(ddns, 'service') : []) {
    // ddns-scripts treats a missing `enabled` as off.
    if (!bool(s.enabled, false)) continue;
    const host = str(s.lookup_host) ?? str(s.domain);
    if (host) return host;
  }
  return (dump && findUplink(dump)?.address) || '';
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function isEndpointHost(v: string): boolean {
  const s = v.trim();
  if (isIPv4(s)) return true;
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return true;
  return HOSTNAME.test(s) && !/^[\d.]+$/.test(s);
}

// ---------------------------------------------------------------------------
// Server drafts

export interface ServerDraft {
  name: string;
  port: string;
  /** Server address and subnet, "10.6.0.1/24". */
  cidr: string;
  /** Space or comma separated; empty means "the server address". */
  dns: string;
  access: VpnAccess;
  endpoint: string;
}

export function newServerDraft(ctx: {
  network: UciConfig;
  taken: { address: string; prefix: number }[];
  ddns?: UciConfig;
  dump?: InterfaceDump;
}): ServerDraft {
  const names = new Set(Object.keys(ctx.network));
  let n = 0;
  while (names.has(`wg${n}`)) n++;
  const ports = new Set(wgPorts(ctx.network));
  let port = DEFAULT_PORT;
  while (ports.has(port)) port++;
  return {
    name: `wg${n}`,
    port: String(port),
    cidr: suggestSubnet(ctx.taken),
    dns: '',
    access: 'full',
    endpoint: defaultEndpoint(ctx.ddns, ctx.dump),
  };
}

export function serverDraft(s: VpnServer): Omit<ServerDraft, 'name' | 'cidr'> {
  const def = s.address ? [s.address] : [];
  const custom = s.dns.join(' ') !== def.join(' ');
  return {
    port: s.listenPort ? String(s.listenPort) : '',
    dns: custom ? s.dns.join(', ') : '',
    access: s.access === 'internet' ? 'internet' : 'full',
    endpoint: s.endpoint ?? '',
  };
}

function wgPorts(network: UciConfig, except?: string): number[] {
  return sectionsOfType(network, 'interface')
    .filter((s) => str(s.proto) === 'wireguard' && s['.name'] !== except)
    .map((s) => Number(str(s.listen_port)))
    .filter((p) => p > 0);
}

/** Ports already taken from the wan side: other WireGuard servers and UDP port forwards. */
function portClash(port: number, network: UciConfig, firewall: UciConfig, except?: string): string | null {
  if (wgPorts(network, except).includes(port)) return 'Another WireGuard interface listens on this port.';
  for (const r of sectionsOfType(firewall, 'redirect')) {
    const protos = list(r.proto);
    if (protos.length && !protos.includes('udp') && !protos.includes('all')) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(str(r.src_dport) ?? '');
    if (m && port >= Number(m[1]) && port <= Number(m[2] ?? m[1])) {
      return `Used by the port forward "${str(r.name) ?? r['.name']}".`;
    }
  }
  return null;
}

export function parseDnsList(v: string): string[] {
  return v.split(/[\s,]+/).filter(Boolean);
}

/** Interface names become the netdev and possibly the zone name: fw4 zones allow 11 characters. */
const NAME = /^[a-z][a-z0-9_]{0,10}$/;

type DraftErrors = Partial<Record<keyof ServerDraft, string>>;

function validateCommon(
  d: Omit<ServerDraft, 'name' | 'cidr'>,
  ctx: { network: UciConfig; firewall: UciConfig; except?: string },
): DraftErrors {
  const e: DraftErrors = {};
  const port = Number(d.port);
  if (!/^\d{1,5}$/.test(d.port.trim()) || port < 1 || port > 65535) e.port = 'A port between 1 and 65535.';
  else {
    const clash = portClash(port, ctx.network, ctx.firewall, ctx.except);
    if (clash) e.port = clash;
  }
  const dns = parseDnsList(d.dns);
  if (dns.some((x) => !isIPv4(x) && !/^[0-9a-f:]+$/i.test(x))) e.dns = 'IP addresses, separated by commas.';
  if (!d.endpoint.trim()) e.endpoint = 'Enter the public hostname or IP address clients connect to.';
  else if (!isEndpointHost(d.endpoint)) e.endpoint = 'A hostname or IP address, without a port.';
  return e;
}

export function validateNewServer(
  d: ServerDraft,
  ctx: { network: UciConfig; firewall: UciConfig; taken: { address: string; prefix: number; network: string }[] },
): DraftErrors {
  const e = validateCommon(d, ctx);
  if (!NAME.test(d.name)) e.name = 'Lowercase letters, digits and _, starting with a letter, up to 11 characters.';
  else if (ctx.network[d.name] || sectionsOfType(ctx.network, 'device').some((s) => str(s.name) === d.name)) {
    e.name = `"${d.name}" is already used on this router.`;
  }
  const c = d.cidr.includes('/') ? parseCidr(d.cidr) : null;
  if (!c) e.cidr = 'Address and prefix, e.g. 10.6.0.1/24.';
  else if (c.prefix < 16 || c.prefix > 29) e.cidr = 'Use a prefix between /16 and /29.';
  else {
    const off = hostOffset(c.address, c.address, c.prefix)!;
    const clash = ctx.taken.find((t) => overlaps(c, t));
    if (off === 0 || off === 2 ** (32 - c.prefix) - 1) e.cidr = 'That is the network or broadcast address.';
    else if (clash) e.cidr = `Overlaps ${clash.network} (${clash.address}/${clash.prefix}).`;
  }
  return e;
}

export function validateServerEdit(
  d: Omit<ServerDraft, 'name' | 'cidr'>,
  server: VpnServer,
  ctx: { network: UciConfig; firewall: UciConfig },
): DraftErrors {
  return validateCommon(d, { ...ctx, except: server.iface });
}

// ---------------------------------------------------------------------------
// Server ops

const addFw = (name: string, type: string, values: Record<string, UciValue>): UciOp => ({
  op: 'add',
  config: 'firewall',
  type,
  name,
  values,
});

function chooseZoneName(iface: string, firewall: UciConfig): string {
  const used = new Set(sectionsOfType(firewall, 'zone').map(zoneName));
  return used.has('vpn') ? iface : 'vpn';
}

function portRule(iface: string, port: string, wan: string): Record<string, UciValue> {
  return { name: `netui: WireGuard ${iface}`, src: wan, proto: 'udp', dest_port: port, target: 'ACCEPT' };
}

/** Keep a DMZ off the server's port (or give the port back when null). */
function dmzFollow(iface: string, port: string | null, firewall: UciConfig): UciOp[] {
  const name = fwSection.port(iface);
  const rule = port && { '.name': name, '.type': 'rule', '.anonymous': false, '.index': 1e6, ...portRule(iface, port, wanZoneName(firewall)) };
  return dmzFollowOps(firewall, { [name]: rule || null });
}

/** Access-dependent firewall sections: lan forwarding for full access, DNS to the router otherwise. */
function accessSections(iface: string, zone: string, access: VpnAccess, firewall: UciConfig): UciOp[] {
  const lan = lanZoneName(firewall);
  if (access === 'full' && lan) return [addFw(fwSection.lan(iface), 'forwarding', { src: zone, dest: lan })];
  return [
    addFw(fwSection.dns(iface), 'rule', {
      name: `netui: WireGuard ${iface} DNS`,
      src: zone,
      proto: ['tcp', 'udp'],
      dest_port: '53',
      target: 'ACCEPT',
    }),
  ];
}

/**
 * Create a server. `privateKey` comes from luci.wireguard generateKeyPair.
 *
 * The zone: input ACCEPT for full access (clients reach the router like LAN
 * devices do), REJECT plus a DNS rule for internet-only. dnsmasq answers on
 * the new interface without further config: OpenWrt's default
 * `localservice 1` + `nonwildcard 1` (bind-dynamic, no interface list)
 * serves any directly attached subnet, which the server's /24 is.
 * Masquerading is left to the wan zone.
 */
export function createServerOps(
  d: ServerDraft,
  privateKey: string,
  ctx: { network: UciConfig; firewall: UciConfig },
): UciOp[] {
  const iface = d.name;
  const dns = parseDnsList(d.dns);
  const values: Record<string, UciValue> = {
    proto: 'wireguard',
    private_key: privateKey,
    listen_port: String(Number(d.port)),
    addresses: [d.cidr.trim()],
    netui_endpoint: d.endpoint.trim(),
  };
  if (dns.length) values.netui_dns = dns;
  const zone = chooseZoneName(iface, ctx.firewall);
  const wan = wanZoneName(ctx.firewall);
  return [
    { op: 'add', config: 'network', type: 'interface', name: iface, values },
    // Leftovers from an earlier server of the same name would make the adds fail.
    ...ownedSections(iface)
      .filter((s) => ctx.firewall[s])
      .map((section): UciOp => ({ op: 'delete', config: 'firewall', section })),
    addFw(fwSection.zone(iface), 'zone', {
      name: zone,
      network: [iface],
      input: d.access === 'full' ? 'ACCEPT' : 'REJECT',
      output: 'ACCEPT',
      forward: 'REJECT',
    }),
    addFw(fwSection.wan(iface), 'forwarding', { src: zone, dest: wan }),
    ...accessSections(iface, zone, d.access, ctx.firewall),
    addFw(fwSection.port(iface), 'rule', portRule(iface, String(Number(d.port)), wan)),
    ...dmzFollow(iface, String(Number(d.port)), ctx.firewall),
  ];
}

export function editServerOps(
  server: VpnServer,
  d: Omit<ServerDraft, 'name' | 'cidr'>,
  ctx: { network: UciConfig; firewall: UciConfig },
): UciOp[] {
  const { network, firewall } = ctx;
  const iface = server.iface;
  const port = String(Number(d.port));
  const dns = parseDnsList(d.dns);
  const ops = diffSection('network', iface, network[iface], {
    listen_port: port,
    netui_endpoint: d.endpoint.trim(),
    netui_dns: dns,
  });
  if (!server.managed) return ops;

  const rule = firewall[fwSection.port(iface)];
  const wan = wanZoneName(firewall);
  if (rule) ops.push(...diffSection('firewall', fwSection.port(iface), rule, { dest_port: port }));
  else ops.push(addFw(fwSection.port(iface), 'rule', portRule(iface, port, wan)));
  ops.push(...dmzFollow(iface, port, firewall));

  if (d.access !== server.access) {
    const zoneSection = fwSection.zone(iface);
    const zone = str(firewall[zoneSection]?.name) ?? iface;
    ops.push(
      ...diffSection('firewall', zoneSection, firewall[zoneSection], { input: d.access === 'full' ? 'ACCEPT' : 'REJECT' }),
    );
    for (const s of [fwSection.lan(iface), fwSection.dns(iface)]) {
      if (firewall[s]) ops.push({ op: 'delete', config: 'firewall', section: s });
    }
    ops.push(...accessSections(iface, zone, d.access, firewall));
  }
  return ops;
}

/** Remove the interface, its peers and the firewall sections netui created for it. */
export function deleteServerOps(server: Pick<VpnServer, 'iface'>, ctx: { network: UciConfig; firewall: UciConfig }): UciOp[] {
  const iface = server.iface;
  return [
    ...sectionsOfType(ctx.network, peerType(iface)).map(
      (p): UciOp => ({ op: 'delete', config: 'network', section: p['.name'] }),
    ),
    { op: 'delete', config: 'network', section: iface },
    ...ownedSections(iface)
      .filter((s) => ctx.firewall[s])
      .map((section): UciOp => ({ op: 'delete', config: 'firewall', section })),
    ...dmzFollow(iface, null, ctx.firewall),
  ];
}

// ---------------------------------------------------------------------------
// Peers

/**
 * Force netifd to set the interface up again so peer changes take effect
 * (see the header). Flips mtu between unset and the default; a custom MTU is
 * left alone and fwmark is flipped between unset and 0x0 (no mark) instead.
 * Returns [] when both are customised: the change then waits for the next
 * interface restart, and the UI says so.
 */
export function restartOps(iface: string, network: UciConfig): UciOp[] {
  const s = network[iface];
  const mtu = str(s?.mtu);
  if (mtu === undefined) return [{ op: 'set', config: 'network', section: iface, values: { mtu: WG_DEFAULT_MTU } }];
  if (mtu === WG_DEFAULT_MTU) return [{ op: 'unset', config: 'network', section: iface, options: ['mtu'] }];
  const fwmark = str(s?.fwmark);
  if (fwmark === undefined) return [{ op: 'set', config: 'network', section: iface, values: { fwmark: '0x0' } }];
  if (fwmark === '0x0') return [{ op: 'unset', config: 'network', section: iface, options: ['fwmark'] }];
  return [];
}

export interface NewPeer {
  name: string;
  publicKey: string;
  presharedKey: string;
  address: string;
  keepalive?: string;
}

/** The peer section. The client's private key is deliberately not a parameter. */
export function addPeerOps(iface: string, p: NewPeer, network: UciConfig): UciOp[] {
  const values: Record<string, UciValue> = {
    description: p.name.trim(),
    public_key: p.publicKey,
    preshared_key: p.presharedKey,
    allowed_ips: [`${p.address}/32`],
    route_allowed_ips: '1',
  };
  if (p.keepalive) values.persistent_keepalive = p.keepalive;
  return [{ op: 'add', config: 'network', type: peerType(iface), values }, ...restartOps(iface, network)];
}

export function removePeerOps(iface: string, section: string, network: UciConfig): UciOp[] {
  return [{ op: 'delete', config: 'network', section }, ...restartOps(iface, network)];
}

export function setPeerEnabledOps(iface: string, section: string, enabled: boolean, network: UciConfig): UciOp[] {
  const op: UciOp = enabled
    ? { op: 'unset', config: 'network', section, options: ['disabled'] }
    : { op: 'set', config: 'network', section, values: { disabled: '1' } };
  return [op, ...restartOps(iface, network)];
}

export function validatePeer(d: { name: string; keepalive: string }): Partial<Record<'name' | 'keepalive', string>> {
  const e: Partial<Record<'name' | 'keepalive', string>> = {};
  if (!d.name.trim()) e.name = 'Give the client a name.';
  else if (d.name.length > 64) e.name = 'Up to 64 characters.';
  if (d.keepalive && (!/^\d{1,5}$/.test(d.keepalive) || Number(d.keepalive) < 1 || Number(d.keepalive) > 65535)) {
    e.keepalive = 'Seconds between 1 and 65535, or empty.';
  }
  return e;
}

// ---------------------------------------------------------------------------
// Client configuration

export type Tunnel = 'full' | 'split';

export interface ClientConfig {
  privateKey: string;
  address: string;
  dns: string[];
  serverPublicKey: string;
  presharedKey?: string;
  endpoint: string;
  port: number;
  allowedIps: string[];
  keepalive?: string;
}

/**
 * What the client sends through the tunnel. Full: everything. Split: the VPN
 * subnet (for the router and its DNS) plus, with full access, the local
 * networks behind it.
 */
export function clientAllowedIps(tunnel: Tunnel, server: Pick<VpnServer, 'address' | 'prefix' | 'access'>, local: Subnet[]): string[] {
  if (tunnel === 'full') return ['0.0.0.0/0', '::/0'];
  const out: string[] = [];
  if (server.address && server.prefix !== undefined) out.push(`${networkAddress(server.address, server.prefix)}/${server.prefix}`);
  if (server.access === 'full') for (const s of local) out.push(`${s.address}/${s.prefix}`);
  return [...new Set(out)];
}

export function clientConfigText(c: ClientConfig): string {
  const host = c.endpoint.includes(':') && !c.endpoint.startsWith('[') ? `[${c.endpoint}]` : c.endpoint;
  const lines = ['[Interface]', `PrivateKey = ${c.privateKey}`, `Address = ${c.address}/32`];
  if (c.dns.length) lines.push(`DNS = ${c.dns.join(', ')}`);
  lines.push('', '[Peer]', `PublicKey = ${c.serverPublicKey}`);
  if (c.presharedKey) lines.push(`PresharedKey = ${c.presharedKey}`);
  lines.push(`AllowedIPs = ${c.allowedIps.join(', ')}`, `Endpoint = ${host}:${c.port}`);
  if (c.keepalive) lines.push(`PersistentKeepalive = ${c.keepalive}`);
  return lines.join('\n') + '\n';
}

/** A file name the WireGuard apps accept as a tunnel name (15 chars of [A-Za-z0-9_=+.-]). */
export function confFileName(name: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9_=+.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 15);
  return `${base || 'wireguard'}.conf`;
}
