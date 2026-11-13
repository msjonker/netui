import { describe, expect, it } from 'vitest';
import { fixtures, wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import type { Subnet } from './network';
import {
  newTrafficRule,
  normalizeTrafficRules,
  readDraft,
  ruleValues,
  scheduleLabel,
  trafficRuleOps,
  validateTrafficRule,
  type TrafficRuleDraft,
} from './trafficRules';

const subnets: Subnet[] = [
  { network: 'lan', address: '192.168.1.0', prefix: 24, gateway: '192.168.1.1' },
  { network: 'iot', address: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' },
];
const ctx = () => ({ fw: wrxFixtures('vlan').uci.firewall(), subnets });

const bedtime: TrafficRuleDraft = {
  ...newTrafficRule(),
  name: 'Kids bedtime',
  source: 'devices',
  macs: ['da:a1:19:00:01:11'],
  schedule: 'custom',
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sun'],
  start: '21:30',
  stop: '07:00',
};

describe('traffic rule ops', () => {
  it('blocks devices from the internet on a schedule', () => {
    expect(trafficRuleOps(bedtime, undefined, ctx())).toEqual([
      {
        op: 'add',
        config: 'firewall',
        type: 'rule',
        values: {
          name: 'netui: rule Kids bedtime',
          src: '*',
          src_mac: ['DA:A1:19:00:01:11'],
          dest: 'wan',
          proto: 'all',
          target: 'REJECT',
          weekdays: 'Mon Tue Wed Thu Sun',
          start_time: '21:30',
          stop_time: '07:00',
        },
      },
    ]);
  });

  it('allows a port from an isolated network to one LAN host', () => {
    const d: TrafficRuleDraft = {
      ...newTrafficRule('iot'),
      name: 'Printer',
      action: 'allow',
      dest: 'ip',
      destIp: '192.168.1.40',
      proto: 'tcp',
      port: '631, 9100',
    };
    expect(validateTrafficRule(d, ctx())).toEqual({});
    expect(ruleValues(d, ctx())).toMatchObject({
      src: 'iot',
      src_ip: [],
      dest: '*',
      dest_ip: ['192.168.1.40'],
      proto: 'tcp',
      dest_port: '631 9100',
      target: 'ACCEPT',
      weekdays: '',
    });
  });

  it('narrows by subnet when the zone holds several networks', () => {
    const c = ctx();
    c.fw.cfg02dc81!.network = ['lan', 'iot'];
    const d = { ...newTrafficRule('iot'), name: 'x', dest: 'network' as const, destNetwork: 'lan' };
    expect(ruleValues(d, c)).toMatchObject({ src: 'lan', src_ip: ['192.168.10.0/24'], dest: 'lan', dest_ip: ['192.168.1.0/24'] });
  });

  it('round-trips every draft shape through the router', () => {
    const drafts: TrafficRuleDraft[] = [
      bedtime,
      { ...newTrafficRule('lan'), name: 'No IoT', dest: 'network', destNetwork: 'iot', enabled: false },
      { ...newTrafficRule(), name: 'Ban range', source: 'ip', srcIp: '192.168.1.200/29 192.168.1.10', proto: 'udp', port: '53' },
      { ...newTrafficRule('iot'), name: 'Nights', schedule: 'custom', days: [], start: '', stop: '06:00' },
    ];
    for (const d of drafts) {
      const r = new FakeRouter({ firewall: wrxFixtures('vlan').uci.firewall() });
      const fw = stageOn(r, trafficRuleOps(d, undefined, { fw: r.configs.firewall!, subnets })).firewall!;
      const rule = normalizeTrafficRules({ fw, subnets }).find((x) => x.managed)!;
      expect(rule.draft).toEqual(d);
      // Unchanged: no ops.
      expect(trafficRuleOps(rule.draft!, rule.section, { fw, subnets })).toEqual([]);
    }
  });

  it('writes only what changed and clears dropped options', () => {
    const r = new FakeRouter({ firewall: wrxFixtures('vlan').uci.firewall() });
    const fw = stageOn(r, trafficRuleOps(bedtime, undefined, { fw: r.configs.firewall!, subnets })).firewall!;
    const [rule] = normalizeTrafficRules({ fw, subnets }).filter((x) => x.managed);
    expect(trafficRuleOps({ ...rule!.draft!, schedule: 'always', action: 'allow' }, rule!.section, { fw, subnets })).toEqual([
      { op: 'set', config: 'firewall', section: rule!.section, values: { target: 'ACCEPT' } },
      { op: 'unset', config: 'firewall', section: rule!.section, options: ['weekdays', 'start_time', 'stop_time'] },
    ]);
  });
});

describe('normalizeTrafficRules', () => {
  it('lists other forward rules read-only and leaves blocks and input rules out', () => {
    const rules = normalizeTrafficRules({ fw: fixtures.uci.firewall(), subnets });
    expect(rules.map((r) => [r.name, r.managed])).toEqual([
      ['Allow-ICMPv6-Forward', false],
      ['Allow-IPSec-ESP', false],
      ['Allow-ISAKMP', false],
    ]);
  });

  it('shows a netui rule edited into something it cannot express as read-only', () => {
    const c = ctx();
    c.fw.x = { '.type': 'rule', '.name': 'x', '.index': 99, '.anonymous': false, name: 'netui: rule odd', src: 'lan', dest: 'wan', target: 'REJECT', log: '1' };
    const [rule] = normalizeTrafficRules(c).filter((r) => r.managed);
    expect(rule).toMatchObject({ name: 'odd', managed: true, draft: undefined });
  });

  it('reads LuCI-style weekdays and seconds', () => {
    const d = readDraft(
      { '.type': 'rule', '.name': 'y', '.index': 1, '.anonymous': true, name: 'netui: rule y', src: 'iot', dest: 'wan', target: 'DROP', weekdays: 'Saturday sun', start_time: '08:00:00' },
      ctx(),
    );
    expect(d).toMatchObject({ srcNetwork: 'iot', action: 'block', proto: 'tcp udp', days: ['Sat', 'Sun'], start: '08:00', stop: '' });
    expect(readDraft({ '.type': 'rule', '.name': 'z', '.index': 1, '.anonymous': true, name: 'netui: rule z', src: 'iot', dest: 'wan', target: 'DROP', weekdays: '!Mon' }, ctx())).toBeUndefined();
  });
});

describe('validation and labels', () => {
  it('rejects incomplete drafts', () => {
    const base = { ...newTrafficRule(), name: 'x' };
    expect(validateTrafficRule(base, ctx())).toEqual({});
    expect(validateTrafficRule({ ...base, name: '' }, ctx()).name).toBeDefined();
    expect(validateTrafficRule({ ...base, srcNetwork: 'guest' }, ctx()).srcNetwork).toBeDefined();
    expect(validateTrafficRule({ ...base, source: 'devices' }, ctx()).macs).toBeDefined();
    expect(validateTrafficRule({ ...base, source: 'ip', srcIp: 'nope' }, ctx()).srcIp).toBeDefined();
    expect(validateTrafficRule({ ...base, dest: 'network', destNetwork: 'lan' }, ctx()).destNetwork).toMatch(/different/);
    expect(validateTrafficRule({ ...base, proto: 'tcp', port: '99999' }, ctx()).port).toBeDefined();
    expect(validateTrafficRule({ ...base, schedule: 'custom' }, ctx()).days).toBeDefined();
    expect(validateTrafficRule({ ...base, schedule: 'custom', start: '25:00' }, ctx()).start).toBeDefined();
    expect(validateTrafficRule({ ...base, schedule: 'custom', start: '08:00', stop: '08:00' }, ctx()).stop).toBeDefined();
  });

  it('describes schedules', () => {
    expect(scheduleLabel(newTrafficRule())).toBe('Always');
    expect(scheduleLabel(bedtime)).toBe('Mon-Thu, Sun 21:30-07:00');
    expect(scheduleLabel({ schedule: 'custom', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '', stop: '06:00' })).toBe('Mon-Fri until 06:00');
    expect(scheduleLabel({ schedule: 'custom', days: [], start: '22:00', stop: '' })).toBe('Every day from 22:00');
  });
});
