// Physical ports and the VLANs on the LAN bridge, presented simply: each
// network has a VLAN ID, each port has one native (untagged) network and a set
// of tagged ones. Read from UCI (`config device` type bridge, `config
// bridge-vlan`, interfaces on `<bridge>.<vid>`) plus live link state.
//
// UCI port tokens on 25.12 (recorded in test/fixtures/ubus/vm/vlan):
//   "eth0:u*"  untagged, PVID          "eth2:t"   tagged
//   "eth3"     untagged, no PVID ...   "eth2:t*"  tagged, PVID
// ... except that a port untagged in exactly one VLAN gets that VLAN as its
// PVID anyway. netui writes only ":u*" (native) and ":t" (tagged).
//
// A plain bridge (no bridge-vlan sections) is modelled as one implicit VLAN 1
// with every bridge port native in it, which is also what converting it to
// VLAN filtering produces (the same thing LuCI does).

import type { BoardJson, DeviceStatusMap, UciConfig } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { parseSpeed, wanNetworks } from './network';

export interface Member {
  port: string;
  tagged: boolean;
  /** Explicit "*". */
  pvid: boolean;
  /** The token as stored, written back unchanged when the port is not edited. */
  token: string;
}

export function parseMember(token: string): Member {
  const [port = '', flags = ''] = token.split(':');
  return { port, tagged: flags.includes('t'), pvid: flags.includes('*'), token };
}

export interface Vlan {
  vid: number;
  /** bridge-vlan section; undefined for the implicit VLAN of a plain bridge. */
  section?: string;
  members: Member[];
  /** Interfaces whose device is <bridge>.<vid> (or the bridge itself, for the implicit VLAN). */
  networks: string[];
}

export interface PortProfile {
  /** VLAN ID of the native (untagged) network. */
  native?: number;
  /** VLAN IDs carried tagged, ascending. */
  tagged: number[];
  /**
   * VLANs sent untagged without being the PVID (a bare "eth3" next to an
   * "eth3:u*" elsewhere). netui never creates these but keeps them until the
   * user removes them.
   */
  untagged?: number[];
}

export interface SwitchPort {
  name: string;
  carrier: boolean;
  speed?: number;
  duplex?: 'full' | 'half';
  /** wan: carries an uplink, not editable. lan: in the bridge. unused: neither. */
  role: 'wan' | 'lan' | 'unused';
  profile: PortProfile;
  /**
   * Membership the profile cannot express: a tagged PVID ("t*") or several
   * PVIDs. Usually made in LuCI. Read as its nearest profile; editing the port
   * rewrites it in that form.
   */
  irregular: boolean;
}

export type Unsupported =
  /** swconfig switch chip (`config switch`): VLANs live in a different model. */
  | 'swconfig'
  /** No bridge device at all. */
  | 'no-bridge'
  /** Interfaces on the bridge that the model cannot place (see normalizeSwitch). */
  | 'custom';

export interface Switch {
  bridge: string;
  /** The bridge's `config device` section. */
  section: string;
  /** Has bridge-vlan sections. */
  vlanFiltering: boolean;
  ports: SwitchPort[];
  vlans: Vlan[];
  /** Set when the layout is outside what this page edits; ports are then read-only. */
  unsupported?: Unsupported;
}

const naturalSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The bridge carrying "lan" (directly or through <bridge>.<vid>), else the first bridge. */
function findBridge(network: UciConfig) {
  const bridges = sectionsOfType(network, 'device').filter((s) => str(s.type) === 'bridge' && str(s.name));
  const lanDev = str(network.lan?.device) ?? '';
  return (
    bridges.find((b) => str(b.name) === lanDev || lanDev.startsWith(`${str(b.name)}.`)) ?? bridges[0]
  );
}

/**
 * Netdevs that are physical ports: board.json's roles, the bridge's members,
 * and, on boards whose board.json does not enumerate ports (x86 lists one
 * device per role), every live ethernet device too.
 */
function physicalPorts(network: UciConfig, devices: DeviceStatusMap | undefined, board: BoardJson | undefined, bridgePorts: string[]) {
  const roles = Object.values(board?.network ?? {});
  const names = new Set<string>();
  for (const r of roles) {
    if (r.ports) r.ports.forEach((p) => names.add(p));
    else if (r.device) names.add(r.device);
  }
  const listsPorts = roles.some((r) => r.ports);
  for (const p of bridgePorts) if (!devices?.[p] || devices[p]!.devtype === 'ethernet') names.add(p);
  if (!listsPorts) {
    for (const [n, d] of Object.entries(devices ?? {})) if (d.devtype === 'ethernet') names.add(n);
  }
  // Never a bridge or VLAN device, whatever board.json says.
  for (const s of sectionsOfType(network, 'device')) if (str(s.type)) names.delete(str(s.name) ?? '');
  return [...names].sort(naturalSort);
}

/** Derive native/tagged from the VLANs a port appears in. */
export function profileOf(port: string, vlans: Vlan[]): { profile: PortProfile; irregular: boolean } {
  const mine = vlans.flatMap((v) => v.members.filter((m) => m.port === port).map((m) => ({ vid: v.vid, ...m })));
  const pvids = mine.filter((m) => m.pvid);
  const untagged = mine.filter((m) => !m.tagged);
  const native = pvids[0]?.vid ?? (untagged.length === 1 ? untagged[0]!.vid : undefined);
  const asc = (a: number, b: number) => a - b;
  const tagged = mine.filter((m) => m.tagged && m.vid !== native).map((m) => m.vid).sort(asc);
  const extra = untagged.filter((m) => m.vid !== native && !m.pvid).map((m) => m.vid).sort(asc);
  const irregular = pvids.length > 1 || mine.some((m) => m.tagged && m.pvid);
  const profile: PortProfile = { tagged };
  if (native !== undefined) profile.native = native;
  if (extra.length) profile.untagged = extra;
  return { profile, irregular };
}

export function normalizeSwitch(
  network: UciConfig,
  firewall: UciConfig | undefined,
  devices: DeviceStatusMap | undefined,
  board: BoardJson | undefined,
): Switch {
  const br = findBridge(network);
  const bridge = br ? str(br.name)! : '';
  const bridgePorts = br ? list(br.ports) : [];
  const ifaces = sectionsOfType(network, 'interface');

  const vlanSections = sectionsOfType(network, 'bridge-vlan').filter((s) => str(s.device) === bridge);
  const vlanFiltering = vlanSections.length > 0;
  const onVid = (vid: number) => ifaces.filter((i) => str(i.device) === `${bridge}.${vid}`).map((i) => i['.name']);
  const direct = ifaces.filter((i) => str(i.device) === bridge).map((i) => i['.name']);

  const vlans: Vlan[] = vlanFiltering
    ? vlanSections
        .map((s) => {
          const vid = Number(str(s.vlan));
          return { vid, section: s['.name'], members: list(s.ports).map(parseMember), networks: onVid(vid) };
        })
        .sort((a, b) => a.vid - b.vid)
    : br
      ? [{ vid: 1, members: bridgePorts.map((p) => parseMember(`${p}:u*`)), networks: direct }]
      : [];

  // Interfaces the model would misplace: <bridge>.<vid> without filtering (an
  // 802.1q device on a plain bridge), a VLAN with no bridge-vlan section, or
  // an interface on the bare bridge once filtering is on.
  const strays = ifaces.filter((i) => {
    const dev = str(i.device) ?? '';
    if (!bridge || (dev !== bridge && !dev.startsWith(`${bridge}.`))) return false;
    if (dev === bridge) return vlanFiltering;
    const m = new RegExp(`^${bridge.replace(/[.]/g, '\\.')}\\.(\\d+)$`).exec(dev);
    return !m || !vlanFiltering || !vlans.some((v) => v.vid === Number(m[1]));
  });

  const wanDevs = new Set(
    ifaces
      .filter((i) => wanNetworks(firewall).has(i['.name']))
      .map((i) => (str(i.device) ?? '').replace(/\.\d+$/, '')),
  );

  const ports = physicalPorts(network, devices, board, bridgePorts).map((name): SwitchPort => {
    const d = devices?.[name];
    const inBridge = bridgePorts.includes(name);
    const { profile, irregular } = inBridge ? profileOf(name, vlans) : { profile: { tagged: [] }, irregular: false };
    return {
      name,
      carrier: d?.carrier ?? false,
      ...parseSpeed(d?.speed),
      role: wanDevs.has(name) && !inBridge ? 'wan' : inBridge ? 'lan' : 'unused',
      profile,
      irregular,
    };
  });

  const unsupported: Unsupported | undefined = sectionsOfType(network, 'switch').length
    ? 'swconfig'
    : !br
      ? 'no-bridge'
      : strays.length
        ? 'custom'
        : undefined;

  return { bridge, section: br?.['.name'] ?? '', vlanFiltering, ports, vlans, unsupported };
}

/** The VLAN a network is on, if it is on the LAN bridge. */
export function vlanOf(sw: Switch, networkId: string): Vlan | undefined {
  return sw.vlans.find((v) => v.networks.includes(networkId));
}

const sameList = (a: number[] = [], b: number[] = []) => a.length === b.length && a.every((v, i) => v === b[i]);

export function sameProfile(a: PortProfile, b: PortProfile): boolean {
  return a.native === b.native && sameList(a.tagged, b.tagged) && sameList(a.untagged, b.untagged);
}

/** A port's part in one VLAN. */
export function roleIn(pr: PortProfile | undefined, vid: number): 'native' | 'tagged' | 'untagged' | undefined {
  if (!pr) return undefined;
  if (pr.native === vid) return 'native';
  if (pr.tagged.includes(vid)) return 'tagged';
  return pr.untagged?.includes(vid) ? 'untagged' : undefined;
}

/** Carries any VLAN at all. */
export function inUse(pr: PortProfile | undefined): boolean {
  return !!pr && (pr.native !== undefined || pr.tagged.length > 0 || !!pr.untagged?.length);
}

/** One VLAN as it should be after an edit. */
export interface VlanPlan {
  vid: number;
  /** Existing bridge-vlan section to update; a new one is added without. */
  section?: string;
  /** Interfaces to put on this VLAN's device. */
  networks: string[];
}

export interface SwitchPlan {
  vlans: VlanPlan[];
  /** Every non-WAN port. A port with no native and no tagged VLAN leaves the bridge. */
  profiles: Record<string, PortProfile>;
}

/** The current state as a plan: the starting point for every edit. */
export function currentPlan(sw: Switch): SwitchPlan {
  return {
    vlans: sw.vlans.map((v) => ({ vid: v.vid, section: v.section, networks: [...v.networks] })),
    profiles: Object.fromEntries(
      sw.ports.filter((p) => p.role !== 'wan').map((p) => [p.name, structuredClone(p.profile)]),
    ),
  };
}

/**
 * UCI ops turning `sw` into `plan`: bridge membership, bridge-vlan sections
 * and interface devices. A plain bridge stays plain while the plan is "VLAN 1
 * native everywhere"; anything more converts it to VLAN filtering.
 *
 * Ports whose profile is unchanged keep their stored tokens, so an irregular
 * port nobody touched is left exactly as it was.
 */
export function switchOps(sw: Switch, plan: SwitchPlan, network: UciConfig): UciOp[] {
  const ops: UciOp[] = [];
  const order = sw.ports.map((p) => p.name);
  const isMember = (p: string) => inUse(plan.profiles[p]);

  // Bridge ports: keep the stored order, drop leavers, append joiners.
  const before = list(network[sw.section]?.ports);
  const ports = [
    ...before.filter((p) => !(p in plan.profiles) || isMember(p)),
    ...order.filter((p) => isMember(p) && !before.includes(p)),
  ];
  ops.push(...diffSection('network', sw.section, network[sw.section], { ports }));

  const plain =
    !sw.vlanFiltering &&
    plan.vlans.length === 1 &&
    plan.vlans[0]!.vid === 1 &&
    Object.values(plan.profiles).every((p) => p.tagged.length === 0 && !p.untagged?.length && (p.native === undefined || p.native === 1));
  if (plain) return ops;

  // Keep a stored token when the port is untouched, or when it is regular and
  // its role in this VLAN is the same as before (so "eth3" stays "eth3").
  const keep = (p: string, oldVid: number, newVid: number) => {
    const port = sw.ports.find((x) => x.name === p);
    if (!port || port.role !== 'lan') return false;
    const next = plan.profiles[p]!;
    if (sameProfile(port.profile, next)) return true;
    const was = roleIn(port.profile, oldVid);
    return !port.irregular && was !== undefined && was === roleIn(next, newVid);
  };
  const tokenFor = (p: string, vid: number) => {
    const role = isMember(p) ? roleIn(plan.profiles[p], vid) : undefined;
    return role === 'native' ? `${p}:u*` : role === 'tagged' ? `${p}:t` : role === 'untagged' ? p : undefined;
  };

  for (const v of plan.vlans) {
    const old = v.section ? sw.vlans.find((x) => x.section === v.section) : undefined;
    // Stored tokens first, in their order; then new members in port order.
    const tokens: string[] = [];
    for (const m of old?.members ?? []) {
      if (!(m.port in plan.profiles)) tokens.push(m.token);
      else if (keep(m.port, old!.vid, v.vid)) tokens.push(m.token);
      else {
        const t = tokenFor(m.port, v.vid);
        if (t) tokens.push(t);
      }
    }
    for (const p of order) {
      if (!(p in plan.profiles) || old?.members.some((m) => m.port === p)) continue;
      const t = tokenFor(p, v.vid);
      if (t) tokens.push(t);
    }
    if (v.section) {
      ops.push(...diffSection('network', v.section, network[v.section], { vlan: String(v.vid), ports: tokens }));
    } else {
      ops.push({
        op: 'add',
        config: 'network',
        type: 'bridge-vlan',
        values: { device: sw.bridge, vlan: String(v.vid), ...(tokens.length ? { ports: tokens } : {}) },
      });
    }
    for (const n of v.networks) {
      if (network[n]) ops.push(...diffSection('network', n, network[n], { device: `${sw.bridge}.${v.vid}` }));
    }
  }
  for (const v of sw.vlans) {
    if (v.section && !plan.vlans.some((x) => x.section === v.section)) {
      ops.push({ op: 'delete', config: 'network', section: v.section });
    }
  }
  return ops;
}

export const VID_MIN = 1;
export const VID_MAX = 4094;

/** Error for a typed VLAN ID, or null. `taken` excludes the VLAN being edited. */
export function validateVid(raw: string, taken: number[]): string | null {
  if (!/^\d+$/.test(raw.trim())) return `Enter a number from ${VID_MIN} to ${VID_MAX}.`;
  const vid = Number(raw);
  if (vid < VID_MIN || vid > VID_MAX) return `Enter a number from ${VID_MIN} to ${VID_MAX}.`;
  if (taken.includes(vid)) return `VLAN ${vid} is already in use.`;
  return null;
}

function mapProfiles(plan: SwitchPlan, f: (vid: number) => number | undefined): SwitchPlan['profiles'] {
  const many = (vs: number[] | undefined) =>
    (vs ?? []).map(f).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  return Object.fromEntries(
    Object.entries(plan.profiles).map(([p, pr]) => {
      const next: PortProfile = { tagged: many(pr.tagged) };
      const native = pr.native === undefined ? undefined : f(pr.native);
      if (native !== undefined) next.native = native;
      if (pr.untagged?.length) next.untagged = many(pr.untagged);
      return [p, next];
    }),
  );
}

/** Plan with one VLAN renumbered; ports follow it. */
export function renumberPlan(plan: SwitchPlan, from: number, to: number): SwitchPlan {
  return {
    vlans: plan.vlans.map((v) => (v.vid === from ? { ...v, vid: to } : v)),
    profiles: mapProfiles(plan, (v) => (v === from ? to : v)),
  };
}

/** Plan with a VLAN removed from the bridge and every port. */
export function removeVlanPlan(plan: SwitchPlan, vid: number): SwitchPlan {
  return {
    vlans: plan.vlans.filter((v) => v.vid !== vid),
    profiles: mapProfiles(plan, (v) => (v === vid ? undefined : v)),
  };
}
