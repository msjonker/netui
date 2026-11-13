import { describe, expect, it } from 'vitest';
import type { IwinfoCountryList, IwinfoFreqList, IwinfoInfo, IwinfoSurvey, IwinfoTxPowerList } from '../api/types';
import freq5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.freqlist.phy0-ap0.json';
import freq2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.freqlist.phy1-ap0.json';
import txp from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.txpowerlist.phy0-ap0.json';
import countries from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.countrylist.phy0-ap0.json';
import info5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy0-ap0.json';
import info2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy1-ap0.json';
import survey5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy0-ap0.json';
import survey2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy1-ap0.json';
import {
  channelLoad,
  channelOptions,
  countryOptions,
  isDfs,
  signedNoise,
  txLevelOf,
  txLevels,
  txPowerFor,
  widthChoices,
} from './radio';

const f5: IwinfoFreqList = freq5;
const f2: IwinfoFreqList = freq2;
const tx: IwinfoTxPowerList = txp;
const cl: IwinfoCountryList = countries;
const i5: IwinfoInfo = info5;
const i2: IwinfoInfo = info2;
const s5: IwinfoSurvey = survey5;
const s2: IwinfoSurvey = survey2;

describe('channels', () => {
  it('lists the regulatory channels of the band, marking DFS', () => {
    const opts = channelOptions(f5.results, '5g', '36');
    expect(opts[0]).toEqual({ value: 'auto', label: 'Auto' });
    expect(opts.slice(1).map((o) => o.value)).toEqual(f5.results.map((f) => String(f.channel)));
    expect(opts.find((o) => o.value === '36')).toEqual({ value: '36', label: '36 (5180 MHz)', dfs: false });
    expect(opts.find((o) => o.value === '100')).toEqual({ value: '100', label: '100 (5500 MHz) · DFS', dfs: true });
    expect(opts.filter((o) => o.dfs).map((o) => o.value)).toEqual(
      ['52', '56', '60', '64', '100', '104', '108', '112', '116', '120', '124', '128', '132', '136', '140', '144'],
    );
    // US 2.4 GHz stops at 11.
    expect(channelOptions(f2.results, '2g', '1').map((o) => o.value)).toEqual(['auto', ...Array.from({ length: 11 }, (_, i) => String(i + 1))]);
  });

  it('keeps a configured channel the list does not allow, and filters other bands', () => {
    expect(channelOptions(f2.results, '2g', '13').at(-1)).toEqual({ value: '13', label: '13 (not allowed here)' });
    expect(channelOptions(f5.results, '2g', 'auto')).toEqual([{ value: 'auto', label: 'Auto' }]);
    // Still loading: keep the current channel without calling it illegal.
    expect(channelOptions(undefined, '5g', '36').at(-1)).toEqual({ value: '36', label: '36' });
    expect([5170, 5250, 5730, 5745].map(isDfs)).toEqual([false, true, true, false]);
  });

  it('offers the widths the phy supports in the current family', () => {
    expect(widthChoices('5g', i5.htmodes, 'HE80').map((w) => w.value)).toEqual(['HE20', 'HE40', 'HE80', 'HE160']);
    expect(widthChoices('5g', i5.htmodes, 'VHT40').map((w) => w.value)).toEqual(['VHT20', 'VHT40', 'VHT80', 'VHT160']);
    expect(widthChoices('2g', i2.htmodes, 'HE20')).toEqual([
      { value: 'HE20', label: '20 MHz' },
      { value: 'HE40', label: '40 MHz' },
    ]);
    expect(widthChoices('2g', i2.htmodes, undefined).map((w) => w.value)).toEqual(['HE20', 'HE40']);
    expect(widthChoices('2g', undefined, 'HT20').map((w) => w.value)).toEqual(['HT20', 'HT40']);
  });
});

describe('transmit power', () => {
  it('derives High/Medium/Low from the phy maximum', () => {
    expect(txLevels(tx.results)).toEqual({ high: 30, medium: 24, low: 18 });
    expect(txLevels([])).toBeUndefined();
    expect(['', '30', '24', '18', '21'].map((t) => txLevelOf(t, tx.results))).toEqual(['auto', 'high', 'medium', 'low', 'custom']);
  });

  it('maps a level back to the stored value', () => {
    expect(txPowerFor('auto', '24', tx.results)).toBe('');
    expect(txPowerFor('low', '', tx.results)).toBe('18');
    expect(txPowerFor('custom', '', tx.results)).toBe('30');
    expect(txPowerFor('custom', '21', tx.results)).toBe('21');
  });
});

describe('country', () => {
  it('lists World first, then countries by name', () => {
    const opts = countryOptions(cl.results, 'US');
    expect(opts[0]).toEqual({ value: '00', label: 'World (00)' });
    expect(opts.find((o) => o.value === 'US')!.label).toBe('United States (US)');
    expect(opts).toHaveLength(cl.results.length);
    expect(countryOptions([], 'XX')).toEqual([{ value: 'XX', label: 'XX' }]);
  });
});

describe('channel utilisation', () => {
  it('reads unsigned survey noise as dBm', () => {
    expect([146, 151, 159, -95, 0].map(signedNoise)).toEqual([-110, -105, -97, -95, 0]);
  });

  it('averages since the counters started without a previous sample', () => {
    const load = channelLoad(s5.results, 5180)!;
    expect(load.busy).toBeCloseTo(2692 / 37988, 5);
    expect(load.tx).toBeCloseTo(195 / 37988, 5);
    expect(load.noise).toBe(-110);
    expect(channelLoad(s2.results, 2412)!.busy).toBeCloseTo(12997 / 40986, 5);
    expect(channelLoad(s5.results, 5955)).toBeUndefined();
  });

  it('uses the interval between two polls', () => {
    const next = s5.results.map((e) => (e.mhz === 5180 ? { ...e, active_time: e.active_time + 10_000, busy_time: e.busy_time + 2_500 } : e));
    expect(channelLoad(next, 5180, s5.results)!.busy).toBeCloseTo(0.25, 5);
    // A counter reset (driver reload) falls back to the cumulative ratio.
    expect(channelLoad(s5.results, 5180, next)!.busy).toBeCloseTo(2692 / 37988, 5);
  });
});
