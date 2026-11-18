import { describe, expect, it } from 'vitest';
import { apFixtures, wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import type { UciConfig } from '../api/types';
import type { UciOp } from '../api/uci';
import { apPortOps, apSyncOps, gatewayVlans, meshVlanList, readApLayout, type GatewayVlans } from './apPorts';
import { normalizeSwitch } from './ports';

type Ap = 'ax3600' | 'tl-wdr4300';

const gw = (name: 'plain' | 'vlan'): GatewayVlans => {
  const f = wrxFixtures(name);
  return gatewayVlans(normalizeSwitch(f.uci.network(), f.uci.firewall(), f.deviceStatus(), f.board()));
};

const layout = (name: Ap, network?: UciConfig) => {
  const f = apFixtures(name);
  return readApLayout(network ?? f.uci.network(), f.deviceStatus(), f.ports());
};

/**
 * A fake access point to stage ops on, one per test: a fresh FakeRouter would
 * hand out the same names for anonymous sections again.
 */
function fakeAp(name: Ap) {
  const r = new FakeRouter({ network: apFixtures(name).uci.network() });
  return (ops: UciOp[]): UciConfig => stageOn(r, ops).network!;
}

const profiles = (l: ReturnType<typeof layout>) => Object.fromEntries(l.ports.map((p) => [p.name, p.profile]));

describe('gatewayVlans', () => {
  it('reads the LAN and the VLAN networks of the gateway', () => {
    expect(gw('vlan')).toEqual({ lan: 1, vlans: [{ vid: 1, networks: ['lan'] }, { vid: 10, networks: ['iot'] }] });
    expect(gw('plain')).toEqual({ lan: 1, vlans: [{ vid: 1, networks: ['lan'] }] });
    expect(meshVlanList(gw('vlan'))).toEqual(['10:t']);
    expect(meshVlanList(gw('plain'))).toEqual([]);
  });
});

describe('readApLayout', () => {
  it('reads a DSA access point on the mesh as adoption left it', () => {
    const l = layout('ax3600');
    expect(l).toMatchObject({ kind: 'dsa', bridge: 'br-lan', vids: [1], vlanFiltering: false, lan: 1, meshUplink: true });
    expect(l.unsupported).toBeUndefined();
    expect(l.ports.map((p) => [p.name, p.uplink, p.profile])).toEqual([
      ['lan1', false, { native: 1, tagged: [] }],
      ['lan2', false, { native: 1, tagged: [] }],
      ['lan3', false, { native: 1, tagged: [] }],
      ['wan', false, { native: 1, tagged: [] }],
    ]);
  });

  it('reads a switch chip access point: both switch VLANs bridged into the LAN, uplink on the WAN port', () => {
    const l = layout('tl-wdr4300');
    expect(l).toMatchObject({ kind: 'swconfig', bridge: 'br-lan', vids: [1], vlanFiltering: false, lan: 1, meshUplink: false });
    expect(l.unsupported).toBeUndefined();
    expect(l.ports.map((p) => [p.name, p.num, p.carrier, p.speed, p.uplink, p.profile.native])).toEqual([
      ['lan1', 2, true, 1000, false, 1],
      ['lan2', 3, false, undefined, false, 1],
      ['lan3', 4, false, undefined, false, 1],
      ['lan4', 5, false, undefined, false, 1],
      ['wan', 1, true, 10, true, 1],
    ]);
  });

  it('needs the newer agent to describe a switch chip', () => {
    const f = apFixtures('tl-wdr4300');
    expect(readApLayout(f.uci.network(), f.deviceStatus(), undefined).unsupported).toBe('agent');
  });
});

describe('apSyncOps', () => {
  it('changes nothing while the gateway has only its LAN', () => {
    expect(apSyncOps(layout('ax3600'), gw('plain'), apFixtures('ax3600').uci.network())).toEqual([]);
    expect(apSyncOps(layout('tl-wdr4300'), gw('plain'), apFixtures('tl-wdr4300').uci.network())).toEqual([]);
  });

  it('carries the gateway VLANs to a DSA access point, tagged next to LAN on every port', () => {
    const ops = apSyncOps(layout('ax3600'), gw('vlan'), apFixtures('ax3600').uci.network());
    const after = fakeAp('ax3600')(ops);
    const l = layout('ax3600', after);
    expect(l).toMatchObject({ vids: [1, 10], vlanFiltering: true, lan: 1 });
    expect(l.unsupported).toBeUndefined();
    expect(Object.values(profiles(l))).toEqual(Array(4).fill({ native: 1, tagged: [10] }));
    expect(after.lan).toMatchObject({ device: 'br-lan.1', proto: 'dhcp' });
    expect(after.netui_iot).toMatchObject({ '.type': 'interface', proto: 'none', device: 'br-lan.10' });
    // Settled: a second sync changes nothing.
    expect(apSyncOps(l, gw('vlan'), after)).toEqual([]);
  });

  it('carries the gateway VLANs to a switch chip access point through its CPU port', () => {
    const ops = apSyncOps(layout('tl-wdr4300'), gw('vlan'), apFixtures('tl-wdr4300').uci.network());
    const after = fakeAp('tl-wdr4300')(ops);
    const vlans = Object.values(after).filter((s) => s['.type'] === 'switch_vlan');
    expect(vlans.map((s) => [s.vlan, s.vid, s.ports])).toEqual([
      ['1', '1', '1 2 3 4 5 0t'],
      ['2', '10', '1t 2t 3t 4t 5t 0t'],
    ]);
    const br = Object.values(after).find((s) => s.name === 'br-lan')!;
    expect(br.ports).toEqual(['eth0']);
    const bvlans = Object.values(after).filter((s) => s['.type'] === 'bridge-vlan');
    expect(bvlans.map((s) => [s.vlan, s.ports])).toEqual([
      ['1', ['eth0:t']],
      ['10', ['eth0:t']],
    ]);
    expect(after.lan).toMatchObject({ device: 'br-lan.1' });
    expect(after.netui_iot).toMatchObject({ proto: 'none', device: 'br-lan.10' });

    const l = layout('tl-wdr4300', after);
    expect(l).toMatchObject({ vids: [1, 10], vlanFiltering: true, lan: 1 });
    expect(l.unsupported).toBeUndefined();
    expect(Object.values(profiles(l))).toEqual(Array(5).fill({ native: 1, tagged: [10] }));
    expect(apSyncOps(l, gw('vlan'), after)).toEqual([]);
  });

  it('keeps port choices, keeps the uplink a trunk, and drops VLANs the gateway deleted', () => {
    for (const name of ['ax3600', 'tl-wdr4300'] as const) {
      const staged = fakeAp(name);
      const synced = staged(apSyncOps(layout(name), gw('vlan'), apFixtures(name).uci.network()));
      // Put lan3 on IoT only, as the access point's panel would.
      const l = layout(name, synced);
      const edited = staged(apPortOps(l, { lan3: { native: 10, tagged: [] } }, synced));
      const e = layout(name, edited);
      expect(profiles(e).lan3).toEqual({ native: 10, tagged: [] });
      expect(profiles(e).lan1).toEqual({ native: 1, tagged: [10] });
      expect(apSyncOps(e, gw('vlan'), edited)).toEqual([]);

      // A VLAN 20 network appears on the gateway: tagged on the LAN ports, not on lan3.
      const more: GatewayVlans = { lan: 1, vlans: [...gw('vlan').vlans, { vid: 20, networks: ['cams'] }] };
      const grown = staged(apSyncOps(e, more, edited));
      const g = layout(name, grown);
      expect(profiles(g).lan1).toEqual({ native: 1, tagged: [10, 20] });
      expect(profiles(g).lan3).toEqual({ native: 10, tagged: [] });
      expect(grown.netui_cams).toMatchObject({ device: 'br-lan.20' });

      // The gateway deletes IoT: lan3 carries nothing, the twin goes.
      const less: GatewayVlans = { lan: 1, vlans: [{ vid: 1, networks: ['lan'] }, { vid: 20, networks: ['cams'] }] };
      const shrunk = staged(apSyncOps(g, less, grown));
      const s = layout(name, shrunk);
      expect(s.vids).toEqual([1, 20]);
      expect(profiles(s).lan3).toEqual({ tagged: [] });
      expect(profiles(s).lan1).toEqual({ native: 1, tagged: [20] });
      expect(shrunk.netui_iot).toBeUndefined();
    }
  });

  it('turns the uplink back into a trunk', () => {
    const name = 'tl-wdr4300';
    const staged = fakeAp(name);
    const synced = staged(apSyncOps(layout(name), gw('vlan'), apFixtures(name).uci.network()));
    const broken = staged(apPortOps(layout(name, synced), { wan: { native: 1, tagged: [] } }, synced));
    expect(profiles(layout(name, broken)).wan).toEqual({ native: 1, tagged: [] });
    const fixed = staged(apSyncOps(layout(name, broken), gw('vlan'), broken));
    expect(profiles(layout(name, fixed)).wan).toEqual({ native: 1, tagged: [10] });
  });
});
