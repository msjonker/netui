import { describe, expect, it } from 'vitest';
import { vmFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import { localSubnets } from './network';
import { normalizeSwitch } from './ports';
import {
  createNetworkOps,
  deleteBlocker,
  deleteNetworkOps,
  isolationOf,
  newNetworkDraft,
  renumberOps,
  validateNewNetwork,
  type NewNetworkDraft,
} from './vlans';
import type { UciConfig } from '../api/types';
import type { UciOp } from '../api/uci';

function ctx(name: 'plain' | 'vlan') {
  const f = vmFixtures(name);
  const network = f.uci.network();
  const firewall = f.uci.firewall();
  const dhcp = f.uci.dhcp();
  const sw = normalizeSwitch(network, firewall, f.deviceStatus(), f.board());
  return { f, network, firewall, dhcp, sw, others: localSubnets(network, firewall, f.ifaceDump()) };
}

const draft = (over: Partial<NewNetworkDraft> = {}): NewNetworkDraft => ({
  name: 'guest',
  vid: '30',
  address: '10.232.30.1',
  prefix: 24,
  dhcpEnabled: true,
  rangeStart: '10.232.30.100',
  rangeEnd: '10.232.30.199',
  leasetime: '2h',
  isolation: 'trusted',
  allPorts: true,
  ...over,
});

describe('newNetworkDraft', () => {
  it('suggests a free VLAN and subnet', () => {
    const c = ctx('vlan');
    const d = newNetworkDraft(c.sw, c.others);
    expect(d.vid).toBe('10');
    expect(validateNewNetwork({ ...d, name: 'cams' }, c)).toEqual({});
  });
});

describe('validateNewNetwork', () => {
  it('rejects taken names and VLANs, bad names and overlapping subnets', () => {
    const c = ctx('vlan');
    expect(validateNewNetwork(draft({ name: 'iot' }), c).name).toMatch(/already used/);
    expect(validateNewNetwork(draft({ name: 'Guest' }), c).name).toMatch(/Lowercase/);
    expect(validateNewNetwork(draft({ name: 'averylongname' }), c).name).toBeDefined();
    expect(validateNewNetwork(draft({ vid: '20' }), c).vid).toMatch(/in use/);
    expect(validateNewNetwork(draft({ address: '10.232.20.5' }), c).address).toMatch(/Overlaps/);
  });

  it('treats VLAN 1 as taken on a plain bridge, where it is the LAN', () => {
    expect(validateNewNetwork(draft({ vid: '1' }), ctx('plain')).vid).toMatch(/in use/);
  });
});

describe('createNetworkOps', () => {
  it('converts a plain bridge, adds the VLAN on every port, a pool, and joins the LAN zone', () => {
    const c = ctx('plain');
    const cfg = stageOn(new FakeRouter({}, 'plain'), createNetworkOps(draft(), c));
    expect(cfg.network!.lan!.device).toBe('br-lan.1');
    expect(cfg.network!.guest).toMatchObject({ proto: 'static', device: 'br-lan.30', ipaddr: ['10.232.30.1/24'] });
    const vlans = Object.values(cfg.network!).filter((s) => s['.type'] === 'bridge-vlan');
    expect(vlans.map((v) => [v.vlan, v.ports])).toEqual([
      ['1', ['eth0:u*', 'eth2:u*', 'eth3:u*', 'eth4:u*']],
      ['30', ['eth0:t', 'eth2:t', 'eth3:t', 'eth4:t']],
    ]);
    expect(cfg.dhcp!.guest).toMatchObject({ interface: 'guest', start: '100', limit: '100', leasetime: '2h' });
    expect(isolationOf('guest', cfg.firewall)).toBe('trusted');
  });

  it('creates an isolated zone that still allows DHCP and DNS', () => {
    const c = ctx('vlan');
    const cfg = stageOn(new FakeRouter({}, 'vlan'), createNetworkOps(draft({ isolation: 'isolated', allPorts: false }), c));
    const fw = Object.values(cfg.firewall!);
    expect(fw.find((s) => s['.type'] === 'zone' && s.name === 'guest')).toMatchObject({
      network: ['guest'],
      input: 'REJECT',
      forward: 'REJECT',
    });
    expect(fw.find((s) => s['.type'] === 'forwarding' && s.src === 'guest')).toMatchObject({ dest: 'wan' });
    const rules = fw.filter((s) => s['.type'] === 'rule' && s.src === 'guest');
    expect(rules.map((r) => r.dest_port)).toEqual(['67-68', '53']);
    expect(isolationOf('guest', cfg.firewall)).toBe('isolated');
    // No ports: the VLAN exists on the bridge only, for WiFi or later port edits.
    const v = Object.values(cfg.network!).find((s) => s['.type'] === 'bridge-vlan' && s.vlan === '30');
    expect(v).toMatchObject({ device: 'br-lan' });
    expect(v!.ports).toBeUndefined();
  });

  it('leaves out the pool when DHCP is off', () => {
    const c = ctx('vlan');
    const cfg = stageOn(new FakeRouter({}, 'vlan'), createNetworkOps(draft({ dhcpEnabled: false }), c));
    expect(cfg.dhcp!.guest).toBeUndefined();
  });
});

describe('deleteNetworkOps', () => {
  it('removes the interface, its pool, its VLAN and its zone membership', () => {
    const c = ctx('vlan');
    const cfg = stageOn(new FakeRouter({}, 'vlan'), deleteNetworkOps('iot', c));
    expect(cfg.network!.iot).toBeUndefined();
    expect(cfg.network!.cfg08a1b0).toBeUndefined();
    expect(cfg.dhcp!.iot).toBeUndefined();
    expect(Object.values(cfg.firewall!).find((s) => s.name === 'lan')!.network).toEqual(['lan']);
    // eth4 was only in VLAN 20 and leaves the bridge; eth2/eth3 keep VLAN 1.
    expect(cfg.network!.cfg030f15!.ports).toEqual(['eth0', 'eth2', 'eth3']);
    expect(cfg.network!.cfg07a1b0!.ports).toEqual(['eth0:u*', 'eth2:u*', 'eth3:u*']);
  });

  it('removes an isolated zone with its forwarding and rules', () => {
    const c = ctx('vlan');
    const r = new FakeRouter({}, 'vlan');
    const created = stageOn(r, createNetworkOps(draft({ isolation: 'isolated' }), c));
    const f = vmFixtures('vlan');
    const sw = normalizeSwitch(created.network!, created.firewall, f.deviceStatus(), f.board());
    const cfg = stageOn(r, deleteNetworkOps('guest', { sw, network: created.network!, dhcp: created.dhcp!, firewall: created.firewall! }));
    expect(Object.values(cfg.firewall!).filter((s) => s.src === 'guest' || s.name === 'guest')).toEqual([]);
    expect(cfg.network).toEqual(c.network);
    expect(cfg.firewall).toEqual(c.firewall);
  });
});

describe('deleteBlocker', () => {
  it('protects the LAN, the uplink, the current network and networks with WiFi', () => {
    const c = ctx('vlan');
    const base = { sw: c.sw, firewall: c.firewall, wireless: undefined, viaThis: false };
    expect(deleteBlocker('lan', base)).toMatch(/LAN/);
    expect(deleteBlocker('wan', base)).toMatch(/uplink/);
    expect(deleteBlocker('iot', { ...base, viaThis: true })).toMatch(/connected/);
    const wireless = {
      w: { '.anonymous': false, '.index': 0, '.name': 'w', '.type': 'wifi-iface', ssid: 'Things', network: 'iot' },
    };
    expect(deleteBlocker('iot', { ...base, wireless })).toMatch(/"Things"/);
    expect(deleteBlocker('iot', base)).toBeNull();
  });
});

describe('the mesh follows the VLAN networks', () => {
  const withMesh = (name: 'plain' | 'vlan') => {
    const wireless: UciConfig = {
      netui_mesh: { '.anonymous': false, '.type': 'wifi-iface', '.name': 'netui_mesh', '.index': 0, mode: 'mesh', network: 'lan' },
    };
    return { ...ctx(name), wireless };
  };
  const meshList = (ops: UciOp[]) =>
    ops.filter((o) => o.config === 'wireless').map((o) => (o.op === 'set' ? o.values.network_vlan : o.op === 'unset' ? 'unset' : o.op));

  it('adds a new network to the mesh', () => {
    const c = withMesh('plain');
    expect(meshList(createNetworkOps(draft({ vid: '20' }), c))).toEqual([['20:t']]);
    // Without a mesh there is nothing to change.
    expect(meshList(createNetworkOps(draft({ vid: '20' }), { ...c, wireless: undefined }))).toEqual([]);
  });

  it('follows a renumbered network and drops a deleted one', () => {
    const c = withMesh('vlan');
    const v = c.sw.vlans.find((x) => x.networks.length === 1 && !x.networks.includes('lan'))!;
    c.wireless.netui_mesh!.network_vlan = [`${v.vid}:t`];
    expect(meshList(renumberOps(c.sw, v.vid, 99, c.network, c.wireless))).toEqual([['99:t']]);
    expect(meshList(deleteNetworkOps(v.networks[0]!, c))).toEqual(['unset']);
  });
});
