import { describe, expect, it } from 'vitest';
import type { UciGet } from '../api/types';
import { fixtures, wrxFixtures } from '../../test/fixtures';
import { stageOn, FakeRouter } from '../../test/fakeRouter';
import wrxPlainFirewall from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import { cellOps, essentialInputOps, pingOps, pingRule, policyMatrix, ROUTER, wanInputRules, zoneList } from './policy';

const plain = () => wrxFixtures('plain').uci.firewall();
const vlan = () => wrxFixtures('vlan').uci.firewall();

/** Verdict grid as "src>dest": "allow" | "block" (+N rules). */
function grid(fw: ReturnType<typeof plain>, uiZone?: string) {
  const m = policyMatrix(fw, uiZone);
  const out: Record<string, string> = {};
  for (const s of m.sources) {
    for (const d of m.dests) {
      const dest = typeof d === 'string' ? d : d.name;
      const c = m.cell(s.name, dest);
      out[`${s.name}>${dest === ROUTER ? 'router' : dest}`] = c.verdict + (c.rules.length ? `+${c.rules.length}` : '');
    }
  }
  return out;
}

describe('policyMatrix', () => {
  it('reads the factory DL-WRX36 firewall', () => {
    const typed: UciGet = wrxPlainFirewall;
    expect(zoneList(typed.values).map((z) => [z.name, z.internet])).toEqual([
      ['lan', false],
      ['wan', true],
    ]);
    expect(grid(plain())).toEqual({
      'lan>lan': 'allow',
      'lan>router': 'allow',
      'lan>wan': 'allow',
      // IPSec/ISAKMP rules make wan>lan custom; DHCP-renew, ping, IGMP, DHCPv6, MLD, ICMPv6 for the router.
      'wan>lan': 'block+3',
      'wan>router': 'block+6',
      'wan>wan': 'block+1',
    });
  });

  it('reads the isolated iot zone netui created', () => {
    expect(grid(vlan())).toEqual({
      'lan>lan': 'allow',
      'lan>iot': 'block',
      'lan>router': 'allow',
      'lan>wan': 'allow',
      'iot>lan': 'block',
      'iot>iot': 'block',
      'iot>router': 'block+2',
      'iot>wan': 'allow',
      'wan>lan': 'block+3',
      'wan>iot': 'block+1',
      'wan>router': 'block+6',
      'wan>wan': 'block+1',
    });
  });

  it('counts the dev router port forward and skips device blocks', () => {
    const m = policyMatrix(fixtures.uci.firewall());
    expect(m.cell('wan', 'lan').rules.map((r) => r.name)).toEqual(['Allow-ICMPv6-Forward', 'Allow-IPSec-ESP', 'Allow-ISAKMP', 'Web server']);
    // The netui block (src *) is not tied to a zone pair.
    expect(m.cell('lan', 'wan').rules).toEqual([]);
  });

  it('locks internet sources and the zone netui is reached through', () => {
    const m = policyMatrix(vlan(), 'lan');
    expect(m.cell('wan', 'lan').locked).toMatch(/Port Forwarding/);
    expect(m.cell('wan', ROUTER).locked).toMatch(/Router Access/);
    expect(m.cell('lan', ROUTER).locked).toMatch(/connected through/);
    expect(m.cell('iot', ROUTER).locked).toBeUndefined();
    expect(policyMatrix(vlan()).cell('lan', ROUTER).locked).toBeUndefined();
  });

  it('ignores disabled forwardings', () => {
    const fw = plain();
    fw.cfg04ad58!.enabled = '0';
    expect(policyMatrix(fw).cell('lan', 'wan').verdict).toBe('block');
  });
});

describe('cellOps', () => {
  it('adds and removes forwardings between zones', () => {
    const fw = vlan();
    const m = policyMatrix(fw);
    expect(cellOps(m.cell('lan', 'iot'), 'allow', fw)).toEqual([
      { op: 'add', config: 'firewall', type: 'forwarding', values: { src: 'lan', dest: 'iot' } },
    ]);
    expect(cellOps(m.cell('iot', 'wan'), 'block', fw)).toEqual([{ op: 'delete', config: 'firewall', section: 'cfg10ad58' }]);
    expect(cellOps(m.cell('iot', 'wan'), 'allow', fw)).toEqual([]);
  });

  it('re-enables a disabled forwarding instead of adding another', () => {
    const fw = plain();
    fw.cfg04ad58!.enabled = '0';
    expect(cellOps(policyMatrix(fw).cell('lan', 'wan'), 'allow', fw)).toEqual([
      { op: 'unset', config: 'firewall', section: 'cfg04ad58', options: ['enabled'] },
    ]);
  });

  it('changes zone input and keeps DHCP and DNS open when blocking', () => {
    const fw = plain();
    const ops = cellOps(policyMatrix(fw).cell('lan', ROUTER), 'block', fw);
    expect(ops).toEqual([
      { op: 'set', config: 'firewall', section: 'cfg02dc81', values: { input: 'REJECT' } },
      ...essentialInputOps(fw, 'lan'),
    ]);
    expect(ops).toHaveLength(3);
    // iot already has both rules.
    const v = vlan();
    expect(essentialInputOps(v, 'iot')).toEqual([]);
    expect(cellOps(policyMatrix(v).cell('iot', ROUTER), 'allow', v)).toEqual([
      { op: 'set', config: 'firewall', section: 'cfg0fdc81', values: { input: 'ACCEPT' } },
    ]);
  });

  it('changes the intra-zone forward policy', () => {
    const fw = vlan();
    expect(cellOps(policyMatrix(fw).cell('iot', 'iot'), 'allow', fw)).toEqual([
      { op: 'set', config: 'firewall', section: 'cfg0fdc81', values: { forward: 'ACCEPT' } },
    ]);
  });

  it('never touches locked cells', () => {
    const fw = vlan();
    const m = policyMatrix(fw, 'lan');
    expect(cellOps(m.cell('wan', 'lan'), 'allow', fw)).toEqual([]);
    expect(cellOps(m.cell('wan', ROUTER), 'allow', fw)).toEqual([]);
    expect(cellOps(m.cell('lan', ROUTER), 'block', fw)).toEqual([]);
  });

  it('stages cleanly on the fake router', () => {
    const r = new FakeRouter({ firewall: vlan() });
    const fw = r.configs.firewall!;
    const after = stageOn(r, cellOps(policyMatrix(fw).cell('lan', 'iot'), 'allow', fw)).firewall!;
    expect(policyMatrix(after).cell('lan', 'iot').verdict).toBe('allow');
  });
});

describe('router access', () => {
  it('finds the stock ping rule and the other wan input rules', () => {
    const fw = plain();
    expect(pingRule(fw)).toMatchObject({ section: 'cfg0692bd', name: 'Allow-Ping', enabled: true });
    expect(wanInputRules(fw).map((r) => r.name)).toEqual([
      'Allow-DHCP-Renew',
      'Allow-Ping',
      'Allow-IGMP',
      'Allow-DHCPv6',
      'Allow-MLD',
      'Allow-ICMPv6-Input',
    ]);
  });

  it('toggles ping by the enabled flag', () => {
    const fw = plain();
    expect(pingOps(fw, true)).toEqual([]);
    expect(pingOps(fw, false)).toEqual([{ op: 'set', config: 'firewall', section: 'cfg0692bd', values: { enabled: '0' } }]);
    fw.cfg0692bd!.enabled = '0';
    expect(pingOps(fw, true)).toEqual([{ op: 'unset', config: 'firewall', section: 'cfg0692bd', options: ['enabled'] }]);
  });

  it('recreates a deleted ping rule', () => {
    const fw = plain();
    delete fw.cfg0692bd;
    expect(pingOps(fw, false)).toEqual([]);
    expect(pingOps(fw, true)).toEqual([
      {
        op: 'add',
        config: 'firewall',
        type: 'rule',
        values: { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' },
      },
    ]);
  });
});
