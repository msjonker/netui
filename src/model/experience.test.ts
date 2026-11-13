import { describe, expect, it } from 'vitest';
import { averageExperience, clientExperience, maxLinkRate, wifiExperience } from './experience';
import type { Client } from './clients';

describe('maxLinkRate', () => {
  it('is the two-stream top rate of the radio mode', () => {
    expect(maxLinkRate('HE80')).toBeCloseTo(1201);
    expect(maxLinkRate('VHT80')).toBeCloseTo(866.6);
    expect(maxLinkRate('HT20')).toBeCloseTo(144.4);
    expect(maxLinkRate('HE20')).toBeCloseTo(286.8);
  });

  it('assumes WiFi 6 at the usual width when the mode is unknown', () => {
    expect(maxLinkRate(undefined, '2.4 GHz')).toBeCloseTo(286.8);
    expect(maxLinkRate(undefined, '5 GHz')).toBeCloseTo(1201);
  });
});

describe('wifiExperience', () => {
  it('scores a strong, fast client as excellent', () => {
    const e = wifiExperience({ signal: -45, txRate: 1080, rxRate: 960, inactive: 20, htmode: 'HE80' });
    expect(e.score).toBeGreaterThanOrEqual(90);
    expect(e).toMatchObject({ label: 'Excellent', tone: 'ok', reasons: [] });
  });

  it('penalizes a weak signal and a low rate, and says why', () => {
    const e = wifiExperience({ signal: -78, txRate: 6, rxRate: 1, inactive: 100, htmode: 'HE80' });
    expect(e.score).toBeLessThan(50);
    expect(e.tone).toBe('bad');
    expect(e.reasons).toEqual(['Very weak signal (-78 dBm)', 'Low link rate (6 of 1201 Mbps possible)']);
  });

  it('is fair in between', () => {
    const e = wifiExperience({ signal: -66, txRate: 200, rxRate: 150, inactive: 0, htmode: 'HE80' });
    expect(e).toMatchObject({ label: 'Fair', tone: 'warn' });
  });

  it('ignores the stale rate of an idle station and rates it on signal', () => {
    const idle = wifiExperience({ signal: -50, txRate: 6, rxRate: 6, inactive: 15_000, htmode: 'HE80' });
    expect(idle.score).toBe(100);
    expect(idle.reasons).toEqual(['Idle: rated on signal only']);
  });

  it('marks down a station not heard from for over a minute', () => {
    const e = wifiExperience({ signal: -50, txRate: 600, rxRate: 600, inactive: 90_000, htmode: 'HE80' });
    expect(e.score).toBe(80);
    expect(e.reasons).toContain('Not heard from for 90 s');
  });

  it('stays within 0..100', () => {
    expect(wifiExperience({ signal: -95, txRate: 0, rxRate: 0, inactive: 120_000 }).score).toBe(0);
    expect(wifiExperience({ signal: -20, txRate: 5000, rxRate: 5000, htmode: 'HT20' }).score).toBe(100);
  });
});

describe('averageExperience', () => {
  const wifi = (signal: number) =>
    ({ mac: `m${signal}`, wireless: { signal, txRate: 1000, rxRate: 1000, htmode: 'HE80', band: '5 GHz' } }) as unknown as Client;
  it('averages wireless clients only and grades the mean', () => {
    const wired = { mac: 'w' } as unknown as Client;
    const avg = averageExperience([wifi(-50), wifi(-80), wired])!;
    expect(avg.score).toBe(Math.round((clientExperience(wifi(-50))!.score + clientExperience(wifi(-80))!.score) / 2));
    expect(averageExperience([wired])).toBeUndefined();
  });
});
