import { describe, expect, it } from 'vitest';
import { fixtures } from '../../test/fixtures';
import { diffSection } from '../api/uci';
import {
  blockOps,
  blockRuleValues,
  unblockOps,
  isPortSpec,
  normalizeBlockRules,
  newPortForward,
  normalizePortForwards,
  portForwardOps,
  validatePortForward,
  portForwardValues,
  zones,
} from './firewall';

describe('normalizePortForwards', () => {
  it('reads the recorded redirect', () => {
    expect(normalizePortForwards(fixtures.uci.firewall())).toEqual([
      {
        section: 'cfg0e3837',
        name: 'Web server',
        enabled: true,
        protocol: 'tcp udp',
        srcZone: 'wan',
        externalPort: '8080',
        srcIp: undefined,
        destZone: 'lan',
        destIp: '10.231.1.128',
        internalPort: '80',
      },
    ]);
  });

  it('reads proto stored as a list and defaults internal port to external', () => {
    const fw = fixtures.uci.firewall();
    fw.cfg0e3837!.proto = ['tcp'];
    delete fw.cfg0e3837!.dest_port;
    const [pf] = normalizePortForwards(fw);
    expect(pf).toMatchObject({ protocol: 'tcp', internalPort: '8080' });
  });

  it('round-trips through portForwardValues with no changes', () => {
    const fw = fixtures.uci.firewall();
    const [pf] = normalizePortForwards(fw);
    const { section, ...rest } = pf!;
    expect(diffSection('firewall', section, fw[section], portForwardValues(rest))).toEqual([]);
  });

  it('writes only what changed', () => {
    const fw = fixtures.uci.firewall();
    const [pf] = normalizePortForwards(fw);
    const { section, ...rest } = pf!;
    expect(
      diffSection('firewall', section, fw[section], portForwardValues({ ...rest, internalPort: '8080', enabled: false })),
    ).toEqual([
      { op: 'set', config: 'firewall', section, values: { enabled: '0' } },
      { op: 'unset', config: 'firewall', section, options: ['dest_port'] },
    ]);
  });
});

describe('normalizeBlockRules', () => {
  it('finds the recorded netui block rule', () => {
    expect(normalizeBlockRules(fixtures.uci.firewall())).toEqual([
      { section: 'cfg0f92bd', macs: ['da:a1:19:00:01:11'], enabled: false, managed: true, name: 'netui: block phone' },
    ]);
  });

  it('ignores port-scoped policies and the stock rules', () => {
    const fw = fixtures.uci.firewall();
    fw.cfg0f92bd!.dest_port = '443';
    expect(normalizeBlockRules(fw)).toEqual([]);
  });

  it('builds a block rule matching what it reads', () => {
    const v = blockRuleValues('da:a1:19:00:01:11', 'phone');
    expect(v).toEqual({
      name: 'netui: block phone',
      src: '*',
      dest: '*',
      src_mac: ['DA:A1:19:00:01:11'],
      target: 'REJECT',
    });
  });
});

describe('helpers', () => {
  it('validates port specs', () => {
    expect(isPortSpec('80')).toBe(true);
    expect(isPortSpec('8000-8100')).toBe(true);
    expect(isPortSpec('0')).toBe(false);
    expect(isPortSpec('70000')).toBe(false);
    expect(isPortSpec('90-80')).toBe(false);
    expect(isPortSpec('http')).toBe(false);
  });

  it('lists zones', () => {
    expect(zones(fixtures.uci.firewall())).toEqual([
      { name: 'lan', networks: ['lan'] },
      { name: 'wan', networks: ['wan', 'wan6'] },
    ]);
  });
});

describe('block ops', () => {
  const mac = 'da:a1:19:00:01:11';

  it('re-enables the disabled netui rule rather than adding another', () => {
    const [rule] = normalizeBlockRules(fixtures.uci.firewall());
    expect(blockOps(mac, 'phone', rule)).toEqual([
      { op: 'unset', config: 'firewall', section: 'cfg0f92bd', options: ['enabled'] },
    ]);
    expect(blockOps(mac, 'phone', { ...rule!, enabled: true })).toEqual([]);
    expect(blockOps('02:00:00:00:00:01', 'x', undefined)).toEqual([
      { op: 'add', config: 'firewall', type: 'rule', values: blockRuleValues('02:00:00:00:00:01', 'x') },
    ]);
  });

  it('deletes a single-MAC netui rule and trims a shared one', () => {
    const fw = fixtures.uci.firewall();
    const [rule] = normalizeBlockRules(fw);
    expect(unblockOps(mac, rule!, fw)).toEqual([{ op: 'delete', config: 'firewall', section: 'cfg0f92bd' }]);
    fw.cfg0f92bd!.src_mac = ['DA:A1:19:00:01:11', '02:00:00:00:00:02'];
    expect(unblockOps(mac, rule!, fw)).toEqual([
      { op: 'set', config: 'firewall', section: 'cfg0f92bd', values: { src_mac: ['02:00:00:00:00:02'] } },
    ]);
  });

  it('leaves rules it did not write alone', () => {
    const fw = fixtures.uci.firewall();
    const [rule] = normalizeBlockRules(fw);
    expect(unblockOps(mac, { ...rule!, managed: false }, fw)).toBeNull();
  });
});

describe('port forward editing', () => {
  const subnets = [{ network: 'lan', address: '10.231.1.0', prefix: 24, gateway: '10.231.1.2' }];

  it('produces no ops for the recorded forward unchanged', () => {
    const fw = fixtures.uci.firewall();
    const [{ section, ...pf }] = normalizePortForwards(fw) as [ReturnType<typeof normalizePortForwards>[0]];
    expect(portForwardOps(pf, section, fw)).toEqual([]);
    expect(validatePortForward(pf, subnets)).toEqual({});
  });

  it('adds a new forward without empty options', () => {
    const p = { ...newPortForward(), name: 'ssh', protocol: 'tcp', externalPort: '2222', destIp: '10.231.1.50', internalPort: '22' };
    expect(portForwardOps(p, undefined, fixtures.uci.firewall())).toEqual([
      {
        op: 'add',
        config: 'firewall',
        type: 'redirect',
        values: { name: 'ssh', target: 'DNAT', src: 'wan', dest: 'lan', proto: 'tcp', src_dport: '2222', dest_ip: '10.231.1.50', dest_port: '22' },
      },
    ]);
  });

  it('validates ports and destination', () => {
    const base = { ...newPortForward(), name: 'x', externalPort: '8000-8010', destIp: '10.231.1.50' };
    expect(validatePortForward(base, subnets)).toEqual({});
    expect(validatePortForward({ ...base, internalPort: '80' }, subnets)).toEqual({});
    expect(validatePortForward({ ...base, internalPort: '80-81' }, subnets).internalPort).toMatch(/same size/);
    expect(validatePortForward({ ...base, externalPort: '70000' }, subnets).externalPort).toBeDefined();
    expect(validatePortForward({ ...base, destIp: '192.168.9.9' }, subnets).destIp).toMatch(/local network/);
    expect(validatePortForward({ ...base, destIp: '10.231.1.2' }, subnets).destIp).toMatch(/router/);
    expect(validatePortForward({ ...base, srcIp: 'nope' }, subnets).srcIp).toBeDefined();
    expect(validatePortForward({ ...base, name: ' ' }, subnets).name).toBeDefined();
  });
});
