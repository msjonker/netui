import { describe, expect, it } from 'vitest';
import type { ConntrackEntry, ConntrackList } from '../api/types';
import recorded from '../../test/fixtures/ubus/dl-wrx36/plain/luci.getConntrackList.json';
import { inPrefix6, localPredicate, serviceName, topBytes, topClientsByUsage, TrafficTracker } from './traffic';

const table: ConntrackList = recorded;

// The DL-WRX36's LAN, as in its recorded interface dump.
const isLocal = localPredicate({
  subnets: [{ network: 'lan', address: '192.168.1.0', prefix: 24, gateway: '192.168.1.1' }],
  prefixes6: [{ address: 'fd00:5191:f25a::', mask: 60 }],
  router: ['fd00:5191:f25a::1'],
});

function conn(over: Partial<ConntrackEntry>): ConntrackEntry {
  return { layer3: 'ipv4', layer4: 'tcp', src: '192.168.1.137', dst: '93.184.215.14', sport: 50000, dport: 443, bytes: 0, packets: 0, timeout: 100, zone: '0', ...over };
}

describe('localPredicate', () => {
  it('accepts LAN hosts and rejects the router, loopback and the internet', () => {
    expect(isLocal('192.168.1.137')).toBe(true);
    expect(isLocal('192.168.1.1')).toBe(false);
    expect(isLocal('127.0.0.1')).toBe(false);
    expect(isLocal('8.8.8.8')).toBe(false);
    expect(isLocal('fd00:5191:f25a::abcd')).toBe(true);
    expect(isLocal('fd00:5191:f25a:f::2')).toBe(true); // inside the /60
    expect(isLocal('fd00:5191:f25a:10::2')).toBe(false);
    expect(isLocal('fd00:5191:f25a::1')).toBe(false);
    expect(isLocal('fe80::1')).toBe(false);
    expect(isLocal('2001:db8::1')).toBe(false);
  });

  it('matches IPv6 prefixes bit by bit', () => {
    expect(inPrefix6('2001:db8:0:ff::1', '2001:db8::', 56)).toBe(true);
    expect(inPrefix6('2001:db8:0:100::1', '2001:db8::', 56)).toBe(false);
    expect(inPrefix6('::1', '::', 0)).toBe(true);
    expect(inPrefix6('garbage', '::', 0)).toBe(false);
  });
});

describe('TrafficTracker on the recorded table', () => {
  it('attributes DNS lookups to the laptop and skips the router talking to itself', () => {
    const t = new TrafficTracker();
    t.add(table.result, 1_000, isLocal);
    // 20 entries: 7 on loopback (v4 and v6), 13 from the laptop to the router's DNS.
    expect(t.active).toBe(13);
    expect(t.conns).toHaveLength(13);
    expect(t.conns[0]).toMatchObject({ local: '192.168.1.137', remote: '192.168.1.1', port: 53, service: 'DNS', outbound: true, rate: null });
    // The first poll is the baseline: nothing counted yet.
    expect(t.hosts.get('192.168.1.137')).toMatchObject({ total: 0, rate: null });
  });
});

describe('TrafficTracker deltas', () => {
  it('turns two polls into a rate and a running total', () => {
    const t = new TrafficTracker();
    const a = conn({ bytes: 10_000 });
    const b = conn({ sport: 50001, dport: 80, bytes: 500 });
    t.add([a, b], 10_000, isLocal);
    t.add([{ ...a, bytes: 60_000 }, { ...b, bytes: 500 }], 15_000, isLocal);
    const h = t.hosts.get('192.168.1.137')!;
    expect(h.total).toBe(50_000);
    expect(h.rate).toBe(10_000); // 50 KB over 5 s
    expect(h.points.toArray()).toEqual([
      { t: 10, v: null },
      { t: 15, v: 10_000 },
    ]);
    expect(t.conns.find((c) => c.port === 443)!.rate).toBe(10_000);
    expect(topBytes(t.services, 5)).toEqual([['HTTPS', 50_000]]);
    expect(topBytes(t.remotes, 5)).toEqual([['93.184.215.14', 50_000]]);
  });

  it('counts a connection that opened between polls in full, and a reused tuple from zero', () => {
    const t = new TrafficTracker();
    const a = conn({ bytes: 9_000 });
    t.add([a], 0 + 1, isLocal);
    t.add([{ ...a, bytes: 1_000 }, conn({ sport: 4242, bytes: 2_000 })], 5_001, isLocal);
    expect(t.hosts.get('192.168.1.137')!.total).toBe(3_000);
  });

  it('attributes inbound connections to the LAN side and IPv6 by prefix', () => {
    const t = new TrafficTracker();
    const inbound = conn({ src: '203.0.113.9', dst: '192.168.1.50', sport: 40000, dport: 22 });
    const v6 = conn({ layer3: 'ipv6', src: 'fd00:5191:f25a::77', dst: '2a00:1450::5', dport: 443, layer4: 'udp' });
    t.add([inbound, v6], 1, isLocal);
    t.add([{ ...inbound, bytes: 5_000 }, { ...v6, bytes: 10_000 }], 5_001, isLocal);
    expect(t.conns.map((c) => [c.local, c.remote, c.service, c.outbound])).toEqual([
      ['192.168.1.50', '203.0.113.9', 'SSH', false],
      ['fd00:5191:f25a::77', '2a00:1450::5', 'QUIC', true],
    ]);
    expect(t.hosts.get('192.168.1.50')!.total).toBe(5_000);
    expect(t.host(['192.168.1.50', 'fd00:5191:f25a::77'])).toMatchObject({ total: 15_000, rate: 3_000 });
  });

  it('drops a host to zero when its connections end, and leaves a gap after a long pause', () => {
    const t = new TrafficTracker();
    const a = conn({ bytes: 100 });
    t.add([a], 1, isLocal);
    t.add([{ ...a, bytes: 5_100 }], 5_001, isLocal);
    t.add([], 10_001, isLocal);
    expect(t.hosts.get('192.168.1.137')!.rate).toBe(0);
    t.add([conn({ sport: 1, bytes: 7_000 })], 70_001, isLocal);
    const h = t.hosts.get('192.168.1.137')!;
    expect(h.rate).toBeNull();
    expect(h.total).toBe(12_000);
  });

  it('ignores a poll it has already seen', () => {
    const t = new TrafficTracker();
    expect(t.add([], 5, isLocal)).toBe(true);
    expect(t.add([], 5, isLocal)).toBe(false);
  });
});

describe('serviceName', () => {
  it('names well-known ports and falls back to protocol and port', () => {
    expect(serviceName('tcp', 443)).toBe('HTTPS');
    expect(serviceName('udp', 443)).toBe('QUIC');
    expect(serviceName('udp', 53)).toBe('DNS');
    expect(serviceName('tcp', 8123)).toBe('TCP 8123');
    expect(serviceName('icmp', undefined)).toBe('ICMP');
  });
});

describe('topClientsByUsage', () => {
  const host = (ip: string, total: number, rate: number | null) => [ip, { ip, total, rate, points: undefined as never }] as const;
  it('sums every address of a client, drops idle ones and ranks by bytes', () => {
    const hosts = new Map([host('10.0.0.2', 500, 10), host('fd00::2', 700, 5), host('10.0.0.3', 900, null), host('10.0.0.4', 0, 0)]);
    const clients = [
      { mac: 'a', ips: ['10.0.0.2', 'fd00::2'] },
      { mac: 'b', ips: ['10.0.0.3'] },
      { mac: 'c', ips: ['10.0.0.4'] },
    ];
    expect(topClientsByUsage(clients, (c) => c.ips, hosts, 5).map((x) => [x.client.mac, x.total, x.rate])).toEqual([
      ['a', 1200, 15],
      ['b', 900, 0],
    ]);
  });
});
