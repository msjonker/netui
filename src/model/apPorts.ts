// An adopted access point's ports, and carrying the gateway's VLANs to it.
//
// Every network on the gateway's LAN bridge has a VLAN ID, and every access
// point carries all of them: its bridge gets VLAN filtering with the same
// IDs, the link to the gateway (a port, or the mesh through its network_vlan
// list) carries LAN untagged and the rest tagged, and each of the gateway's
// VLAN networks gets an address-less twin on the access point, netui_<name>,
// for its WiFi to join. Which network each other port carries is the access
// point's own setting, read back from its own config every time.
//
// Two port layouts:
//   dsa       ports are netdevs (lan1, wan) and model/ports.ts applies as it is
//             (test/fixtures/ubus/ap/ax3600).
//   swconfig  an older switch chip (test/fixtures/ubus/ap/tl-wdr4300): front
//             ports are switch port numbers in switch_vlan sections. netui
//             writes it in one form: switch VLAN IDs equal network VLAN IDs, and
//             the CPU port (eth0) carries every VLAN tagged into a
//             VLAN-filtering br-lan, so above the switch it looks like DSA. The
//             form adoption leaves (eth0.1 and eth0.2 in a plain br-lan) is read
//             as every port on LAN.

import type { AgentPorts, DeviceStatusMap, UciConfig, UciSection } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { currentPlan, normalizeSwitch, parseMember, sameProfile, switchOps, type PortProfile, type Switch, type SwitchPlan } from './ports';

/** Prefix of the access point's twins of the gateway's VLAN networks. */
export const AP_NET_PREFIX = 'netui_';

export interface GatewayVlans {
  /** VLAN ID of the gateway's LAN. */
  lan: number;
  /** Every VLAN on the gateway's LAN bridge, LAN included, ascending. */
  vlans: { vid: number; networks: string[] }[];
}

export function gatewayVlans(sw: Switch): GatewayVlans {
  return {
    lan: sw.vlans.find((v) => v.networks.includes('lan'))?.vid ?? 1,
    vlans: sw.vlans.map((v) => ({ vid: v.vid, networks: [...v.networks] })),
  };
}

/** The gateway has networks besides the LAN to carry. */
export const hasVlans = (gw: GatewayVlans) => gw.vlans.some((v) => v.vid !== gw.lan);

export interface ApPort {
  /** lan1, wan: the netdev on DSA, the same names from board.json on a switch chip. */
  name: string;
  /** Switch port number (swconfig). */
  num?: number;
  carrier: boolean;
  speed?: number;
  duplex?: 'full' | 'half';
  /** Leads to the gateway: always LAN untagged plus every other VLAN tagged. */
  uplink: boolean;
  /** Native and tagged networks, as the gateway's VLAN IDs. */
  profile: PortProfile;
}

export type ApUnsupported =
  /** No LAN bridge. */
  | 'no-bridge'
  /** Interfaces on the bridge netui cannot place (made by hand). */
  | 'custom'
  /** A switch chip, but netui-agent is too old to describe it. */
  | 'agent'
  /** A switch layout netui does not know (no CPU port, several switches). */
  | 'switch';

/** Why an access point's ports cannot be managed, for messages. */
export const AP_UNSUPPORTED: Record<ApUnsupported, string> = {
  'no-bridge': 'the access point has no LAN bridge.',
  custom: 'its LAN bridge has interfaces made outside netui. Change its ports by hand.',
  agent: 'its netui-agent is too old to describe its switch. Install the current netui-agent on it.',
  switch: 'netui does not know its switch layout. Change its ports by hand.',
};

interface SwitchChip {
  name: string;
  cpu: { num: number; device: string };
  /** switch_vlan sections of this switch, in config order. */
  sections: string[];
  /** bridge-vlan sections of br-lan by VLAN ID. */
  bridgeVlans: Map<number, string>;
}

export interface ApLayout {
  kind: 'dsa' | 'swconfig';
  bridge: string;
  /** The bridge's `config device` section. */
  section: string;
  ports: ApPort[];
  /** VLANs the access point carries now, ascending. A plain bridge is [1]. */
  vids: number[];
  /** The bridge has VLAN filtering (netui has carried VLANs to it). */
  vlanFiltering: boolean;
  /** VLAN ID of the access point's own LAN interface. */
  lan: number;
  /** The gateway is reached over the mesh. */
  meshUplink: boolean;
  unsupported?: ApUnsupported;
  sw?: Switch;
  chip?: SwitchChip;
}

const naturalSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const asc = (a: number, b: number) => a - b;

function lanBridge(network: UciConfig): UciSection | undefined {
  const bridges = sectionsOfType(network, 'device').filter((s) => str(s.type) === 'bridge' && str(s.name));
  const lanDev = str(network.lan?.device) ?? '';
  return bridges.find((b) => str(b.name) === lanDev || lanDev.startsWith(`${str(b.name)}.`)) ?? bridges[0];
}

/** VLAN of the interface `name` on `bridge`: <bridge>.<vid>, or 1 on the bridge itself. */
function vidOn(network: UciConfig, name: string, bridge: string): number | undefined {
  const dev = str(network[name]?.device) ?? '';
  if (dev === bridge) return 1;
  const m = dev.startsWith(`${bridge}.`) ? /^\d+$/.exec(dev.slice(bridge.length + 1)) : null;
  return m ? Number(m[0]) : undefined;
}

export function readApLayout(network: UciConfig, devices: DeviceStatusMap | undefined, agent: AgentPorts | undefined): ApLayout {
  const swSection = sectionsOfType(network, 'switch')[0];
  if (swSection) return readSwitchChip(network, agent, swSection);

  const sw = normalizeSwitch(network, undefined, devices, agent ? { network: agent.network } : undefined);
  const uplink = agent?.uplink ?? undefined;
  const isPort = sw.ports.some((p) => p.name === uplink);
  return {
    kind: 'dsa',
    bridge: sw.bridge,
    section: sw.section,
    ports: sw.ports.map((p) => ({
      name: p.name,
      carrier: p.carrier,
      ...(p.speed !== undefined ? { speed: p.speed } : {}),
      ...(p.duplex ? { duplex: p.duplex } : {}),
      uplink: p.name === uplink,
      profile: p.profile,
    })),
    vids: sw.vlans.map((v) => v.vid),
    vlanFiltering: sw.vlanFiltering,
    lan: sw.vlans.find((v) => v.networks.includes('lan'))?.vid ?? 1,
    meshUplink: !!uplink && !isPort,
    unsupported: sw.unsupported === 'swconfig' ? 'switch' : sw.unsupported,
    sw,
  };
}

function readSwitchChip(network: UciConfig, agent: AgentPorts | undefined, swSection: UciSection): ApLayout {
  const name = str(swSection.name) ?? '';
  const br = lanBridge(network);
  const bridge = str(br?.name) ?? '';
  const base = {
    kind: 'swconfig' as const,
    bridge,
    section: br?.['.name'] ?? '',
    ports: [] as ApPort[],
    vids: [1],
    vlanFiltering: false,
    lan: 1,
    meshUplink: false,
  };
  if (!br) return { ...base, unsupported: 'no-bridge' };
  const board = agent?.switch?.[name];
  if (!agent) return { ...base, unsupported: 'agent' };
  const cpuPort = board?.ports.find((p) => p.device);
  if (!board || !cpuPort || sectionsOfType(network, 'switch').length > 1) return { ...base, unsupported: 'switch' };
  const cpu = { num: cpuPort.num, device: cpuPort.device! };

  const bridgePorts = list(br.ports);
  const bvlans = sectionsOfType(network, 'bridge-vlan')
    .filter((s) => str(s.device) === bridge)
    .map((s) => ({ section: s['.name'], vid: Number(str(s.vlan)), members: list(s.ports).map(parseMember) }));
  const vlanFiltering = bvlans.length > 0;
  const switchVlans = sectionsOfType(network, 'switch_vlan').filter((s) => str(s.device) === name);

  // Where a switch VLAN's traffic lands: the bridge VLAN of the same ID once
  // the CPU port itself is in the bridge; else through <cpu>.<vid>.
  const netVid = (svid: number): number | undefined => {
    if (bridgePorts.includes(cpu.device)) return bvlans.some((b) => b.vid === svid) ? svid : undefined;
    const dev = `${cpu.device}.${svid}`;
    if (!bridgePorts.includes(dev)) return undefined;
    if (!vlanFiltering) return 1;
    return bvlans.find((b) => b.members.some((m) => m.port === dev && !m.tagged))?.vid;
  };
  const members = switchVlans.map((s) => ({
    vid: netVid(Number(str(s.vid) ?? str(s.vlan))),
    ports: list(s.ports).map((t) => ({ num: parseInt(t, 10), tagged: t.endsWith('t') })),
  }));

  const live = agent.switch_state?.name === name ? agent.switch_state : null;
  const ports = board.ports
    .filter((p) => p.role)
    .map((p): ApPort => {
      const mine = members.flatMap((m) => m.ports.filter((x) => x.num === p.num).map((x) => ({ vid: m.vid, tagged: x.tagged })));
      const native = mine.find((m) => !m.tagged && m.vid !== undefined)?.vid;
      const tagged = [...new Set(mine.filter((m) => m.tagged && m.vid !== undefined && m.vid !== native).map((m) => m.vid!))].sort(asc);
      const state = live?.ports.find((x) => x.num === p.num);
      return {
        name: p.role === 'lan' && p.index ? `lan${p.index}` : p.role!,
        num: p.num,
        carrier: !!state?.up,
        ...(state?.speed ? { speed: state.speed } : {}),
        ...(state?.duplex ? { duplex: state.duplex } : {}),
        uplink: live?.uplink === p.num,
        profile: native !== undefined ? { native, tagged } : { tagged },
      };
    })
    .sort((a, b) => naturalSort(a.name, b.name));

  // Interfaces on the bridge outside the VLANs this model knows.
  const vids = vlanFiltering ? bvlans.map((b) => b.vid).sort(asc) : [1];
  const strays = sectionsOfType(network, 'interface').filter((i) => {
    const dev = str(i.device) ?? '';
    if (dev !== bridge && !dev.startsWith(`${bridge}.`)) return false;
    const vid = vidOn(network, i['.name'], bridge);
    return vlanFiltering ? dev === bridge || vid === undefined || !vids.includes(vid) : dev !== bridge;
  });

  return {
    ...base,
    ports,
    vids,
    vlanFiltering,
    lan: vidOn(network, 'lan', bridge) ?? 1,
    meshUplink: !!agent.uplink && !agent.uplink.startsWith(cpu.device) && !live?.uplink,
    ...(strays.length ? { unsupported: 'custom' as const } : {}),
    chip: {
      name,
      cpu,
      sections: switchVlans.map((s) => s['.name']),
      bridgeVlans: new Map(bvlans.map((b) => [b.vid, b.section])),
    },
  };
}

// ---------------------------------------------------------------------------
// Writing

/** UCI ops giving every port of `ap` its profile in `profiles`, carrying exactly `vids`. */
function layoutOps(ap: ApLayout, profiles: Record<string, PortProfile>, vids: number[], lan: number, network: UciConfig): UciOp[] {
  if (ap.kind === 'dsa') {
    const sw = ap.sw!;
    const old = currentPlan(sw);
    const plan: SwitchPlan = {
      // A plain bridge's implicit VLAN 1 is the LAN, whatever ID it gets.
      vlans: vids.map((vid) => {
        const from = vid === lan ? ap.lan : vid === ap.lan ? undefined : vid;
        const was = sw.vlans.find((v) => v.vid === from);
        const networks = (was?.networks ?? []).filter((n) => !n.startsWith(AP_NET_PREFIX));
        return { vid, ...(was?.section && was.vid === vid ? { section: was.section } : {}), networks };
      }),
      profiles: { ...old.profiles, ...profiles },
    };
    // Sections of VLANs that were renumbered or dropped are deleted by switchOps.
    return switchOps(sw, plan, network);
  }

  const chip = ap.chip!;
  const plain =
    !ap.vlanFiltering &&
    vids.length === 1 &&
    vids[0] === 1 &&
    Object.values(profiles).every((p) => p.tagged.length === 0 && (p.native === undefined || p.native === 1));
  if (plain) return [];

  const ops: UciOp[] = [];
  const byNum = [...ap.ports].sort((a, b) => a.num! - b.num!);
  // Switch VLANs: reuse sections in order, add or delete the difference.
  vids.forEach((vid, i) => {
    const tokens = byNum.flatMap((p) => {
      const pr = profiles[p.name] ?? p.profile;
      return pr.native === vid ? [`${p.num}`] : pr.tagged.includes(vid) ? [`${p.num}t`] : [];
    });
    const values = { device: chip.name, vlan: String(i + 1), vid: String(vid), ports: [...tokens, `${chip.cpu.num}t`].join(' ') };
    const section = chip.sections[i];
    if (section) ops.push(...diffSection('network', section, network[section], values));
    else ops.push({ op: 'add', config: 'network', type: 'switch_vlan', values });
  });
  for (const section of chip.sections.slice(vids.length)) ops.push({ op: 'delete', config: 'network', section });

  // Above the switch: the CPU port, tagged in every VLAN of a filtering br-lan.
  const others = list(network[ap.section]?.ports).filter((p) => p !== chip.cpu.device && !p.startsWith(`${chip.cpu.device}.`));
  ops.push(...diffSection('network', ap.section, network[ap.section], { ports: [chip.cpu.device, ...others] }));
  for (const vid of vids) {
    const values = { device: ap.bridge, vlan: String(vid), ports: [`${chip.cpu.device}:t`] };
    const section = chip.bridgeVlans.get(vid);
    if (section) ops.push(...diffSection('network', section, network[section], values));
    else ops.push({ op: 'add', config: 'network', type: 'bridge-vlan', values });
  }
  for (const [vid, section] of chip.bridgeVlans) if (!vids.includes(vid)) ops.push({ op: 'delete', config: 'network', section });
  if (network.lan) ops.push(...diffSection('network', 'lan', network.lan, { device: `${ap.bridge}.${lan}` }));
  return ops;
}

/** The access point's twins of the gateway's VLAN networks: netui_<name> on <bridge>.<vid>. */
function twinOps(ap: ApLayout, gw: GatewayVlans, network: UciConfig, carried: boolean): UciOp[] {
  const want = new Map<string, string>();
  if (carried) {
    for (const v of gw.vlans) {
      if (v.vid === gw.lan) continue;
      for (const n of v.networks) want.set(`${AP_NET_PREFIX}${n}`, `${ap.bridge}.${v.vid}`);
    }
  }
  const ops: UciOp[] = [];
  for (const s of sectionsOfType(network, 'interface')) {
    if (s['.name'].startsWith(AP_NET_PREFIX) && !want.has(s['.name'])) ops.push({ op: 'delete', config: 'network', section: s['.name'] });
  }
  for (const [name, device] of want) {
    if (network[name]) ops.push(...diffSection('network', name, network[name], { proto: 'none', device }));
    else ops.push({ op: 'add', config: 'network', type: 'interface', name, values: { proto: 'none', device } });
  }
  return ops;
}

/**
 * Ops that make the access point carry the gateway's VLANs (and no others).
 * Port choices stay: a VLAN new to the access point goes tagged on every port
 * whose native network is LAN; a port on a VLAN the gateway dropped carries
 * nothing (as on the gateway); the uplink always carries everything.
 * Nothing when the gateway has only its LAN and the access point never
 * carried more.
 */
export function apSyncOps(ap: ApLayout, gw: GatewayVlans, network: UciConfig): UciOp[] {
  if (ap.unsupported) return [];
  const want = gw.vlans.map((v) => v.vid);
  if (!hasVlans(gw) && !ap.vlanFiltering) return twinOps(ap, gw, network, false);

  // The access point's LAN is the gateway's LAN, whatever its ID was.
  const map = (vid: number) => (vid === ap.lan ? gw.lan : vid);
  const current = ap.vids.map(map);
  const added = want.filter((v) => !current.includes(v));
  const profiles: Record<string, PortProfile> = {};
  for (const p of ap.ports) {
    let native = p.profile.native === undefined ? undefined : map(p.profile.native);
    if (native !== undefined && !want.includes(native)) native = undefined;
    let tagged = p.profile.tagged.map(map).filter((v) => want.includes(v) && v !== native);
    if (native === gw.lan) tagged = [...tagged, ...added.filter((v) => v !== native)];
    if (p.uplink) {
      native = gw.lan;
      tagged = want.filter((v) => v !== gw.lan);
    }
    tagged = [...new Set(tagged)].sort(asc);
    profiles[p.name] = native === undefined ? { tagged } : { native, tagged };
  }
  return [...layoutOps(ap, profiles, want, gw.lan, network), ...twinOps(ap, gw, network, true)];
}

/** Ops for port changes made in the access point's panel. */
export function apPortOps(ap: ApLayout, profiles: Record<string, PortProfile>, network: UciConfig): UciOp[] {
  const changed = Object.fromEntries(
    Object.entries(profiles).filter(([name, pr]) => {
      const p = ap.ports.find((x) => x.name === name);
      return p && !sameProfile(p.profile, pr);
    }),
  );
  if (!Object.keys(changed).length) return [];
  return layoutOps(ap, changed, ap.vids, ap.lan, network);
}

/** The gateway's mesh interface carries every VLAN but the LAN's, tagged ("10:t"). */
export function meshVlanList(gw: GatewayVlans): string[] {
  return gw.vlans.filter((v) => v.vid !== gw.lan).map((v) => `${v.vid}:t`);
}

/**
 * Ops that make the gateway's mesh interface (`section` in wireless) carry the
 * VLANs in `gw`. The gateway's sync copies the list to access points with the
 * rest of the mesh settings.
 */
export function meshVlanOps(wireless: UciConfig | undefined, section: string, gw: GatewayVlans): UciOp[] {
  const s = wireless?.[section];
  if (!s) return [];
  return diffSection('wireless', section, s, { network_vlan: meshVlanList(gw) });
}

/** `gw` with VLAN `vid` added (an empty network list for a bare VLAN). */
export function withVlan(gw: GatewayVlans, vid: number, networks: string[] = []): GatewayVlans {
  return { ...gw, vlans: [...gw.vlans.filter((v) => v.vid !== vid), { vid, networks }].sort((a, b) => a.vid - b.vid) };
}

export function withoutVlan(gw: GatewayVlans, vid: number): GatewayVlans {
  return { ...gw, vlans: gw.vlans.filter((v) => v.vid !== vid) };
}
