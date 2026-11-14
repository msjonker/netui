import { describe, expect, it } from 'vitest';
import { wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import type { UciConfig, UciGet } from '../api/types';
import mwan3Recorded from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.mwan3.json';
import { multiWanOps, readMultiWan, removeMultiWanOps, validateMultiWan, wan2Ports, type MultiWanDraft } from './multiwan';
import { normalizeSwitch } from './ports';

const mwan3 = () => structuredClone((mwan3Recorded as UciGet).values);

/** A DL-WRX36 recording plus the stock mwan3 config, as one router. */
function bench(name: 'plain' | 'vlan', cfg?: Record<string, UciConfig>) {
  const f = wrxFixtures(name);
  const configs = cfg ?? { network: f.uci.network(), firewall: f.uci.firewall(), mwan3: mwan3() };
  const sw = normalizeSwitch(configs.network!, configs.firewall, f.deviceStatus(), f.board());
  return { configs, sw, ctx: { network: configs.network!, firewall: configs.firewall!, mwan3: configs.mwan3!, sw }, f };
}

function apply(configs: Record<string, UciConfig>, ops: Parameters<typeof stageOn>[1]) {
  const r = new FakeRouter(configs);
  stageOn(r, ops);
  return { network: r.current('network')!, firewall: r.current('firewall')!, mwan3: r.current('mwan3')! };
}

const draft: MultiWanDraft = { port: 'lan4', proto: 'dhcp', address: '', prefix: '24', gateway: '', dns: '', mode: 'failover' };

describe('multi-WAN', () => {
  it('reads stock mwan3 as supported, without a WAN2', () => {
    const { configs } = bench('plain');
    expect(readMultiWan(configs.network!, configs.mwan3!)).toMatchObject({ supported: true, enabled: false, mode: 'balance' });
  });

  it('adds WAN2 on a LAN port: out of the bridge, into the wan zone, failover in mwan3', () => {
    const b = bench('plain');
    const next = apply(b.configs, multiWanOps(draft, b.ctx));
    expect(readMultiWan(next.network, next.mwan3)).toMatchObject({ enabled: true, port: 'lan4', proto: 'dhcp', mode: 'failover' });
    expect(next.network.wanb).toMatchObject({ proto: 'dhcp', device: 'lan4', metric: '20' });
    expect(next.network.wan!.metric).toBe('10');
    const zone = Object.values(next.firewall).find((z) => z.name === 'wan')!;
    expect(zone.network).toContain('wanb');
    expect(next.mwan3.https!.use_policy).toBe('wan_wanb');
    const sw = normalizeSwitch(next.network, next.firewall, b.f.deviceStatus(), b.f.board());
    expect(sw.ports.find((p) => p.name === 'lan4')).toMatchObject({ role: 'wan', wanLabel: 'WAN2' });
    expect(sw.ports.find((p) => p.name === 'wan')).toMatchObject({ role: 'wan', wanLabel: 'WAN' });
    expect(sw.ports.find((p) => p.name === 'lan3')!.role).toBe('lan');
  });

  it('takes the port out of every VLAN on a VLAN-filtering bridge', () => {
    const b = bench('vlan');
    const next = apply(b.configs, multiWanOps({ ...draft, mode: 'balance' }, b.ctx));
    const vlans = Object.values(next.network).filter((s) => s['.type'] === 'bridge-vlan');
    expect(vlans.length).toBeGreaterThan(1);
    for (const v of vlans) expect((v.ports as string[]).some((p) => p.startsWith('lan4'))).toBe(false);
    expect(readMultiWan(next.network, next.mwan3).mode).toBe('balance');
  });

  it('moves WAN2 to another port and puts the old one back on the LAN', () => {
    const b = bench('plain');
    const once = apply(b.configs, multiWanOps(draft, b.ctx));
    const b2 = bench('plain', once);
    const twice = apply(once, multiWanOps({ ...draft, port: 'lan3' }, b2.ctx));
    const sw = normalizeSwitch(twice.network, twice.firewall, b.f.deviceStatus(), b.f.board());
    expect(sw.ports.find((p) => p.name === 'lan3')!.role).toBe('wan');
    expect(sw.ports.find((p) => p.name === 'lan4')!.role).toBe('lan');
    expect(wan2Ports(sw, 'lan3').map((p) => p.name)).not.toContain('wan');
  });

  it('removes WAN2 again', () => {
    const b = bench('plain');
    const once = apply(b.configs, multiWanOps(draft, b.ctx));
    const back = apply(once, removeMultiWanOps(bench('plain', once).ctx));
    expect(back.network.wanb).toBeUndefined();
    expect(Object.values(back.firewall).find((z) => z.name === 'wan')!.network).not.toContain('wanb');
    expect(back.mwan3.wanb!.enabled).toBe('0');
    const sw = normalizeSwitch(back.network, back.firewall, b.f.deviceStatus(), b.f.board());
    expect(sw.ports.find((p) => p.name === 'lan4')!.role).toBe('lan');
  });

  it('writes a static WAN2 and validates it', () => {
    const b = bench('plain');
    const s: MultiWanDraft = { ...draft, proto: 'static', address: '203.0.113.10', prefix: '29', gateway: '203.0.113.9', dns: '1.1.1.1, 9.9.9.9' };
    expect(validateMultiWan(s)).toEqual({});
    const next = apply(b.configs, multiWanOps(s, b.ctx));
    expect(next.network.wanb).toMatchObject({ proto: 'static', ipaddr: '203.0.113.10/29', gateway: '203.0.113.9', dns: ['1.1.1.1', '9.9.9.9'] });
    expect(validateMultiWan({ ...s, gateway: '198.51.100.1' }).gateway).toMatch(/subnet/);
    expect(validateMultiWan({ ...s, port: '' }).port).toBeTruthy();
  });
});
