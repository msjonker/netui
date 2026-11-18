// Creating and deleting VLAN networks: one form makes the
// interface on <bridge>.<vid>, its bridge-vlan, its DHCP pool and its firewall
// placement. A network with no firewall zone gets fw4's default input policy
// (REJECT), which blocks DHCP and DNS from its clients (seen on the VM), so a
// zone is not optional.

import type { UciConfig, UciValue } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { hostOffset, networkAddress } from '../lib/ip';
import { validateNetwork, wanNetworks, wanZoneName, type NetworkDraft, type Subnet } from './network';
import { currentPlan, inUse, removeVlanPlan, renumberPlan, switchOps, validateVid, vlanOf, type Switch } from './ports';
import { gatewayVlans, meshVlanOps, withoutVlan, withVlan } from './apPorts';
import { MESH_SECTION } from './mesh';

export type Isolation = 'trusted' | 'isolated';

export interface NewNetworkDraft extends NetworkDraft {
  name: string;
  vid: string;
  /** trusted: joins the LAN zone. isolated: own zone, internet only. */
  isolation: Isolation;
  /** Carry the new VLAN tagged on every port already in the bridge. */
  allPorts: boolean;
}

export function newNetworkDraft(sw: Switch, subnets: Subnet[]): NewNetworkDraft {
  const used = sw.vlans.map((v) => v.vid);
  const vid = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].find((v) => !used.includes(v)) ?? 2;
  // A /24 in 192.168.<vid>.0 unless that clashes; the user will usually type their own.
  const third = subnets.some((s) => s.address === `192.168.${vid}.0`) ? 200 + (vid % 50) : vid;
  return {
    name: '',
    vid: String(vid),
    address: `192.168.${third}.1`,
    prefix: 24,
    dhcpEnabled: true,
    rangeStart: `192.168.${third}.100`,
    rangeEnd: `192.168.${third}.249`,
    leasetime: '12h',
    isolation: 'trusted',
    allPorts: true,
  };
}

/** UCI section names double as fw4 zone names, which are limited to 11 characters. */
const NAME = /^[a-z][a-z0-9_]{0,10}$/;

export function validateNewNetwork(
  d: NewNetworkDraft,
  ctx: { sw: Switch; network: UciConfig; dhcp: UciConfig; firewall: UciConfig; others: Subnet[] },
): Partial<Record<keyof NewNetworkDraft, string>> {
  const e: Partial<Record<keyof NewNetworkDraft, string>> = validateNetwork(d, ctx.others);
  if (!NAME.test(d.name)) e.name = 'Lowercase letters, digits and _, starting with a letter, up to 11 characters.';
  else if (ctx.network[d.name] || ctx.dhcp[d.name] || zoneNames(ctx.firewall).includes(d.name))
    e.name = `"${d.name}" is already used on this router.`;
  const vidError = validateVid(d.vid, ctx.sw.vlans.map((v) => v.vid));
  if (vidError) e.vid = vidError;
  return e;
}

function zoneNames(fw: UciConfig): string[] {
  return sectionsOfType(fw, 'zone').map((z) => str(z.name) ?? z['.name']);
}

/** The zone trusted networks join: the one holding "lan", else the one named lan. */
function lanZone(fw: UciConfig) {
  const zs = sectionsOfType(fw, 'zone');
  return zs.find((z) => list(z.network).includes('lan')) ?? zs.find((z) => str(z.name) === 'lan');
}

export function createNetworkOps(
  d: NewNetworkDraft,
  ctx: { sw: Switch; network: UciConfig; firewall: UciConfig; wireless?: UciConfig },
): UciOp[] {
  const { sw, network, firewall } = ctx;
  const vid = Number(d.vid);
  const plan = currentPlan(sw);
  plan.vlans.push({ vid, networks: [] });
  if (d.allPorts) {
    for (const pr of Object.values(plan.profiles)) {
      if (inUse(pr)) pr.tagged = [...pr.tagged, vid].sort((a, b) => a - b);
    }
  }
  const ops: UciOp[] = [
    ...switchOps(sw, plan, network),
    {
      op: 'add',
      config: 'network',
      type: 'interface',
      name: d.name,
      values: { proto: 'static', device: `${sw.bridge}.${vid}`, ipaddr: [`${d.address}/${d.prefix}`] },
    },
  ];

  if (d.dhcpEnabled) {
    const net = networkAddress(d.address, d.prefix)!;
    const start = hostOffset(d.rangeStart, net, d.prefix)!;
    const end = hostOffset(d.rangeEnd, net, d.prefix)!;
    ops.push({
      op: 'add',
      config: 'dhcp',
      type: 'dhcp',
      name: d.name,
      values: { interface: d.name, start: String(start), limit: String(end - start + 1), leasetime: d.leasetime },
    });
  }

  const lan = lanZone(firewall);
  if (d.isolation === 'trusted' && lan) {
    ops.push(...diffSection('firewall', lan['.name'], lan, { network: [...list(lan.network), d.name] }));
  } else {
    ops.push(...isolatedZoneOps(d.name, wanZoneName(firewall)));
  }
  // Access points on the mesh get the new network through it.
  ops.push(...meshVlanOps(ctx.wireless, MESH_SECTION, withVlan(gatewayVlans(sw), vid, [d.name])));
  return ops;
}

/**
 * A zone for one network: no access to the router except DHCP and DNS, no
 * forwarding to other networks, forwarding to the internet.
 */
function isolatedZoneOps(name: string, wanZone: string): UciOp[] {
  const add = (type: string, values: Record<string, UciValue>): UciOp => ({ op: 'add', config: 'firewall', type, values });
  return [
    add('zone', { name, network: [name], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' }),
    add('forwarding', { src: name, dest: wanZone }),
    add('rule', { name: `Allow-${name}-DHCP`, src: name, proto: 'udp', dest_port: '67-68', target: 'ACCEPT', family: 'ipv4' }),
    add('rule', { name: `Allow-${name}-DNS`, src: name, proto: ['tcp', 'udp'], dest_port: '53', target: 'ACCEPT' }),
  ];
}

/** Firewall placement of a network, for display. */
export function isolationOf(id: string, fw: UciConfig | undefined): Isolation | 'other' | undefined {
  if (!fw) return undefined;
  const z = sectionsOfType(fw, 'zone').find((z) => list(z.network).includes(id));
  if (!z) return undefined;
  if (z === lanZone(fw)) return 'trusted';
  return str(z.name) === id && str(z.input) !== 'ACCEPT' ? 'isolated' : 'other';
}

/** Why a network cannot be deleted here, or null. */
export function deleteBlocker(
  id: string,
  ctx: { sw: Switch; firewall: UciConfig | undefined; wireless: UciConfig | undefined; viaThis: boolean },
): string | null {
  if (id === 'lan') return 'The LAN network cannot be deleted here.';
  if (ctx.viaThis) return 'You are connected through this network.';
  if (wanNetworks(ctx.firewall).has(id)) return 'This is an internet uplink.';
  const wifi = sectionsOfType(ctx.wireless ?? {}, 'wifi-iface').filter((w) => list(w.network).includes(id));
  if (wifi.length) {
    return `Used by WiFi network ${wifi.map((w) => `"${str(w.ssid) ?? w['.name']}"`).join(', ')}. Move or delete it first.`;
  }
  return null;
}

/**
 * Remove a network with everything netui would have created for it: its DHCP
 * pool, its VLAN (if no other interface shares it) and its firewall zone (if
 * the zone was its own), plus rules that name that zone.
 */
export function deleteNetworkOps(
  id: string,
  ctx: { sw: Switch; network: UciConfig; dhcp: UciConfig; firewall: UciConfig; wireless?: UciConfig },
): UciOp[] {
  const { sw, network, dhcp, firewall } = ctx;
  const ops: UciOp[] = [];
  const v = vlanOf(sw, id);
  if (v && v.section && v.networks.length === 1) {
    ops.push(...switchOps(sw, removeVlanPlan(currentPlan(sw), v.vid), network));
    ops.push(...meshVlanOps(ctx.wireless, MESH_SECTION, withoutVlan(gatewayVlans(sw), v.vid)));
  }
  ops.push({ op: 'delete', config: 'network', section: id });
  for (const p of sectionsOfType(dhcp, 'dhcp')) {
    if (str(p.interface) === id) ops.push({ op: 'delete', config: 'dhcp', section: p['.name'] });
  }
  for (const z of sectionsOfType(firewall, 'zone')) {
    const nets = list(z.network);
    if (!nets.includes(id)) continue;
    const rest = nets.filter((n) => n !== id);
    const name = str(z.name);
    if (rest.length === 0 && name === id) {
      ops.push({ op: 'delete', config: 'firewall', section: z['.name'] });
      for (const s of Object.values(firewall)) {
        if (['forwarding', 'rule', 'redirect'].includes(s['.type']) && (str(s.src) === name || str(s.dest) === name)) {
          ops.push({ op: 'delete', config: 'firewall', section: s['.name'] });
        }
      }
    } else {
      ops.push(...diffSection('firewall', z['.name'], z, { network: rest }));
    }
  }
  return ops;
}

/** Move a network's VLAN to a new ID; ports and the mesh keep carrying it. */
export function renumberOps(sw: Switch, from: number, to: number, network: UciConfig, wireless?: UciConfig): UciOp[] {
  const gw = gatewayVlans(sw);
  const moved = withVlan(withoutVlan(gw, from), to, gw.vlans.find((v) => v.vid === from)?.networks);
  return [
    ...switchOps(sw, renumberPlan(currentPlan(sw), from, to), network),
    ...meshVlanOps(wireless, MESH_SECTION, from === gw.lan ? { ...moved, lan: to } : moved),
  ];
}
