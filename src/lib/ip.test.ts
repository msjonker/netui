import { describe, expect, it } from 'vitest';
import {
  formatIPv4,
  hostAt,
  hostOffset,
  inSubnet,
  isIPv4,
  netmaskToPrefix,
  networkAddress,
  parseCidr,
  parseIPv4,
  prefixToNetmask,
} from './ip';

describe('ip', () => {
  it('round-trips IPv4', () => {
    expect(parseIPv4('192.168.1.1')).toBe(0xc0a80101);
    expect(formatIPv4(0xc0a80101)).toBe('192.168.1.1');
    expect(formatIPv4(parseIPv4('255.255.255.255')!)).toBe('255.255.255.255');
  });

  it('rejects invalid IPv4', () => {
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.a', '', '1..2.3']) {
      expect(isIPv4(bad)).toBe(false);
    }
  });

  it('converts between prefix and netmask', () => {
    expect(prefixToNetmask(24)).toBe('255.255.255.0');
    expect(prefixToNetmask(0)).toBe('0.0.0.0');
    expect(prefixToNetmask(32)).toBe('255.255.255.255');
    expect(netmaskToPrefix('255.255.255.0')).toBe(24);
    expect(netmaskToPrefix('255.255.0.255')).toBeNull();
    expect(() => prefixToNetmask(33)).toThrow(RangeError);
  });

  it('parses CIDR or address + netmask', () => {
    expect(parseCidr('10.0.0.1/8')).toEqual({ address: '10.0.0.1', prefix: 8 });
    expect(parseCidr('192.168.1.1', '255.255.255.0')).toEqual({ address: '192.168.1.1', prefix: 24 });
    expect(parseCidr('192.168.1.1')).toEqual({ address: '192.168.1.1', prefix: 32 });
    expect(parseCidr('192.168.1.1/33')).toBeNull();
  });

  it('tests subnet membership', () => {
    expect(inSubnet('192.168.1.77', '192.168.1.0', 24)).toBe(true);
    expect(inSubnet('192.168.2.1', '192.168.1.0', 24)).toBe(false);
    expect(inSubnet('8.8.8.8', '0.0.0.0', 0)).toBe(true);
  });
});

describe('subnet arithmetic', () => {
  it('computes network address, host offsets and back', () => {
    expect(networkAddress('10.0.1.7', 24)).toBe('10.0.1.0');
    expect(networkAddress('10.0.1.7', 0)).toBe('0.0.0.0');
    expect(hostAt('192.168.1.1', 24, 100)).toBe('192.168.1.100');
    expect(hostAt('192.168.0.1', 23, 300)).toBe('192.168.1.44');
    expect(hostOffset('192.168.1.150', '192.168.1.1', 24)).toBe(150);
    expect(hostOffset('192.168.2.1', '192.168.1.1', 24)).toBeNull();
  });
});
