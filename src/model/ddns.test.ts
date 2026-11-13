import { describe, expect, it } from 'vitest';
import type { DdnsServicesStatus, UciConfig, UciGet } from '../api/types';
import ddnsJson from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.ddns.json';
import statusJson from '../../test/fixtures/ubus/dl-wrx36/plain/luci.ddns.get_services_status.json';
import { ddnsDraft, ddnsOps, ddnsSectionName, ddnsState, normalizeDdns, validateDdns } from './ddns';

const recorded: { cfg: UciGet; status: DdnsServicesStatus } = { cfg: ddnsJson, status: statusJson };
const cfg = (): UciConfig => structuredClone(recorded.cfg.values);

describe('normalizeDdns', () => {
  it('shows the factory examples as not configured', () => {
    const s = normalizeDdns(cfg());
    expect(s.map((x) => [x.section, x.provider, x.ipv6, x.placeholder, x.enabled])).toEqual([
      ['myddns_ipv4', 'dyndns.org', false, true, false],
      ['myddns_ipv6', '', true, true, false],
    ]);
    expect(ddnsState(s[0]!, recorded.status.myddns_ipv4)).toEqual({ tone: 'neutral', label: 'Not configured' });
  });

  it('reports a real service by its run state', () => {
    const c = cfg();
    Object.assign(c.myddns_ipv4!, { lookup_host: 'home.duckdns.org', domain: 'home.duckdns.org', service_name: 'duckdns.org', enabled: '1' });
    const s = normalizeDdns(c)[0]!;
    expect(s.placeholder).toBe(false);
    expect(ddnsState(s, recorded.status.myddns_ipv4)).toEqual({ tone: 'warn', label: 'Stopped' });
    expect(ddnsState(s, { ...recorded.status.myddns_ipv4!, pid: 123 })).toEqual({ tone: 'ok', label: 'Running' });
  });
});

describe('ddnsOps', () => {
  it('adds a new service on the WAN, named after the host', () => {
    const c = cfg();
    const d = { ...ddnsDraft(), provider: 'duckdns.org', hostname: 'home.duckdns.org', password: 'tok' };
    expect(validateDdns(d)).toEqual({});
    expect(ddnsOps(d, undefined, c, 'wan', 'wan6')).toEqual([
      {
        op: 'add',
        config: 'ddns',
        type: 'service',
        name: 'home_duckdns_org',
        values: {
          enabled: '1',
          service_name: 'duckdns.org',
          lookup_host: 'home.duckdns.org',
          domain: 'home.duckdns.org',
          password: 'tok',
          interface: 'wan',
          ip_source: 'network',
          ip_network: 'wan',
        },
      },
    ]);
  });

  it('fills in the IPv6 example, replacing its custom update_url', () => {
    const c = cfg();
    const s = normalizeDdns(c)[1]!;
    const d = { ...ddnsDraft(s), provider: 'dynv6.com', hostname: 'me.dynv6.net', password: 'tok' };
    expect(d.ipv6).toBe(true);
    expect(ddnsOps(d, s, c, 'wan', 'wan6')).toEqual([
      {
        op: 'set',
        config: 'ddns',
        section: 'myddns_ipv6',
        values: { enabled: '1', service_name: 'dynv6.com', lookup_host: 'me.dynv6.net', domain: 'me.dynv6.net', password: 'tok' },
      },
      { op: 'unset', config: 'ddns', section: 'myddns_ipv6', options: ['update_url', 'username'] },
    ]);
  });

  it('keeps the stored password on edit and requires one for examples', () => {
    const c = cfg();
    Object.assign(c.myddns_ipv4!, { lookup_host: 'a.example.org', domain: 'a.example.org' });
    const s = normalizeDdns(c)[0]!;
    expect(validateDdns(ddnsDraft(s), s)).toEqual({});
    expect(ddnsOps({ ...ddnsDraft(s), enabled: true }, s, c, 'wan', 'wan6')).toEqual([
      { op: 'set', config: 'ddns', section: 'myddns_ipv4', values: { enabled: '1' } },
    ]);
    const ex = normalizeDdns(cfg())[0]!;
    expect(validateDdns({ ...ddnsDraft(ex), hostname: 'yourhost.example.com' }, ex)).toEqual({
      hostname: 'Replace the example hostname with yours.',
      password: 'Enter the password or token from your provider.',
    });
  });

  it('derives unique section names', () => {
    expect(ddnsSectionName('home.duckdns.org', false, { home_duckdns_org: {} as never })).toBe('home_duckdns_org_2');
    expect(ddnsSectionName('1.example', true, {})).toBe('ddns_1_example_v6');
  });
});
