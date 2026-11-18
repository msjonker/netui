import { describe, expect, it } from 'vitest';
import type { AssocList, DeviceStatusMap, IwinfoInfo, RelayResult, UciGet } from '../api/types';
import type { DeviceRadio } from '../api/queries';
import { wrxFixtures } from '../../test/fixtures';
import gwWireless from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.wireless.mesh.json';
import gwNetwork from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.network.stp.json';
import apLinksJson from '../../test/fixtures/ubus/bench-v2/netui.devices.call.network.device.status.json';
import apMeshInfoJson from '../../test/fixtures/ubus/bench-v2/netui.devices.call.iwinfo.info.phy1-mesh0.json';
import apMeshPeersJson from '../../test/fixtures/ubus/bench-v2/netui.devices.call.iwinfo.assoclist.phy1-mesh0.json';
import { MESH_SECTION, meshOps, meshRadio, readMesh, uplinkLabel, uplinkOf } from './mesh';

// Plain assignments: tsc checks the recordings against the types.
const wireless: UciGet = gwWireless;
const network: UciGet = gwNetwork;
const apLinks: RelayResult<DeviceStatusMap> = apLinksJson;
const apMeshInfo: RelayResult<IwinfoInfo> = apMeshInfoJson;
const apMeshPeers: RelayResult<AssocList> = apMeshPeersJson;

const meshRadioOfAp: DeviceRadio = { ifname: 'phy1-mesh0', info: apMeshInfo.data!, mesh: true, clients: 0, peers: apMeshPeers.data!.results, stations: [] };

describe('mesh on the recorded bench', () => {
  it('reads the gateway mesh: 5 GHz radio, fixed channel, STP on', () => {
    expect(readMesh(wireless.values, network.values)).toMatchObject({
      enabled: true,
      radio: 'radio0',
      channel: '36',
      meshId: 'netui-mesh',
      stp: true,
    });
  });

  it('sees the cable as the uplink while the mesh waits on standby', () => {
    const u = uplinkOf(apLinks.data, [meshRadioOfAp]);
    expect(u).toEqual({ kind: 'wired', port: 'lan1', meshStandby: true });
    expect(uplinkLabel(u)).toBe('Wired (lan1), mesh on standby');
  });

  it('falls back to the mesh link, with its signal and rate, when no port has link', () => {
    const unplugged = Object.fromEntries(Object.entries(apLinks.data!).map(([k, d]) => [k, { ...d, carrier: d.devtype === 'ethernet' ? false : d.carrier }]));
    const u = uplinkOf(unplugged, [meshRadioOfAp]);
    expect(u).toEqual({ kind: 'mesh', signal: -9, rateMbps: 1441 });
    expect(uplinkLabel(u)).toBe('Mesh · -9 dBm · 1441 Mbps');
  });
});

describe('meshOps', () => {
  const plain = wrxFixtures('plain');

  it('turns the mesh on: SAE 802.11s on the best 5 GHz radio, fixed channel, STP', () => {
    const w = plain.uci.wireless();
    w.radio0!.channel = 'auto';
    const ops = meshOps(true, w, plain.uci.network(), 149);
    expect(meshRadio(w)).toBe('radio0');
    expect(ops).toContainEqual({ op: 'set', config: 'wireless', section: 'radio0', values: { channel: '149' } });
    const add = ops.find((o) => o.op === 'add');
    expect(add).toMatchObject({
      config: 'wireless',
      name: MESH_SECTION,
      values: { device: 'radio0', mode: 'mesh', encryption: 'sae', network: 'lan', mesh_fwding: '1' },
    });
    const v = (add as { values: Record<string, string> }).values;
    expect(v.key).toMatch(/^[0-9a-f]{32}$/);
    expect(v.mesh_id).toMatch(/^netui-[0-9a-f]{8}$/);
    expect(ops).toContainEqual(expect.objectContaining({ op: 'set', config: 'network', values: { stp: '1', forward_delay: '4' } }));
    // No other networks: the mesh carries only the LAN.
    expect(v.network_vlan).toBeUndefined();
  });

  it('carries the VLAN networks over the mesh, tagged', () => {
    const vlan = wrxFixtures('vlan');
    const add = meshOps(true, vlan.uci.wireless(), vlan.uci.network(), 36).find((o) => o.op === 'add');
    expect(add).toMatchObject({ values: { network: 'lan', network_vlan: ['10:t'] } });
  });

  it('keeps a fixed channel, and turns off by removing the interface and STP', () => {
    expect(meshOps(true, wireless.values, network.values).some((o) => o.op === 'set' && o.section === 'radio0' && 'channel' in o.values)).toBe(false);
    expect(meshOps(false, wireless.values, network.values)).toEqual([
      { op: 'delete', config: 'wireless', section: MESH_SECTION },
      { op: 'unset', config: 'network', section: expect.any(String), options: ['stp', 'forward_delay'] },
    ]);
  });
});
