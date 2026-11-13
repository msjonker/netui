import { describe, expect, it } from 'vitest';
import type { InterfaceDump, UciConfig, UciGet } from '../api/types';
import { fixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import netJson from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.network.json';
import fwJson from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import dumpJson from '../../test/fixtures/ubus/dl-wrx36/plain/network.interface.dump.json';
import sqmJson from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.sqm.json';
import { normalizeWan, splitVlan, validateWan, wanDraft, wanL3Device, wanOps, type WanDraft } from './internet';

const recorded: { network: UciGet; firewall: UciGet; sqm: UciGet; dump: InterfaceDump } = {
  network: netJson,
  firewall: fwJson,
  sqm: sqmJson,
  dump: dumpJson,
};
const net = (): UciConfig => structuredClone(recorded.network.values);
const fw = (): UciConfig => structuredClone(recorded.firewall.values);
const sqm = (): UciConfig => structuredClone(recorded.sqm.values);

/** Apply ops to a fake router holding `network` (and sqm), return the result. */
function after(network: UciConfig, ops: ReturnType<typeof wanOps>) {
  const r = new FakeRouter({ network, sqm: sqm() });
  stageOn(r, ops);
  return { network: r.current('network')!, sqm: r.current('sqm')! };
}

const edit = (w: ReturnType<typeof normalizeWan>, patch: Partial<WanDraft>) => ({ ...wanDraft(w!), ...patch });

describe('normalizeWan', () => {
  it('reads the DL-WRX36 factory WAN', () => {
    expect(normalizeWan(net(), fw())).toEqual({
      section: 'wan',
      proto: 'dhcp',
      device: 'wan',
      port: 'wan',
      vlan: undefined,
      address: undefined,
      prefix: undefined,
      addressForm: 'cidr-list',
      gateway: undefined,
      username: undefined,
      hasPassword: false,
      autoDns: true,
      dns: [],
      pppIpv6: undefined,
      mac: undefined,
      macSection: undefined,
      v6: { section: 'wan6', proto: 'dhcpv6', device: 'wan', enabled: true },
    });
  });

  it('reads the dev-container static WAN', () => {
    const w = normalizeWan(fixtures.uci.network(), fixtures.uci.firewall())!;
    expect(w).toMatchObject({ proto: 'static', address: '10.231.0.2', prefix: 24, gateway: '10.231.0.1', dns: ['1.1.1.1', '9.9.9.9'] });
    expect(wanDraft(w)).toMatchObject({ autoDns: false, dns: '1.1.1.1, 9.9.9.9', prefix: '24' });
  });

  it('splits a VLAN tag off the device and finds the MAC override', () => {
    const n = net();
    n.wan!.device = 'wan.7';
    n.dev = { '.anonymous': false, '.index': 9, '.name': 'dev', '.type': 'device', name: 'wan', macaddr: '02:00:00:00:00:01' };
    expect(normalizeWan(n, fw())).toMatchObject({ port: 'wan', vlan: 7, mac: '02:00:00:00:00:01', macSection: 'dev' });
    expect(splitVlan('eth0.4095')).toEqual({ port: 'eth0.4095' });
  });
});

describe('wanL3Device', () => {
  it('uses the configured device while the WAN is down, pppoe-<if> for PPPoE', () => {
    const w = normalizeWan(net(), fw())!;
    expect(wanL3Device(w, recorded.dump)).toBe('wan');
    expect(wanL3Device({ ...w, proto: 'pppoe' })).toBe('pppoe-wan');
    expect(wanL3Device(normalizeWan(fixtures.uci.network(), fixtures.uci.firewall())!, fixtures.ifaceDump())).toBe('eth1');
  });
});

describe('validateWan', () => {
  const w = normalizeWan(net(), fw())!;
  it('checks static addressing', () => {
    expect(validateWan(edit(w, { proto: 'static', address: '203.0.113.5', prefix: '24', gateway: '203.0.114.1', dns: '' }), w)).toEqual({
      gateway: 'Not in the WAN subnet.',
    });
    expect(Object.keys(validateWan(edit(w, { proto: 'static', address: 'x', prefix: '40', gateway: '' }), w))).toEqual([
      'address',
      'prefix',
      'gateway',
    ]);
  });
  it('needs PPPoE credentials, VLAN in range, a unicast MAC and manual DNS', () => {
    expect(validateWan(edit(w, { proto: 'pppoe', vlan: '5000', mac: '01:00:5e:00:00:01', autoDns: false, dns: '1.1.1.1, nope' }), w)).toEqual({
      username: 'Enter the username from your ISP.',
      password: 'Enter the password from your ISP.',
      vlan: 'A VLAN ID from 1 to 4094.',
      mac: 'That is a multicast address.',
      dns: 'nope is not an IP address.',
    });
  });
});

describe('wanOps', () => {
  it('switches DHCP to static with manual DNS', () => {
    const n = net();
    const w = normalizeWan(n, fw())!;
    const d = edit(w, { proto: 'static', address: '203.0.113.5', prefix: '24', gateway: '203.0.113.1', dns: '1.1.1.1 8.8.8.8' });
    const out = after(n, wanOps(d, w, n));
    expect(out.network.wan).toMatchObject({ proto: 'static', ipaddr: ['203.0.113.5/24'], gateway: '203.0.113.1', dns: ['1.1.1.1', '8.8.8.8'] });
    expect(out.network.wan!.peerdns).toBeUndefined();
  });

  it('switches to PPPoE on a tagged VLAN, moving wan6 and an enabled SQM queue along', () => {
    const n = net();
    const q = sqm();
    q.eth1!.enabled = '1';
    q.eth1!.interface = 'wan';
    const w = normalizeWan(n, fw())!;
    const d = edit(w, { proto: 'pppoe', username: 'user@isp', password: 'secret', vlan: '6' });
    const ops = wanOps(d, w, n, q);
    const out = after(n, ops);
    expect(out.network.wan).toMatchObject({ proto: 'pppoe', device: 'wan.6', username: 'user@isp', password: 'secret' });
    expect(out.network.wan6!.device).toBe('wan.6');
    expect(ops).toContainEqual({ op: 'set', config: 'sqm', section: 'eth1', values: { interface: 'pppoe-wan' } });
  });

  it('keeps the stored PPPoE password unless a new one is typed, and drops it when leaving PPPoE', () => {
    const n = net();
    Object.assign(n.wan!, { proto: 'pppoe', username: 'u', password: 'old' });
    const w = normalizeWan(n, fw())!;
    expect(validateWan(wanDraft(w), w)).toEqual({});
    expect(wanOps(edit(w, { username: 'u2' }), w, n)).toEqual([{ op: 'set', config: 'network', section: 'wan', values: { username: 'u2' } }]);
    const out = after(n, wanOps(edit(w, { proto: 'dhcp' }), w, n));
    expect(out.network.wan!.password).toBeUndefined();
    expect(out.network.wan!.username).toBeUndefined();
  });

  it('adds a device section for a MAC clone, and disables wan6 when IPv6 is off', () => {
    const n = net();
    const w = normalizeWan(n, fw())!;
    const ops = wanOps(edit(w, { mac: '02-AA-BB-CC-DD-EE', ipv6: false }), w, n);
    expect(ops).toEqual([
      { op: 'set', config: 'network', section: 'wan6', values: { disabled: '1' } },
      { op: 'add', config: 'network', type: 'device', values: { name: 'wan', macaddr: '02:aa:bb:cc:dd:ee' } },
    ]);
  });

  it('turns manual DNS back to auto', () => {
    const n = net();
    Object.assign(n.wan!, { peerdns: '0', dns: ['9.9.9.9'] });
    const w = normalizeWan(n, fw())!;
    const out = after(n, wanOps(edit(w, { autoDns: true }), w, n));
    expect(out.network.wan!.peerdns).toBeUndefined();
    expect(out.network.wan!.dns).toBeUndefined();
  });

  it('leaves the options of an unmodelled protocol alone', () => {
    const n = net();
    Object.assign(n.wan!, { proto: 'l2tp', server: 'vpn.isp', username: 'u', password: 'p' });
    const w = normalizeWan(n, fw())!;
    expect(wanOps(edit(w, { vlan: '10' }), w, n)).toEqual([
      { op: 'set', config: 'network', section: 'wan', values: { device: 'wan.10' } },
      { op: 'set', config: 'network', section: 'wan6', values: { device: 'wan.10' } },
    ]);
  });

  it('is empty for an untouched draft', () => {
    const n = net();
    const w = normalizeWan(n, fw())!;
    expect(wanOps(wanDraft(w), w, n, sqm())).toEqual([]);
    const s = fixtures.uci.network();
    const ws = normalizeWan(s, fixtures.uci.firewall())!;
    expect(wanOps(wanDraft(ws), ws, s)).toEqual([]);
  });
});
