import { describe, expect, it } from 'vitest';
import { fixtures } from '../../test/fixtures';
import { diffSection } from '../api/uci';
import type { UciConfig } from '../api/types';
import type { UciOp } from '../api/uci';
import {
  claimedWanPorts,
  dmzOps,
  dmzRanges,
  normalizeDmz,
  removePortForwardOps,
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

describe('DMZ', () => {
  const fw = fixtures.uci.firewall;
  /** Apply staged ops to a copy of the config, the way the router would. */
  let n = 0;
  const run = (cfg: UciConfig, ops: UciOp[]): UciConfig => {
    const out = structuredClone(cfg);
    for (const o of ops) {
      if (o.op === 'delete') delete out[o.section];
      else if (o.op === 'add') out[`new${n}`] = { '.name': `new${n}`, '.type': o.type, '.anonymous': true, '.index': 1000 + n++, ...o.values };
      else if (o.op === 'set') Object.assign(out[o.section]!, o.values);
    }
    return out;
  };

  it('leaves out the router\'s own WAN ports and the port forwards', () => {
    // Recorded: Allow-DHCP-Renew (udp 68, IPv4) and the "Web server" forward on 8080.
    // DHCPv6 (546) is IPv6 only and ISAKMP (500) is forwarded to lan: neither is claimed.
    expect(claimedWanPorts(fw())).toEqual([
      [68, 68],
      [8080, 8080],
    ]);
    expect(dmzRanges(claimedWanPorts(fw()))).toEqual(['1-67', '69-8079', '8081-65535']);
    expect(dmzRanges([[1, 1], [3, 4], [65535, 65535]])).toEqual(['2', '5-65534']);
    expect(dmzRanges([[2, 10], [5, 6]])).toEqual(['1', '11-65535']);
  });

  it('turns on as one redirect per gap, and off again', () => {
    const ops = dmzOps(fw(), { destIp: '10.231.1.128', destZone: 'lan' });
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      op: 'add',
      config: 'firewall',
      type: 'redirect',
      values: { name: 'netui: DMZ', target: 'DNAT', src: 'wan', dest: 'lan', proto: 'tcp udp', src_dport: '1-67', dest_ip: '10.231.1.128' },
    });
    const on = run(fw(), ops);
    expect(normalizeDmz(on)).toEqual({ destIp: '10.231.1.128', stale: false });
    // The DMZ is not listed as a port forward.
    expect(normalizePortForwards(on).map((p) => p.name)).toEqual(['Web server']);
    expect(normalizeDmz(run(on, dmzOps(on, null)))).toBeUndefined();
  });

  it('moves off a new port forward and takes a removed one\'s port back', () => {
    const on = run(fw(), dmzOps(fw(), { destIp: '10.231.1.128', destZone: 'lan' }));
    const added = run(on, portForwardOps({ ...newPortForward(), name: 'Game', externalPort: '3074', destIp: '10.231.1.50' }, undefined, on));
    expect(normalizeDmz(added)).toEqual({ destIp: '10.231.1.128', stale: false });
    expect(Object.values(added).filter((s) => s.name === 'netui: DMZ').map((s) => s.src_dport)).toEqual([
      '1-67',
      '69-3073',
      '3075-8079',
      '8081-65535',
    ]);
    const removed = run(on, removePortForwardOps('cfg0e3837', on));
    expect(Object.values(removed).filter((s) => s.name === 'netui: DMZ').map((s) => s.src_dport)).toEqual(['1-67', '69-65535']);
    // Without a DMZ, a forward is just the forward.
    expect(removePortForwardOps('cfg0e3837', fw())).toHaveLength(1);
  });

  it('notices when the router claims a port the DMZ still takes', () => {
    const on = run(fw(), dmzOps(fw(), { destIp: '10.231.1.128', destZone: 'lan' }));
    on.ssh = { '.name': 'ssh', '.type': 'rule', '.anonymous': false, '.index': 2000, src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT' };
    expect(normalizeDmz(on)?.stale).toBe(true);
  });
});
