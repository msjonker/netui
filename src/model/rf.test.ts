import { describe, expect, it } from 'vitest';
import type { IwinfoScan, IwinfoSurvey } from '../api/types';
import scan5Json from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.scan.phy0-ap0.json';
import scan2Json from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.scan.phy1-ap0.json';
import survey5Json from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy0-ap0.json';
import survey2Json from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy1-ap0.json';
import { channelLoad } from './radio';
import { bandSlots, channelOccupancy, normalizeScan, recommendChannel, scanSecurity, scanWidth } from './rf';

const scan5: IwinfoScan = scan5Json;
const scan2: IwinfoScan = scan2Json;
const survey5: IwinfoSurvey = survey5Json;
const survey2: IwinfoSurvey = survey2Json;

describe('normalizeScan (DL-WRX36 recordings)', () => {
  const five = normalizeScan(scan5.results, 'phy0-ap0');
  const two = normalizeScan(scan2.results, 'phy1-ap0');

  it('keeps every network, hidden ones without an SSID', () => {
    expect(five).toHaveLength(71);
    expect(two).toHaveLength(58);
    expect(five.filter((n) => !n.ssid)).toHaveLength(23);
    expect(two.filter((n) => n.band !== '2g')).toEqual([]);
    expect(five[0]).toMatchObject({ bssid: '02:00:00:00:00:00', ssid: 'neighbor-0', band: '5g', channel: 36, signal: -82, mesh: true, radio: 'phy0-ap0' });
  });

  it('reads 160 MHz from the VHT second centre, 80 MHz otherwise', () => {
    // center_freq_1 42 / center_freq_2 50: the 160 MHz channel 36-64.
    expect(five[0]).toMatchObject({ width: 160, center: 5250 });
    const eighty = scan5.results.find((e) => e.vht_operation?.channel_width === 80 && !e.vht_operation.center_freq_2)!;
    expect(scanWidth(eighty).width).toBe(80);
    const htOnly = scan5.results.find((e) => !e.vht_operation)!; // ch 112, HT 2040 below
    expect(scanWidth(htOnly)).toEqual({ width: 40, center: 5550 });
  });

  it('treats "20 or 40" as 20 MHz without a secondary channel', () => {
    // Every 2.4 GHz neighbour here is 20 MHz: "no secondary", or HT width 20.
    expect(new Set(two.map((n) => n.width))).toEqual(new Set([20]));
    expect(two.find((n) => n.channel === 1)).toMatchObject({ width: 20, center: 2412 });
  });

  it('labels security', () => {
    expect(new Set(five.map((n) => n.security))).toEqual(new Set(['WPA3', 'Open', 'WPA2', 'WPA2/WPA3', 'Enterprise']));
    expect(five.filter((n) => n.security === 'Open')).toHaveLength(15);
    expect(scanSecurity({ enabled: true })).toBe('WEP');
  });
});

describe('channel occupancy and recommendation', () => {
  const two = normalizeScan(scan2.results, 'phy1-ap0');
  const five = normalizeScan(scan5.results, 'phy0-ap0');

  it('lists the channels the survey covers', () => {
    expect(bandSlots('2g', survey2.results).map((s) => s.channel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(bandSlots('5g', survey5.results)[0]).toEqual({ channel: 36, mhz: 5180 });
  });

  it('counts overlapping networks per channel', () => {
    const occ = channelOccupancy(two, bandSlots('2g', survey2.results));
    const at = (ch: number) => occ.find((o) => o.channel === ch)!;
    expect(at(1).count).toBeGreaterThan(at(11).count);
    expect(at(1).load).toBeGreaterThan(at(6).load);
  });

  it('suggests a quieter 2.4 GHz channel than the crowded channel 1', () => {
    const occ = channelOccupancy(two, bandSlots('2g', survey2.results));
    const rec = recommendChannel('2g', 1, 20, occ, survey2.results);
    expect(rec).toMatchObject({ channel: 11, dfs: false });
    expect(rec?.reason).toMatch(/^Channel 11 has \d+ overlapping networks, against \d+ on channel 1\.$/);
  });

  it('falls back to a DFS block when no other 5 GHz block is quieter, and says so', () => {
    const occ = channelOccupancy(five, bandSlots('5g', survey5.results));
    // 36-48 and 149-161 are both crowded; 132-144 has no neighbours at all.
    const rec = recommendChannel('5g', 36, 80, occ, survey5.results);
    expect(rec).toMatchObject({ channel: 132, dfs: true });
    expect(rec!.reason).toMatch(/DFS/);
    expect(recommendChannel('5g', 36, 80, channelOccupancy([], bandSlots('5g', survey5.results)), survey5.results)).toBeUndefined();
  });
});

describe('survey utilisation (DL-WRX36 recordings)', () => {
  it('reads the in-use channel with the unsigned noise byte as dBm', () => {
    const l5 = channelLoad(survey5.results, 5180)!;
    expect(l5.busy).toBeCloseTo(2692 / 37988);
    expect(l5.noise).toBe(-110);
    const l2 = channelLoad(survey2.results, 2412)!;
    expect(l2.busy).toBeCloseTo(12997 / 40986);
    expect(l2.noise).toBe(-105);
  });
});
