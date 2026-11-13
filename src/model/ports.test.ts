import { describe, expect, it } from 'vitest';
import { vmFixtures, fixtures, wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import { currentPlan, normalizeSwitch, parseMember, profileOf, renumberPlan, switchOps, validateVid } from './ports';

const sw = (name: 'plain' | 'vlan') => {
  const f = vmFixtures(name);
  return normalizeSwitch(f.uci.network(), f.uci.firewall(), f.deviceStatus(), f.board());
};

/** Normalize again after staging ops on a fake router loaded with the scenario. */
function after(name: 'plain' | 'vlan', ops: Parameters<typeof stageOn>[1]) {
  const f = vmFixtures(name);
  const cfg = stageOn(new FakeRouter({}, name), ops);
  return { cfg, sw: normalizeSwitch(cfg.network!, cfg.firewall, f.deviceStatus(), f.board()) };
}

describe('parseMember', () => {
  it('reads UCI and status notations', () => {
    expect(parseMember('eth0:u*')).toMatchObject({ port: 'eth0', tagged: false, pvid: true });
    expect(parseMember('eth0:*')).toMatchObject({ port: 'eth0', tagged: false, pvid: true });
    expect(parseMember('eth2:t')).toMatchObject({ port: 'eth2', tagged: true, pvid: false });
    expect(parseMember('eth2:t*')).toMatchObject({ tagged: true, pvid: true });
    expect(parseMember('eth3')).toMatchObject({ port: 'eth3', tagged: false, pvid: false });
  });
});

describe('normalizeSwitch', () => {
  it('models a plain bridge as VLAN 1 native on every member', () => {
    const s = sw('plain');
    expect(s).toMatchObject({ bridge: 'br-lan', vlanFiltering: false, unsupported: undefined });
    expect(s.vlans).toEqual([expect.objectContaining({ vid: 1, networks: ['lan'] })]);
    expect(s.vlans[0]!.section).toBeUndefined();
    expect(s.ports.map((p) => [p.name, p.role, p.profile.native])).toEqual([
      ['eth0', 'lan', 1],
      ['eth1', 'wan', undefined],
      ['eth2', 'lan', 1],
      ['eth3', 'lan', 1],
      ['eth4', 'lan', 1],
    ]);
  });

  it('reads native, tagged and extra untagged membership from bridge-vlans', () => {
    const s = sw('vlan');
    expect(s.vlanFiltering).toBe(true);
    expect(s.vlans.map((v) => [v.vid, v.networks])).toEqual([
      [1, ['lan']],
      [20, ['iot']],
    ]);
    const byName = Object.fromEntries(s.ports.map((p) => [p.name, p]));
    expect(byName.eth0).toMatchObject({ profile: { native: 1, tagged: [] }, irregular: false });
    expect(byName.eth2).toMatchObject({ profile: { native: 1, tagged: [20] }, irregular: false });
    // u* in 1 plus bare in 20: untagged egress on a VLAN that is not its PVID.
    expect(byName.eth3).toMatchObject({ profile: { native: 1, tagged: [], untagged: [20] }, irregular: false });
    // Bare and only in 20: the kernel makes 20 its PVID.
    expect(byName.eth4).toMatchObject({ profile: { native: 20, tagged: [] }, irregular: false });
  });

  it('agrees with the live bridge-vlans the kernel reports', () => {
    const s = sw('vlan');
    const live = vmFixtures('vlan').deviceStatus()['br-lan']!['bridge-vlans']!;
    const liveVlans = live.map((v) => ({ vid: v.id, members: v.ports.map(parseMember), networks: [] }));
    for (const p of s.ports.filter((x) => x.role === 'lan')) {
      expect(profileOf(p.name, liveVlans).profile).toEqual(p.profile);
    }
  });

  it('finds the ports of the dev container, which lists only one per role in board.json', () => {
    const s = normalizeSwitch(fixtures.uci.network(), fixtures.uci.firewall(), fixtures.deviceStatus(), fixtures.board());
    expect(s.ports.map((p) => [p.name, p.role])).toEqual([
      ['eth0', 'lan'],
      ['eth1', 'wan'],
    ]);
  });

  it('takes the port list from board.json on DSA-style boards, leaving out the conduit', () => {
    const f = vmFixtures('plain');
    const devices = f.deviceStatus();
    // Pretend eth0 is a DSA conduit and eth2-eth4 the user ports.
    const s = normalizeSwitch(f.uci.network(), f.uci.firewall(), devices, {
      network: { lan: { ports: ['eth2', 'eth3', 'eth4'] }, wan: { device: 'eth1' } },
    });
    // eth0 is still a bridge member in this config, so it stays listed.
    expect(s.ports.map((p) => p.name)).toEqual(['eth0', 'eth1', 'eth2', 'eth3', 'eth4']);
    const net = f.uci.network();
    const br = Object.values(net).find((x) => x.name === 'br-lan')!;
    br.ports = ['eth2', 'eth3', 'eth4'];
    const s2 = normalizeSwitch(net, f.uci.firewall(), devices, {
      network: { lan: { ports: ['eth2', 'eth3', 'eth4'] }, wan: { device: 'eth1' } },
    });
    expect(s2.ports.map((p) => p.name)).toEqual(['eth1', 'eth2', 'eth3', 'eth4']);
  });

  it('reads the DSA ports of a real DL-WRX36 from board.json', () => {
    const f = wrxFixtures('plain');
    const s = normalizeSwitch(f.uci.network(), f.uci.firewall(), f.deviceStatus(), f.board());
    expect(s.unsupported).toBeUndefined();
    expect(s.ports.map((p) => [p.name, p.role, p.profile])).toEqual([
      ['lan1', 'lan', { tagged: [], native: 1 }],
      ['lan2', 'lan', { tagged: [], native: 1 }],
      ['lan3', 'lan', { tagged: [], native: 1 }],
      ['lan4', 'lan', { tagged: [], native: 1 }],
      ['wan', 'wan', { tagged: [] }],
    ]);
    expect(s.ports.find((p) => p.name === 'lan1')).toMatchObject({ carrier: true, speed: 1000 });

    // A port taken out of every bridge is still a port, not hidden with the conduit.
    const net = f.uci.network();
    Object.values(net).find((x) => x.name === 'br-lan')!.ports = ['lan1', 'lan2', 'lan3'];
    const s2 = normalizeSwitch(net, f.uci.firewall(), f.deviceStatus(), f.board());
    expect(s2.ports.find((p) => p.name === 'lan4')).toMatchObject({ role: 'unused', profile: { tagged: [] } });
  });

  it('agrees with the live bridge-vlans of a real DL-WRX36 after netui added a VLAN', () => {
    const f = wrxFixtures('vlan');
    const s = normalizeSwitch(f.uci.network(), f.uci.firewall(), f.deviceStatus(), f.board());
    expect(s.vlanFiltering).toBe(true);
    expect(s.ports.map((p) => [p.name, p.profile])).toEqual([
      ['lan1', { native: 1, tagged: [10] }],
      ['lan2', { native: 1, tagged: [10] }],
      ['lan3', { native: 1, tagged: [10] }],
      ['lan4', { native: 1, tagged: [10] }],
      ['wan', { tagged: [] }],
    ]);
    const live = f.deviceStatus()['br-lan']!['bridge-vlans']!;
    const liveVlans = live.map((v) => ({ vid: v.id, members: v.ports.map(parseMember), networks: [] }));
    for (const p of s.ports.filter((x) => x.role === 'lan')) {
      expect(profileOf(p.name, liveVlans).profile).toEqual(p.profile);
    }
  });

  it('refuses layouts it would misread', () => {
    const f = vmFixtures('plain');
    const net = f.uci.network();
    net.guest = { '.anonymous': false, '.index': 9, '.name': 'guest', '.type': 'interface', device: 'br-lan.5', proto: 'static' };
    expect(normalizeSwitch(net, f.uci.firewall(), f.deviceStatus(), f.board()).unsupported).toBe('custom');
    net.sw = { '.anonymous': false, '.index': 10, '.name': 'sw', '.type': 'switch', name: 'switch0' };
    expect(normalizeSwitch(net, f.uci.firewall(), f.deviceStatus(), f.board()).unsupported).toBe('swconfig');
  });
});

describe('switchOps', () => {
  it('changes nothing for the current plan', () => {
    for (const name of ['plain', 'vlan'] as const) {
      const s = sw(name);
      expect(switchOps(s, currentPlan(s), vmFixtures(name).uci.network())).toEqual([]);
    }
  });

  it('keeps a plain bridge plain when a port is only taken out', () => {
    const s = sw('plain');
    const plan = currentPlan(s);
    plan.profiles.eth4 = { tagged: [] };
    const ops = switchOps(s, plan, vmFixtures('plain').uci.network());
    expect(ops).toEqual([{ op: 'set', config: 'network', section: s.section, values: { ports: ['eth0', 'eth2', 'eth3'] } }]);
  });

  it('converts a plain bridge the way LuCI does when a port gets a tagged VLAN', () => {
    const s = sw('plain');
    const plan = currentPlan(s);
    plan.vlans.push({ vid: 30, networks: [] });
    plan.profiles.eth2 = { native: 1, tagged: [30] };
    const { cfg, sw: next } = after('plain', switchOps(s, plan, vmFixtures('plain').uci.network()));
    expect(cfg.network!.lan!.device).toBe('br-lan.1');
    const vlans = Object.values(cfg.network!).filter((x) => x['.type'] === 'bridge-vlan');
    expect(vlans.map((v) => [v.vlan, v.ports])).toEqual([
      ['1', ['eth0:u*', 'eth2:u*', 'eth3:u*', 'eth4:u*']],
      ['30', ['eth2:t']],
    ]);
    expect(next.ports.find((p) => p.name === 'eth2')!.profile).toEqual({ native: 1, tagged: [30] });
  });

  it('reads a tagged PVID and several PVIDs as irregular', () => {
    const vlans = [
      { vid: 1, members: ['a:u*', 'b:t*'].map(parseMember), networks: [] },
      { vid: 2, members: ['a:u*', 'b:t'].map(parseMember), networks: [] },
    ];
    expect(profileOf('a', vlans)).toEqual({ profile: { native: 1, tagged: [] }, irregular: true });
    expect(profileOf('b', vlans)).toEqual({ profile: { native: 1, tagged: [2] }, irregular: true });
  });

  it('rewrites only the ports that changed, keeping stored tokens elsewhere', () => {
    const s = sw('vlan');
    const plan = currentPlan(s);
    plan.profiles.eth0 = { native: 1, tagged: [20] };
    const ops = switchOps(s, plan, vmFixtures('vlan').uci.network());
    // eth3 is untouched: still a bare "eth3" in VLAN 20.
    expect(ops).toEqual([
      { op: 'set', config: 'network', section: 'cfg08a1b0', values: { ports: ['eth2:t', 'eth3', 'eth4', 'eth0:t'] } },
    ]);
  });

  it('keeps extra untagged membership through unrelated edits, and drops it on request', () => {
    const s = sw('vlan');
    const plan = currentPlan(s);
    plan.vlans.push({ vid: 30, networks: [] });
    plan.profiles.eth3 = { native: 1, tagged: [30], untagged: [20] };
    const { sw: mid, cfg } = after('vlan', switchOps(s, plan, vmFixtures('vlan').uci.network()));
    expect(cfg.network!.cfg08a1b0!.ports).toEqual(['eth2:t', 'eth3', 'eth4']);
    expect(mid.ports.find((p) => p.name === 'eth3')!.profile).toEqual({ native: 1, tagged: [30], untagged: [20] });

    const plan2 = currentPlan(mid);
    plan2.profiles.eth3 = { native: 1, tagged: [20, 30] };
    const cfg2 = stageOn(new FakeRouter(cfg), switchOps(mid, plan2, cfg.network!));
    expect(cfg2.network!.cfg08a1b0!.ports).toEqual(['eth2:t', 'eth3:t', 'eth4']);
  });

  it('takes a port with no VLANs out of the bridge', () => {
    const s = sw('vlan');
    const plan = currentPlan(s);
    plan.profiles.eth4 = { tagged: [] };
    const { cfg, sw: next } = after('vlan', switchOps(s, plan, vmFixtures('vlan').uci.network()));
    expect(cfg.network!.cfg030f15!.ports).toEqual(['eth0', 'eth2', 'eth3']);
    expect(cfg.network!.cfg08a1b0!.ports).toEqual(['eth2:t', 'eth3']);
    expect(next.ports.find((p) => p.name === 'eth4')!.role).toBe('unused');
  });

  it('puts an unused port back into the bridge', () => {
    const s = sw('vlan');
    const plan = currentPlan(s);
    plan.profiles.eth4 = { tagged: [] };
    const { sw: mid, cfg } = after('vlan', switchOps(s, plan, vmFixtures('vlan').uci.network()));
    const plan2 = currentPlan(mid);
    plan2.profiles.eth4 = { native: 20, tagged: [1] };
    const r = new FakeRouter(cfg);
    const cfg2 = stageOn(r, switchOps(mid, plan2, cfg.network!));
    expect(cfg2.network!.cfg030f15!.ports).toEqual(['eth0', 'eth2', 'eth3', 'eth4']);
    expect(cfg2.network!.cfg07a1b0!.ports).toEqual(['eth0:u*', 'eth2:u*', 'eth3:u*', 'eth4:t']);
    expect(cfg2.network!.cfg08a1b0!.ports).toEqual(['eth2:t', 'eth3', 'eth4:u*']);
  });

  it('renumbers a VLAN and the interface on it', () => {
    const s = sw('vlan');
    const { cfg, sw: next } = after('vlan', switchOps(s, renumberPlan(currentPlan(s), 20, 25), vmFixtures('vlan').uci.network()));
    expect(cfg.network!.iot!.device).toBe('br-lan.25');
    expect(cfg.network!.cfg08a1b0!.vlan).toBe('25');
    expect(next.ports.find((p) => p.name === 'eth2')!.profile).toEqual({ native: 1, tagged: [25] });
    expect(next.ports.find((p) => p.name === 'eth4')!.profile).toEqual({ native: 25, tagged: [] });
  });
});

describe('validateVid', () => {
  it('accepts free IDs in range only', () => {
    expect(validateVid('30', [1, 20])).toBeNull();
    expect(validateVid('20', [1, 20])).toMatch(/in use/);
    expect(validateVid('0', [])).toMatch(/1 to 4094/);
    expect(validateVid('4095', [])).toMatch(/1 to 4094/);
    expect(validateVid('1e3', [])).toMatch(/number/);
  });
});
