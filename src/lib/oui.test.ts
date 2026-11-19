import { describe, expect, it } from 'vitest';
import { loadFullOuiTable, ouiVendor, vendorLabel } from './oui';
import { TABLE as FULL } from './ouiFull';
import { TABLE as SAMPLE } from './ouiSample';

// The tests run in order: the sample table first, then the full one loaded.

/** Prefixes per vendor in a table string, counted from the final digits. */
const counts = (table: string) =>
  Object.fromEntries(table.split('|').map((g) => [g.split(/[/:]/)[0], g.split(':')[1]!.replace(/[0-9a-v]/g, '').length]));

describe('OUI tables', () => {
  it('sample at most five prefixes per maker, from every maker in the full table', () => {
    const sample = counts(SAMPLE);
    const full = counts(FULL);
    expect(Object.keys(sample)).toEqual(Object.keys(full));
    for (const [name, n] of Object.entries(sample)) expect(n).toBe(Math.min(5, full[name]!));
  });
});

describe('OUI lookup before the full table loads', () => {
  it('uses the sample', () => {
    // ecobee has one prefix, so it is in the sample.
    expect(ouiVendor('44:61:32:aa:bb:cc')).toEqual({ name: 'ecobee', kind: 'iot' });
    expect(ouiVendor('00:00:00:00:00:01')).toBeUndefined();
  });
});

describe('OUI lookup with the full table', () => {
  it('finds every prefix of the listed makers in any MAC notation', async () => {
    await loadFullOuiTable();
    expect(ouiVendor('b8:27:eb:12:34:56')).toEqual({ name: 'Raspberry Pi', kind: 'computer' });
    expect(ouiVendor('B8-27-EB-12-34-56')?.name).toBe('Raspberry Pi');
    expect(ouiVendor('240AC4000001')).toEqual({ name: 'Espressif', kind: 'iot' });
    expect(ouiVendor('f0:18:98:00:00:01')).toEqual({ name: 'Apple', kind: undefined });
    expect(ouiVendor('04:18:0f:00:00:01')).toEqual({ name: 'Samsung', kind: 'tv' });
    expect(ouiVendor('00:0e:58:00:00:01')?.name).toBe('Sonos');
    expect(ouiVendor('18:b4:30:00:00:01')?.name).toBe('Nest');
    expect(ouiVendor('00:11:32:00:00:01')).toEqual({ name: 'Synology', kind: 'nas' });
  });

  it('decodes the first and last entry of a group', () => {
    // Raspberry Pi's prefixes run from 28:cd:c1 to e4:5f:01.
    expect(ouiVendor('28:cd:c1:aa:bb:cc')?.name).toBe('Raspberry Pi');
    expect(ouiVendor('e4:5f:01:aa:bb:cc')?.name).toBe('Raspberry Pi');
    expect(ouiVendor('44:61:32:aa:bb:cc')?.name).toBe('ecobee');
  });

  it('knows nothing about unlisted or malformed addresses', () => {
    expect(ouiVendor('00:00:00:00:00:01')).toBeUndefined();
    expect(ouiVendor('not a mac')).toBeUndefined();
    expect(vendorLabel('00:00:00:00:00:01')).toBeUndefined();
  });

  it('labels locally administered (randomized) MACs as private', () => {
    // The recorded dev-container phone and laptop both use private addresses.
    expect(vendorLabel('DA:A1:19:00:01:11')).toBe('Private address');
    expect(vendorLabel('02:4e:55:00:01:10')).toBe('Private address');
    expect(ouiVendor('02:4e:55:00:01:10')).toBeUndefined();
    expect(vendorLabel('b8:27:eb:00:00:01')).toBe('Raspberry Pi');
  });
});
