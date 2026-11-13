import { describe, expect, it } from 'vitest';
import { isLocallyAdministered, isMac, normalizeMac } from './mac';

describe('mac', () => {
  it('normalizes common notations to lowercase colon form', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aabbccddeeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac(' aa:bb:cc:dd:ee:ff ')).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('rejects malformed and mixed-separator input', () => {
    expect(normalizeMac('aa:bb:cc:dd:ee')).toBeNull();
    expect(normalizeMac('aa:bb-cc:dd:ee:ff')).toBeNull();
    expect(normalizeMac('gg:bb:cc:dd:ee:ff')).toBeNull();
    expect(isMac('')).toBe(false);
  });

  it('detects locally administered (randomized) addresses', () => {
    expect(isLocallyAdministered('da:a1:19:00:00:01')).toBe(true);
    expect(isLocallyAdministered('00:1a:2b:3c:4d:5e')).toBe(false);
  });
});
