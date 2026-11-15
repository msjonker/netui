import { describe, expect, it } from 'vitest';
import type { UciConfig } from '../api/types';
import dohDhcp from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.dhcp.doh-active.json';
import { wrxFixtures } from '../../test/fixtures';
import { stageOn, FakeRouter } from '../../test/fakeRouter';
import {
  dnsRecordOps,
  dnsSettingsOps,
  findDhcpOption,
  isHostname,
  isIPv6,
  normalizeDnsRecords,
  normalizeDnsSettings,
  readDhcpDns,
  readDhcpDomain,
  setDhcpOption,
  validateDnsRecord,
  validateDnsSettings,
} from './dns';

const dhcp = () => wrxFixtures('plain').uci.dhcp();

describe('DHCP option helpers', () => {
  const foreign = ['tag:kids,6,1.1.1.3', '42,192.168.1.1', 'option:dns-server,9.9.9.9,149.112.112.112,1.1.1.1'];

  it('finds untagged entries by number or name only', () => {
    expect(findDhcpOption(foreign, 6)).toEqual(['option:dns-server,9.9.9.9,149.112.112.112,1.1.1.1']);
    expect(findDhcpOption(foreign, 42)).toEqual(['42,192.168.1.1']);
  });

  it('replaces option 6 in place and keeps every other entry', () => {
    expect(setDhcpOption(foreign, 6, ['1.1.1.1'])).toEqual(['tag:kids,6,1.1.1.3', '42,192.168.1.1', '6,1.1.1.1']);
    expect(setDhcpOption(['6,8.8.8.8', '42,10.0.0.1'], 6, ['1.1.1.1', '9.9.9.9'])).toEqual(['6,1.1.1.1,9.9.9.9', '42,10.0.0.1']);
    expect(setDhcpOption(['42,10.0.0.1'], 6, ['1.1.1.1'])).toEqual(['42,10.0.0.1', '6,1.1.1.1']);
  });

  it('drops option 6 for auto and leaves the rest alone', () => {
    expect(setDhcpOption(['6,1.1.1.1', 'tag:kids,6,1.1.1.3', '15,lan'], 6, [])).toEqual(['tag:kids,6,1.1.1.3', '15,lan']);
  });

  it('reads auto, manual and custom DNS', () => {
    expect(readDhcpDns([])).toEqual({ mode: 'auto', servers: [], raw: [] });
    expect(readDhcpDns(['42,1.2.3.4', '6,1.1.1.1,9.9.9.9'])).toMatchObject({ mode: 'manual', servers: ['1.1.1.1', '9.9.9.9'] });
    expect(readDhcpDns(['6,1.1.1.1,9.9.9.9,8.8.8.8']).mode).toBe('custom');
    expect(readDhcpDns(['option:dns-server,1.1.1.1']).mode).toBe('custom');
    expect(readDhcpDns(['6,1.1.1.1', '6,9.9.9.9']).mode).toBe('custom');
    expect(readDhcpDns(['6,0.0.0.0']).mode).toBe('manual');
  });

  it('reads option 15', () => {
    expect(readDhcpDomain(['6,1.1.1.1', '15,home.arpa'])).toBe('home.arpa');
    expect(readDhcpDomain(['option:domain-name,example.lan'])).toBe('example.lan');
    expect(readDhcpDomain([])).toBe('');
  });
});

describe('validators', () => {
  it('checks host names and IPv6', () => {
    expect(isHostname('nas.lan')).toBe(true);
    expect(isHostname('-bad')).toBe(false);
    expect(isHostname('a b')).toBe(false);
    expect(isIPv6('fd00::1')).toBe(true);
    expect(isIPv6('2001:db8:0:0:0:0:0:1')).toBe(true);
    expect(isIPv6('1::2::3')).toBe(false);
  });
});

describe('dnsmasq settings', () => {
  it('reads the recorded defaults', () => {
    expect(normalizeDnsSettings(dhcp())).toEqual({
      section: 'cfg01411c',
      servers: [],
      domain: 'lan',
      rebindProtection: true,
      rebindAllowed: [],
      encrypted: false,
    });
  });

  it('leaves the DNS over HTTPS proxy its servers and noresolv (recorded while it ran)', () => {
    const cfg: UciConfig = dohDhcp.values;
    const s = normalizeDnsSettings(cfg)!;
    expect(s).toMatchObject({ servers: [], encrypted: true });
    const ops = dnsSettingsOps({ ...s, domain: 'home.arpa', servers: ['9.9.9.9'] }, cfg);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'set', values: { domain: 'home.arpa', local: '/home.arpa/' } });
    expect(JSON.stringify(ops)).not.toMatch(/server|noresolv/);
  });

  it('sets upstream servers with noresolv, keeps forwarding entries, and moves local with the domain', () => {
    const cfg = dhcp();
    cfg.cfg01411c!.server = ['/corp.example/10.8.0.1'];
    const d = normalizeDnsSettings(cfg)!;
    const next = { ...d, servers: ['1.1.1.1', '9.9.9.9#53'], domain: 'home.arpa', rebindAllowed: ['plex.direct'] };
    expect(validateDnsSettings(next)).toEqual({});
    const out = stageOn(new FakeRouter({ dhcp: cfg }), dnsSettingsOps(next, cfg));
    expect(out.dhcp!.cfg01411c).toMatchObject({
      server: ['1.1.1.1', '9.9.9.9#53', '/corp.example/10.8.0.1'],
      noresolv: '1',
      domain: 'home.arpa',
      local: '/home.arpa/',
      rebind_domain: ['plex.direct'],
      rebind_protection: '1',
    });
  });

  it('going back to the ISP servers removes noresolv', () => {
    const cfg = dhcp();
    Object.assign(cfg.cfg01411c!, { server: ['1.1.1.1'], noresolv: '1' });
    const d = normalizeDnsSettings(cfg)!;
    expect(dnsSettingsOps({ ...d, servers: [] }, cfg)).toEqual([
      { op: 'unset', config: 'dhcp', section: 'cfg01411c', options: ['server', 'noresolv'] },
    ]);
  });

  it('rejects bad servers and domains', () => {
    const d = normalizeDnsSettings(dhcp())!;
    expect(validateDnsSettings({ ...d, servers: ['dns.google'], domain: 'a b' })).toEqual({
      servers: '"dns.google" is not an IP address.',
      domain: expect.any(String),
    });
  });
});

describe('local DNS records', () => {
  it('reads domain and cname sections', () => {
    const cfg = dhcp();
    cfg.d1 = { '.anonymous': true, '.index': 9, '.name': 'd1', '.type': 'domain', name: 'nas', ip: '192.168.1.10' };
    cfg.c1 = { '.anonymous': true, '.index': 10, '.name': 'c1', '.type': 'cname', cname: 'files', target: 'nas' };
    expect(normalizeDnsRecords(cfg)).toEqual([
      { kind: 'A', section: 'd1', name: 'nas', value: '192.168.1.10' },
      { kind: 'CNAME', section: 'c1', name: 'files', value: 'nas' },
    ]);
  });

  it('adds, edits and changes the kind of a record', () => {
    const cfg = dhcp();
    cfg.d1 = { '.anonymous': true, '.index': 9, '.name': 'd1', '.type': 'domain', name: 'nas', ip: '192.168.1.10' };
    const prev = normalizeDnsRecords(cfg)[0];
    expect(dnsRecordOps({ kind: 'A', name: 'printer', value: '192.168.1.20' }, undefined, cfg)).toEqual([
      { op: 'add', config: 'dhcp', type: 'domain', values: { name: 'printer', ip: '192.168.1.20' } },
    ]);
    expect(dnsRecordOps({ kind: 'A', section: 'd1', name: 'nas', value: '192.168.1.11' }, prev, cfg)).toEqual([
      { op: 'set', config: 'dhcp', section: 'd1', values: { ip: '192.168.1.11' } },
    ]);
    expect(dnsRecordOps({ kind: 'CNAME', section: 'd1', name: 'nas', value: 'storage' }, prev, cfg)).toEqual([
      { op: 'delete', config: 'dhcp', section: 'd1' },
      { op: 'add', config: 'dhcp', type: 'cname', values: { cname: 'nas', target: 'storage' } },
    ]);
  });

  it('validates records', () => {
    const all = [{ kind: 'A' as const, section: 'd1', name: 'nas', value: '192.168.1.10' }];
    expect(validateDnsRecord({ kind: 'A', name: 'nas', value: 'x' }, all)).toEqual({ value: expect.any(String) });
    expect(validateDnsRecord({ kind: 'CNAME', name: 'nas', value: 'other' }, all).name).toMatch(/already/);
    expect(validateDnsRecord({ kind: 'CNAME', name: 'files', value: 'files' }, all).value).toMatch(/itself/);
    expect(validateDnsRecord({ kind: 'A', name: 'tv', value: 'fd00::5' }, all)).toEqual({});
  });
});

describe('dnsmasq settings without server changes', () => {
  it('leaves noresolv alone when only the domain changes', () => {
    const cfg = wrxFixtures('plain').uci.dhcp();
    cfg.cfg01411c!.server = ['8.8.8.8'];
    const d = normalizeDnsSettings(cfg)!;
    expect(dnsSettingsOps({ ...d, domain: 'home' }, cfg)).toEqual([
      { op: 'set', config: 'dhcp', section: 'cfg01411c', values: { domain: 'home', local: '/home/' } },
    ]);
  });
});
