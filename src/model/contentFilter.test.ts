import { describe, expect, it } from 'vitest';
import { wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import type { Subnet } from './network';
import { filterOps, normalizeFilters } from './contentFilter';
import { normalizeTrafficRules } from './trafficRules';
import { policyMatrix } from './policy';

const subnets: Subnet[] = [
  { network: 'lan', address: '192.168.1.0', prefix: 24, gateway: '192.168.1.1' },
  { network: 'iot', address: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' },
];

function router() {
  const f = wrxFixtures('vlan');
  return new FakeRouter({ network: f.uci.network(), dhcp: f.uci.dhcp(), firewall: f.uci.firewall() });
}

const read = (r: FakeRouter) => normalizeFilters(['lan', 'iot'], r.current('dhcp')!, r.current('firewall')!);
const ctx = (r: FakeRouter) => ({ dhcp: r.current('dhcp')!, fw: r.current('firewall')!, subnets });

describe('content filtering', () => {
  it('starts off on the recorded router', () => {
    expect(read(router())).toEqual([
      { network: 'lan', level: 'none', pool: 'lan', zone: 'lan', rule: undefined, foreignDns: [], incomplete: false },
      { network: 'iot', level: 'none', pool: 'iot', zone: 'iot', rule: undefined, foreignDns: [], incomplete: false },
    ]);
  });

  it('turns on family filtering for a network: DHCP DNS plus a bypass block', () => {
    const r = router();
    const [, iot] = read(r);
    const ops = filterOps(iot!, 'family', ctx(r));
    expect(ops).toEqual([
      {
        op: 'set',
        config: 'dhcp',
        section: 'iot',
        values: { dhcp_option: ['6,1.1.1.3,1.0.0.3'], dns: ['2606:4700:4700::1113', '2606:4700:4700::1003'] },
      },
      {
        op: 'add',
        config: 'firewall',
        type: 'rule',
        values: {
          name: 'netui: filter iot',
          src: 'iot',
          dest: 'wan',
          dest_ip: ['!1.1.1.3', '!1.0.0.3', '!2606:4700:4700::1113', '!2606:4700:4700::1003'],
          proto: ['tcp', 'udp'],
          dest_port: ['53', '853'],
          target: 'REJECT',
        },
      },
    ]);
    stageOn(r, ops);
    expect(read(r)[1]).toMatchObject({ level: 'family', incomplete: false });
    // Shows up in the matrix, not in the traffic rule list.
    expect(normalizeTrafficRules({ fw: r.current('firewall')!, subnets })).toHaveLength(3);
    expect(policyMatrix(r.current('firewall')!).cell('iot', 'wan').rules.map((x) => x.name)).toEqual(['netui: filter iot']);
  });

  it('switches level and turns off, keeping foreign dhcp options', () => {
    const r = router();
    r.configs.dhcp!.lan!.dhcp_option = ['3,192.168.1.1', '42,192.168.1.1'];
    stageOn(r, filterOps(read(r)[0]!, 'family', ctx(r)));
    expect(r.current('dhcp')!.lan!.dhcp_option).toEqual(['3,192.168.1.1', '42,192.168.1.1', '6,1.1.1.3,1.0.0.3']);

    const malware = filterOps(read(r)[0]!, 'malware', ctx(r));
    stageOn(r, malware);
    expect(read(r)[0]).toMatchObject({ level: 'malware', incomplete: false });
    expect(r.current('dhcp')!.lan!.dhcp_option).toEqual(['3,192.168.1.1', '42,192.168.1.1', '6,1.1.1.2,1.0.0.2']);
    expect(r.current('firewall')![read(r)[0]!.rule!]!.dest_ip).toEqual([
      '!1.1.1.2',
      '!1.0.0.2',
      '!2606:4700:4700::1112',
      '!2606:4700:4700::1002',
    ]);

    stageOn(r, filterOps(read(r)[0]!, 'none', ctx(r)));
    expect(read(r)[0]).toMatchObject({ level: 'none', rule: undefined });
    expect(r.current('dhcp')!.lan!.dhcp_option).toEqual(['3,192.168.1.1', '42,192.168.1.1']);
    expect(r.current('dhcp')!.lan!.dns).toBeUndefined();
  });

  it('overrides custom DNS in place and only removes its own servers', () => {
    const r = router();
    r.configs.dhcp!.lan!.dhcp_option = ['3,192.168.1.1', '6,9.9.9.9', '42,192.168.1.1'];
    r.configs.dhcp!.lan!.dns = ['2620:fe::fe'];
    const [lan] = read(r);
    expect(lan).toMatchObject({ level: 'none', foreignDns: ['9.9.9.9', '2620:fe::fe'] });
    expect(lan!.blocker).toBeUndefined();

    stageOn(r, filterOps(lan!, 'malware', ctx(r)));
    expect(r.current('dhcp')!.lan!.dhcp_option).toEqual(['3,192.168.1.1', '6,1.1.1.2,1.0.0.2', '42,192.168.1.1']);
    expect(r.current('dhcp')!.lan!.dns).toEqual(['2606:4700:4700::1112', '2606:4700:4700::1002']);
    expect(read(r)[0]).toMatchObject({ level: 'malware', foreignDns: [] });

    // Someone sets custom DNS again on the Networks page; switching the filter off keeps it.
    r.current('dhcp')!.lan!.dhcp_option = ['3,192.168.1.1', '6,8.8.8.8', '42,192.168.1.1'];
    const now = read(r)[0]!;
    expect(now).toMatchObject({ level: 'malware', incomplete: true });
    stageOn(r, filterOps(now, 'none', ctx(r)));
    expect(r.current('dhcp')!.lan!.dhcp_option).toEqual(['3,192.168.1.1', '6,8.8.8.8', '42,192.168.1.1']);
    expect(r.current('dhcp')!.lan!.dns).toBeUndefined();
    expect(read(r)[0]).toMatchObject({ level: 'none', rule: undefined });
  });

  it('flags a half-applied filter', () => {
    const r = router();
    r.configs.dhcp!.iot!.dhcp_option = ['6,1.1.1.2,1.0.0.2'];
    expect(read(r)[1]).toMatchObject({ level: 'malware', incomplete: true });
  });

  it('narrows a shared zone by subnet and stays IPv4-only there', () => {
    const r = router();
    r.configs.firewall!.cfg02dc81!.network = ['lan', 'iot'];
    r.configs.firewall!.cfg0fdc81!.network = [];
    const [, iot] = read(r);
    const add = filterOps(iot!, 'malware', ctx(r))[1]!;
    expect(add).toMatchObject({
      op: 'add',
      values: { src: 'lan', src_ip: '192.168.10.0/24', dest_ip: ['!1.1.1.2', '!1.0.0.2'] },
    });
  });

  it('cannot filter a network without DHCP', () => {
    const r = router();
    r.configs.dhcp!.iot!.ignore = '1';
    expect(read(r)[1]!.blocker).toMatch(/DHCP is off/);
  });
});
