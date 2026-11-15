// The router as a WireGuard client of a VPN service, set up from the
// provider's .conf file. Checked by hand on the DL-WRX36 against a test server
// before this was written:
//
//   network.vpnclient              proto wireguard, private_key, addresses,
//                                  netui_dns (the file's DNS), dns (= netui_dns,
//                                  all devices only), mtu (if the file has one)
//   network.netui_vpnclient_peer   wireguard_vpnclient: public_key,
//                                  preshared_key, endpoint_host/port,
//                                  allowed_ips 0.0.0.0/0 (+ ::/0),
//                                  route_allowed_ips, persistent_keepalive
//   firewall.netui_vpnclient_zone  masq + mtu_fix, input REJECT
//   firewall.netui_vpnclient_lan   forwarding lan -> vpnclient
//
// All devices: route_allowed_ips 1 puts a metric 0 default route on the
// tunnel, ahead of the WAN's; wireguard.sh adds a host route to the endpoint
// through the WAN (unless nohostroute), so the tunnel does not loop.
// Chosen devices: route_allowed_ips 0, a default route in table 51
// (netui_vpnclient_route) and one `rule` per device (netui_vpnclient_dev<n>,
// src <ip>/32 lookup 51). Their DNS still goes to the router.
// Kill switch: firewall.netui_vpnclient_kill rejects lan -> wan (all devices,
// or the chosen devices by MAC, which covers their IPv6 too): when the tunnel
// is down the traffic falls back to the WAN and is refused there.
//
// netifd only sets a WireGuard interface up again for proto option changes,
// so a mode change also flips mtu (restartOps, as for the server). netifd
// loads protocol handlers when it starts: right after installing WireGuard
// the interface stays at proto "none" until the network restarts.

import type { InterfaceDump, UciConfig, UciValue, WgInstances } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { parseCidr } from '../lib/ip';
import { wanZoneName } from './network';
import { normalizePeerLive, restartOps, type PeerLive } from './vpn';

export const CLIENT_IFACE = 'vpnclient';
export const CLIENT_TABLE = '51';

export const clientSection = {
  peer: 'netui_vpnclient_peer',
  route: 'netui_vpnclient_route',
  device: (n: number) => `netui_vpnclient_dev${n}`,
  zone: 'netui_vpnclient_zone',
  lan: 'netui_vpnclient_lan',
  kill: 'netui_vpnclient_kill',
};

// ---------------------------------------------------------------------------
// The provider's file

export interface WgConf {
  privateKey: string;
  addresses: string[];
  dns: string[];
  mtu?: string;
  publicKey: string;
  presharedKey?: string;
  endpointHost: string;
  endpointPort: string;
  keepalive?: string;
  /** The file routes IPv6 too (::/0 and an IPv6 address). */
  ipv6: boolean;
}

const isKey = (v: string | undefined) => !!v && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/.test(v);

/** Read a WireGuard .conf as providers hand them out: one [Interface], one [Peer], all traffic. */
export function parseWgConf(text: string): WgConf | { error: string } {
  const sections: Record<string, string>[] = [];
  let names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s*[#;].*$/, '').trim();
    if (!line) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) {
      names = [...names, head[1]!.toLowerCase()];
      sections.push({});
      continue;
    }
    const kv = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!kv || !sections.length)
      return { error: `Not a WireGuard configuration file (at "${raw.trim().slice(0, 40)}").` };
    const cur = sections[sections.length - 1]!;
    const key = kv[1]!.toLowerCase();
    cur[key] = cur[key] ? `${cur[key]}, ${kv[2]}` : kv[2]!;
  }
  const iface = sections[names.indexOf('interface')];
  const peers = sections.filter((_, i) => names[i] === 'peer');
  if (!iface || peers.length === 0)
    return { error: 'Not a WireGuard configuration file: it needs an [Interface] and a [Peer] section.' };
  if (peers.length > 1) return { error: 'This file has more than one [Peer]. Use a file for a single server.' };
  const peer = peers[0]!;
  const split = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const addresses = split(iface.address);
  const allowed = split(peer.allowedips);
  const ep = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(peer.endpoint?.trim() ?? '');
  if (!isKey(iface.privatekey)) return { error: 'The [Interface] PrivateKey is missing or not a WireGuard key.' };
  if (!isKey(peer.publickey)) return { error: 'The [Peer] PublicKey is missing or not a WireGuard key.' };
  if (peer.presharedkey && !isKey(peer.presharedkey)) return { error: 'The PresharedKey is not a WireGuard key.' };
  if (!addresses.some((a) => parseCidr(a))) return { error: 'The [Interface] has no IPv4 Address.' };
  if (!ep || Number(ep[3]) > 65535) return { error: 'The [Peer] Endpoint must be host:port.' };
  if (!allowed.includes('0.0.0.0/0')) {
    return { error: 'This file does not send all traffic through the VPN (AllowedIPs has no 0.0.0.0/0).' };
  }
  return {
    privateKey: iface.privatekey!,
    addresses,
    dns: split(iface.dns),
    mtu: iface.mtu && /^\d{3,4}$/.test(iface.mtu) ? iface.mtu : undefined,
    publicKey: peer.publickey!,
    presharedKey: peer.presharedkey || undefined,
    endpointHost: ep[1] ?? ep[2]!,
    endpointPort: ep[3]!,
    keepalive:
      peer.persistentkeepalive && /^\d+$/.test(peer.persistentkeepalive) ? peer.persistentkeepalive : undefined,
    ipv6: allowed.includes('::/0') && addresses.some((a) => a.includes(':')),
  };
}

// ---------------------------------------------------------------------------
// What is on the router

export type ClientMode = 'all' | 'some';

export interface VpnClient {
  enabled: boolean;
  up: boolean;
  endpoint: string;
  address?: string;
  mode: ClientMode;
  /** Chosen devices' IPv4 addresses (mode 'some'). */
  devices: string[];
  /** Configured; its rule is switched off with the service. */
  killSwitch: boolean;
  live?: PeerLive;
}

export function normalizeVpnClient(
  network: UciConfig,
  firewall: UciConfig | undefined,
  dump: InterfaceDump | undefined,
  wg: WgInstances | undefined,
  nowS: number,
): VpnClient | undefined {
  const s = network[CLIENT_IFACE];
  const peer = network[clientSection.peer];
  if (!s || str(s.proto) !== 'wireguard' || !peer) return undefined;
  const status = wg?.[CLIENT_IFACE]?.peers.find((p) => p.public_key === str(peer.public_key));
  const kill = firewall?.[clientSection.kill];
  const host = str(peer.endpoint_host) ?? '';
  return {
    enabled: !bool(s.disabled, false),
    up: dump?.interface.find((i) => i.interface === CLIENT_IFACE)?.up ?? false,
    endpoint: host.includes(':') ? `[${host}]:${str(peer.endpoint_port)}` : `${host}:${str(peer.endpoint_port)}`,
    address: list(s.addresses)
      .find((a) => parseCidr(a))
      ?.split('/')[0],
    mode: bool(peer.route_allowed_ips, false) ? 'all' : 'some',
    devices: sectionsOfType(network, 'rule')
      .filter((r) => r['.name'].startsWith('netui_vpnclient_dev'))
      .map((r) => (str(r.src) ?? '').replace(/\/32$/, ''))
      .filter(Boolean),
    killSwitch: !!kill,
    live: status && normalizePeerLive(status, nowS),
  };
}

// ---------------------------------------------------------------------------
// Changes

export interface ClientDraft {
  enabled: boolean;
  mode: ClientMode;
  /** Chosen devices (mode 'some'). The MAC lets the kill switch cover IPv6. */
  devices: { ip: string; mac?: string }[];
  killSwitch: boolean;
}

export function clientDraft(c: VpnClient, macOf: (ip: string) => string | undefined): ClientDraft {
  return {
    enabled: c.enabled,
    mode: c.mode,
    devices: c.devices.map((ip) => ({ ip, mac: macOf(ip) })),
    killSwitch: c.killSwitch,
  };
}

export function validateClient(d: ClientDraft): string | undefined {
  if (d.mode === 'some' && d.devices.length === 0) return 'Choose at least one device.';
  return undefined;
}

function lanZone(firewall: UciConfig): string {
  const z = sectionsOfType(firewall, 'zone').find((x) => list(x.network).includes('lan'));
  return (z && str(z.name)) ?? 'lan';
}

type Wanted = Record<string, { config: 'network' | 'firewall'; type: string; values: Record<string, UciValue> }>;

/** Routing and kill switch sections for the draft (the parts that differ between modes). */
function modeSections(d: ClientDraft, firewall: UciConfig): Wanted {
  const out: Wanted = {};
  if (d.mode === 'some') {
    out[clientSection.route] = {
      config: 'network',
      type: 'route',
      values: { interface: CLIENT_IFACE, target: '0.0.0.0/0', table: CLIENT_TABLE },
    };
    d.devices.forEach((x, i) => {
      out[clientSection.device(i)] = {
        config: 'network',
        type: 'rule',
        values: { src: `${x.ip}/32`, lookup: CLIENT_TABLE },
      };
    });
  }
  if (d.killSwitch) {
    const values: Record<string, UciValue> = {
      name: 'netui: VPN kill switch',
      src: lanZone(firewall),
      dest: wanZoneName(firewall),
      proto: 'all',
      target: 'REJECT',
    };
    if (d.mode === 'some') {
      const macs = d.devices.map((x) => x.mac).filter((m): m is string => !!m);
      // A device without a known MAC is matched by address (IPv4 only).
      if (macs.length === d.devices.length) values.src_mac = macs;
      else values.src_ip = d.devices.map((x) => x.ip);
    }
    if (!d.enabled) values.enabled = '0';
    out[clientSection.kill] = { config: 'firewall', type: 'rule', values };
  }
  return out;
}

/** Names of the mode sections on the router now. */
function currentModeSections(
  network: UciConfig,
  firewall: UciConfig,
): { config: 'network' | 'firewall'; name: string }[] {
  return [
    ...Object.keys(network)
      .filter((n) => n === clientSection.route || n.startsWith('netui_vpnclient_dev'))
      .map((name) => ({ config: 'network' as const, name })),
    ...(firewall[clientSection.kill] ? [{ config: 'firewall' as const, name: clientSection.kill }] : []),
  ];
}

/** Bring the router's sections in line with `wanted`: add, change (every option) or delete. */
function sync(
  wanted: Wanted,
  current: { config: 'network' | 'firewall'; name: string }[],
  ctx: { network: UciConfig; firewall: UciConfig },
): UciOp[] {
  const ops: UciOp[] = current
    .filter((c) => !wanted[c.name])
    .map((c): UciOp => ({ op: 'delete', config: c.config, section: c.name }));
  for (const [name, w] of Object.entries(wanted)) {
    const before = ctx[w.config][name];
    if (!before || before['.type'] !== w.type) {
      if (before) ops.push({ op: 'delete', config: w.config, section: name });
      ops.push({ op: 'add', config: w.config, type: w.type, name, values: w.values });
      continue;
    }
    const keys = Object.keys(before).filter((k) => !k.startsWith('.'));
    ops.push(
      ...diffSection(w.config, name, before, { ...Object.fromEntries(keys.map((k) => [k, undefined])), ...w.values }),
    );
  }
  return ops;
}

export function createClientOps(
  conf: WgConf,
  d: ClientDraft,
  ctx: { network: UciConfig; firewall: UciConfig },
): UciOp[] {
  const iface: Record<string, UciValue> = {
    proto: 'wireguard',
    private_key: conf.privateKey,
    addresses: conf.addresses,
  };
  if (conf.dns.length) {
    iface.netui_dns = conf.dns;
    if (d.mode === 'all') iface.dns = conf.dns;
  }
  if (conf.mtu) iface.mtu = conf.mtu;
  if (!d.enabled) iface.disabled = '1';
  const peer: Record<string, UciValue> = {
    description: 'VPN service',
    public_key: conf.publicKey,
    endpoint_host: conf.endpointHost,
    endpoint_port: conf.endpointPort,
    allowed_ips: conf.ipv6 ? ['0.0.0.0/0', '::/0'] : ['0.0.0.0/0'],
    route_allowed_ips: d.mode === 'all' ? '1' : '0',
    persistent_keepalive: conf.keepalive ?? '25',
  };
  if (conf.presharedKey) peer.preshared_key = conf.presharedKey;
  const add = (
    config: 'network' | 'firewall',
    name: string,
    type: string,
    values: Record<string, UciValue>,
  ): UciOp => ({
    op: 'add',
    config,
    type,
    name,
    values,
  });
  return [
    // Replacing an earlier setup: start from nothing.
    ...deleteClientOps(ctx),
    add('network', CLIENT_IFACE, 'interface', iface),
    add('network', clientSection.peer, `wireguard_${CLIENT_IFACE}`, peer),
    add('firewall', clientSection.zone, 'zone', {
      name: CLIENT_IFACE,
      network: [CLIENT_IFACE],
      input: 'REJECT',
      output: 'ACCEPT',
      forward: 'REJECT',
      masq: '1',
      mtu_fix: '1',
    }),
    add('firewall', clientSection.lan, 'forwarding', { src: lanZone(ctx.firewall), dest: CLIENT_IFACE }),
    ...Object.entries(modeSections(d, ctx.firewall)).map(([name, w]) => add(w.config, name, w.type, w.values)),
  ];
}

/** Mode, devices, kill switch and on/off for an existing setup. */
export function editClientOps(c: VpnClient, d: ClientDraft, ctx: { network: UciConfig; firewall: UciConfig }): UciOp[] {
  const ops = sync(modeSections(d, ctx.firewall), currentModeSections(ctx.network, ctx.firewall), ctx);
  const s = ctx.network[CLIENT_IFACE];
  if (d.enabled !== c.enabled) {
    ops.push(
      d.enabled
        ? { op: 'unset', config: 'network', section: CLIENT_IFACE, options: ['disabled'] }
        : { op: 'set', config: 'network', section: CLIENT_IFACE, values: { disabled: '1' } },
    );
  }
  if (d.mode !== c.mode) {
    ops.push({
      op: 'set',
      config: 'network',
      section: clientSection.peer,
      values: { route_allowed_ips: d.mode === 'all' ? '1' : '0' },
    });
    // The provider's DNS is only reachable through the tunnel: all devices only.
    const dns = list(s?.netui_dns);
    if (d.mode === 'all' && dns.length)
      ops.push({ op: 'set', config: 'network', section: CLIENT_IFACE, values: { dns } });
    if (d.mode === 'some' && s?.dns)
      ops.push({ op: 'unset', config: 'network', section: CLIENT_IFACE, options: ['dns'] });
    ops.push(...restartOps(CLIENT_IFACE, ctx.network));
  }
  return ops;
}

export function deleteClientOps(ctx: { network: UciConfig; firewall: UciConfig }): UciOp[] {
  return [
    ...[CLIENT_IFACE, clientSection.peer]
      .filter((n) => ctx.network[n])
      .map((n): UciOp => ({ op: 'delete', config: 'network', section: n })),
    ...currentModeSections(ctx.network, ctx.firewall).map((c): UciOp => ({
      op: 'delete',
      config: c.config,
      section: c.name,
    })),
    ...[clientSection.zone, clientSection.lan]
      .filter((n) => ctx.firewall[n])
      .map((n): UciOp => ({ op: 'delete', config: 'firewall', section: n })),
  ];
}
