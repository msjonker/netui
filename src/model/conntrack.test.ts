import { describe, expect, it } from 'vitest';
import type { ConnectionsReply } from '../api/types';
import recorded from '../../test/fixtures/ubus/dl-wrx36/plain/netui.traffic.connections.json';
import { parseConntrack, parseConntrackLine, shortIPv6 } from './conntrack';

const reply: ConnectionsReply = recorded;

describe('parseConntrack on the recorded table', () => {
  it('keeps the live connections and drops TIME_WAIT', () => {
    const lines = reply.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(240);
    const entries = parseConntrack(reply.text);
    // 227 of the 240 lines are closed connections (the gateway's probes of its access points).
    expect(entries).toHaveLength(13);
    expect(entries.find((e) => e.layer4 === 'tcp' && e.dport === 443)).toEqual({
      layer4: 'tcp',
      src: '192.168.1.228',
      dst: '192.168.1.1',
      sport: 37188,
      dport: 443,
      bytes: 4326 + 5960,
      zone: '0',
    });
    // The kernel calls IGMP "unknown 2".
    expect(entries.find((e) => e.layer4 === 'igmp')).toEqual({ layer4: 'igmp', src: '0.0.0.0', dst: '224.0.0.1', bytes: 0, zone: '0' });
  });
});

describe('parseConntrackLine', () => {
  it('reads an unreplied UDP flow: original direction, both directions summed', () => {
    expect(
      parseConntrackLine(
        'ipv4     2 udp      17 29 src=192.168.1.20 dst=203.0.113.5 sport=5353 dport=53 packets=1 bytes=60 [UNREPLIED] src=203.0.113.5 dst=192.168.1.20 sport=53 dport=5353 packets=0 bytes=0 mark=0 zone=0 use=2',
      ),
    ).toEqual({ layer4: 'udp', src: '192.168.1.20', dst: '203.0.113.5', sport: 5353, dport: 53, bytes: 60, zone: '0' });
  });

  it('reads ICMP (no ports) and IPv6 in the short form', () => {
    expect(
      parseConntrackLine(
        'ipv4     2 icmp     1 29 src=192.168.1.13 dst=203.0.113.3 type=8 code=0 id=3 packets=1 bytes=84 src=203.0.113.3 dst=192.168.1.13 type=0 code=0 id=3 packets=1 bytes=84 mark=0 zone=0 use=2',
      ),
    ).toEqual({ layer4: 'icmp', src: '192.168.1.13', dst: '203.0.113.3', bytes: 168, zone: '0' });
    expect(
      parseConntrackLine(
        'ipv6     10 tcp      6 431999 ESTABLISHED src=2001:0db8:0000:0000:0000:0000:0000:0002 dst=2001:0db8:ffff:0000:0000:0000:0000:0002 sport=30002 dport=443 packets=8 bytes=900 src=2001:0db8:ffff:0000:0000:0000:0000:0002 dst=2001:0db8:0000:0000:0000:0000:0000:0002 sport=443 dport=30002 packets=9 bytes=12000 [ASSURED] mark=0 zone=0 use=2',
      ),
    ).toMatchObject({ src: '2001:db8::2', dst: '2001:db8:ffff::2', bytes: 12900 });
  });

  it('names protocols the kernel prints as unknown, and works without zones', () => {
    expect(
      parseConntrackLine('ipv4     2 unknown  47 599 src=192.168.1.5 dst=198.51.100.1 packets=4 bytes=400 src=198.51.100.1 dst=192.168.1.5 packets=4 bytes=500 mark=0 use=2'),
    ).toEqual({ layer4: 'gre', src: '192.168.1.5', dst: '198.51.100.1', bytes: 900 });
    expect(parseConntrackLine('ipv4     2 unknown  132 59 src=192.168.1.5 dst=198.51.100.1 packets=1 bytes=10 src=198.51.100.1 dst=192.168.1.5 packets=0 bytes=0 mark=0 use=2')?.layer4).toBe('proto 132');
  });

  it('leaves out TIME_WAIT, loopback and lines without a tuple', () => {
    expect(
      parseConntrackLine(
        'ipv4     2 tcp      6 47 TIME_WAIT src=192.168.1.228 dst=192.168.1.1 sport=50090 dport=22 packets=0 bytes=0 src=192.168.1.1 dst=192.168.1.228 sport=22 dport=50090 packets=0 bytes=0 [ASSURED] mark=0 zone=0 use=2',
      ),
    ).toBeNull();
    expect(
      parseConntrackLine(
        'ipv6     10 udp      17 20 src=0000:0000:0000:0000:0000:0000:0000:0001 dst=0000:0000:0000:0000:0000:0000:0000:0001 sport=4000 dport=53 packets=1 bytes=70 src=0000:0000:0000:0000:0000:0000:0000:0001 dst=0000:0000:0000:0000:0000:0000:0000:0001 sport=53 dport=4000 packets=1 bytes=90 mark=0 zone=0 use=2',
      ),
    ).toBeNull();
    expect(parseConntrackLine('ipv4     2 udp      17 29 src=127.0.0.1 dst=127.0.0.1 sport=1 dport=53 packets=1 bytes=1 src=127.0.0.1 dst=127.0.0.1 sport=53 dport=1 packets=1 bytes=1 mark=0 zone=0 use=2')).toBeNull();
    expect(parseConntrackLine('')).toBeNull();
    expect(parseConntrackLine('ipv4     2 tcp      6 300 ESTABLISHED src=192.168.1.2')).toBeNull();
  });
});

describe('shortIPv6', () => {
  it('shortens the longest run of zero groups, lowercase', () => {
    expect(shortIPv6('fe80:0000:0000:0000:f652:46ff:fe08:DCA6')).toBe('fe80::f652:46ff:fe08:dca6');
    expect(shortIPv6('0000:0000:0000:0000:0000:0000:0000:0001')).toBe('::1');
    expect(shortIPv6('ff02:0000:0000:0000:0000:0000:0001:0002')).toBe('ff02::1:2');
    expect(shortIPv6('2001:0db8:0000:0001:0000:0000:0000:0001')).toBe('2001:db8:0:1::1');
    expect(shortIPv6('2001:0db8:0001:0002:0003:0004:0005:0006')).toBe('2001:db8:1:2:3:4:5:6');
    expect(shortIPv6('0000:0000:0000:0000:0000:0000:0000:0000')).toBe('::');
  });
});
