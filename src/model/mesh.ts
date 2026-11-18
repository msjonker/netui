// Wireless mesh: an 802.11s backhaul on the gateway's 5 GHz radio, copied to
// every adopted access point by the gateway's sync, plus spanning tree on the
// LAN bridge so a cable and the mesh can both connect an access point without
// a loop. STP blocks the mesh while the cable is in and fails over to it when
// the cable goes.

import type { DeviceStatusMap, UciConfig } from '../api/types';
import type { DeviceRadio } from '../api/queries';
import { str, type UciOp } from '../api/uci';
import { gatewayVlans, meshVlanList } from './apPorts';
import { normalizeSwitch } from './ports';

export const MESH_SECTION = 'netui_mesh';

/** Bridge forward delay while STP is on: ports join after ~2x this. Kernel default 15 s. */
export const MESH_FORWARD_DELAY = '4';

export interface MeshState {
  enabled: boolean;
  /** The radio carrying the mesh, or the one it would use. */
  radio?: string;
  channel?: string;
  meshId?: string;
  /** Spanning tree on br-lan. */
  stp: boolean;
  /** The bridge device section for br-lan. */
  bridge?: string;
}

const rank = (htmode: string | undefined) =>
  /^EHT/.test(htmode ?? '') ? 4 : /^HE/.test(htmode ?? '') ? 3 : /^VHT/.test(htmode ?? '') ? 2 : 1;

/** The gateway's best 5 GHz radio: mesh peers must share it, so it is the backhaul. */
export function meshRadio(wireless: UciConfig): string | undefined {
  return Object.values(wireless)
    .filter((s) => s['.type'] === 'wifi-device' && str(s.band) === '5g')
    .sort((a, b) => rank(str(b.htmode)) - rank(str(a.htmode)))[0]?.['.name'];
}

export function readMesh(wireless: UciConfig, network: UciConfig): MeshState {
  const iface = Object.values(wireless).find((s) => s['.type'] === 'wifi-iface' && str(s.mode) === 'mesh');
  const bridge = Object.values(network).find((s) => s['.type'] === 'device' && str(s.name) === 'br-lan');
  const radio = iface ? str(iface.device) : meshRadio(wireless);
  return {
    enabled: !!iface && str(iface.disabled) !== '1',
    radio,
    channel: radio ? str(wireless[radio]?.channel) : undefined,
    meshId: iface ? str(iface.mesh_id) : undefined,
    stp: str(bridge?.stp) === '1',
    bridge: bridge?.['.name'],
  };
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Turn the mesh on or off on the gateway. On: a SAE-encrypted 802.11s
 * interface on the 5 GHz radio bridged into the LAN, a fixed channel (every
 * node must share it; `liveChannel` replaces "auto"), and STP on br-lan.
 * The gateway's sync then copies all of it to the access points.
 */
export function meshOps(on: boolean, wireless: UciConfig, network: UciConfig, liveChannel?: number): UciOp[] {
  const m = readMesh(wireless, network);
  const ops: UciOp[] = [];
  if (on) {
    if (!m.radio) return [];
    // Every network on the LAN bridge crosses the mesh, the LAN untagged and the rest tagged.
    const vlans = meshVlanList(gatewayVlans(normalizeSwitch(network, undefined, undefined, undefined)));
    if (!m.channel || m.channel === 'auto')
      ops.push({ op: 'set', config: 'wireless', section: m.radio, values: { channel: String(liveChannel ?? 36) } });
    if (wireless[MESH_SECTION]) {
      ops.push({ op: 'set', config: 'wireless', section: MESH_SECTION, values: { device: m.radio, disabled: '0' } });
      if (vlans.length) ops.push({ op: 'set', config: 'wireless', section: MESH_SECTION, values: { network_vlan: vlans } });
    } else {
      ops.push({
        op: 'add',
        config: 'wireless',
        type: 'wifi-iface',
        name: MESH_SECTION,
        values: {
          device: m.radio,
          mode: 'mesh',
          mesh_id: `netui-${randomHex(4)}`,
          encryption: 'sae',
          key: randomHex(16),
          network: 'lan',
          mesh_fwding: '1',
          mesh_rssi_threshold: '0',
          ...(vlans.length ? { network_vlan: vlans } : {}),
        },
      });
    }
    if (m.bridge) ops.push({ op: 'set', config: 'network', section: m.bridge, values: { stp: '1', forward_delay: MESH_FORWARD_DELAY } });
  } else {
    if (wireless[MESH_SECTION]) ops.push({ op: 'delete', config: 'wireless', section: MESH_SECTION });
    if (m.bridge && m.stp) ops.push({ op: 'unset', config: 'network', section: m.bridge, options: ['stp', 'forward_delay'] });
  }
  return ops;
}

export type Uplink =
  | { kind: 'wired'; port: string; meshStandby: boolean }
  | { kind: 'mesh'; signal?: number; rateMbps?: number }
  | { kind: 'unknown' };

/**
 * How an access point reaches the gateway: a physical port with link means
 * the cable carries traffic (STP keeps the mesh on standby); otherwise the
 * mesh link, with its signal and rate.
 */
export function uplinkOf(links: DeviceStatusMap | undefined, radios: DeviceRadio[] | undefined): Uplink {
  const peer = radios?.find((r) => r.mesh)?.peers[0];
  const port = Object.entries(links ?? {}).find(([, d]) => d.devtype === 'ethernet' && d.carrier)?.[0];
  if (port) return { kind: 'wired', port, meshStandby: !!peer };
  if (peer) return { kind: 'mesh', signal: peer.signal, rateMbps: peer.tx?.rate ? Math.round(peer.tx.rate / 1000) : undefined };
  return { kind: 'unknown' };
}

export function uplinkLabel(u: Uplink): string {
  if (u.kind === 'wired') return u.meshStandby ? `Wired (${u.port}), mesh on standby` : `Wired (${u.port})`;
  if (u.kind === 'mesh') return ['Mesh', u.signal !== undefined && `${u.signal} dBm`, u.rateMbps && `${u.rateMbps} Mbps`].filter(Boolean).join(' · ');
  return '—';
}
