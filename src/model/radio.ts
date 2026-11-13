import type { IwinfoCountry, IwinfoFreq, IwinfoSurveyEntry, IwinfoTxPower } from '../api/types';
import { widthOptions, type Band } from './wifi';

// Radio settings built from what the driver reports (iwinfo freqlist,
// txpowerlist, countrylist, info.htmodes) rather than from fixed tables.

const BAND_GHZ: Record<Band, number> = { '2g': 2, '5g': 5, '6g': 6, '60g': 60 };

export interface ChannelOption {
  value: string;
  label: string;
  dfs?: boolean;
}

/**
 * 5 GHz channels 52-144 (U-NII-2A/2C) need radar detection in every
 * regulatory domain that allows them. Derived from the frequency because the
 * freqlist flags are not reliable on current builds.
 */
export function isDfs(mhz: number): boolean {
  return mhz >= 5250 && mhz <= 5730;
}

/**
 * Auto plus every channel the regulatory domain allows on this band. Keeps an
 * unlisted current value; it is only flagged once the list has loaded.
 */
export function channelOptions(freqs: IwinfoFreq[] | undefined, band: Band | undefined, current: string): ChannelOption[] {
  const ghz = band && BAND_GHZ[band];
  const opts: ChannelOption[] = [{ value: 'auto', label: 'Auto' }];
  for (const f of freqs ?? []) {
    if (ghz && f.band !== ghz) continue;
    const dfs = isDfs(f.mhz);
    opts.push({ value: String(f.channel), label: `${f.channel} (${f.mhz} MHz)${dfs ? ' · DFS' : ''}`, dfs });
  }
  if (!opts.some((o) => o.value === current)) {
    opts.push({ value: current, label: freqs ? `${current} (not allowed here)` : current });
  }
  return opts;
}

const FAMILY_RANK = ['EHT', 'HE', 'VHT', 'HT'];

/**
 * Channel widths in the radio's current family (HT/VHT/HE/EHT) that the phy
 * supports. With no current htmode, the newest family the phy has.
 */
export function widthChoices(band: Band | undefined, htmodes: string[] | undefined, current?: string) {
  if (!htmodes?.length) return widthOptions(band, current);
  const parse = (m: string) => /^([A-Z]+?)(\d+)\+?$/.exec(m);
  const families = new Set(htmodes.map((m) => parse(m)?.[1]).filter(Boolean));
  const family = (current && parse(current)?.[1]) || FAMILY_RANK.find((f) => families.has(f));
  const widths = htmodes
    .map(parse)
    .filter((p): p is RegExpExecArray => !!p && p[1] === family)
    .map((p) => Number(p[2]))
    .sort((a, b) => a - b);
  if (!widths.length) return widthOptions(band, current);
  return [...new Set(widths)].map((w) => ({ value: `${family}${w}`, label: `${w} MHz` }));
}

// ---------------------------------------------------------------------------
// Transmit power as a few steps: Auto (driver/regulatory maximum), High, Medium,
// Low, or a custom dBm. Levels step 6 dB (a quarter of the power) down from
// the highest the phy offers.

export type TxLevel = 'auto' | 'high' | 'medium' | 'low' | 'custom';

export const TX_LABEL: Record<TxLevel, string> = {
  auto: 'Auto',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  custom: 'Custom',
};

export function txLevels(list: IwinfoTxPower[] | undefined): Record<'high' | 'medium' | 'low', number> | undefined {
  const dbms = (list ?? []).map((p) => p.dbm);
  if (!dbms.length) return undefined;
  const max = Math.max(...dbms);
  const snap = (want: number) => dbms.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), max);
  return { high: max, medium: snap(max - 6), low: snap(max - 12) };
}

/** Which level a stored txpower ("" for auto) corresponds to. */
export function txLevelOf(txpower: string, list: IwinfoTxPower[] | undefined): TxLevel {
  if (!txpower) return 'auto';
  const levels = txLevels(list);
  const n = Number(txpower);
  if (levels?.high === n) return 'high';
  if (levels?.medium === n) return 'medium';
  if (levels?.low === n) return 'low';
  return 'custom';
}

/** txpower value to store for a level; custom keeps the current value or starts at High. */
export function txPowerFor(level: TxLevel, current: string, list: IwinfoTxPower[] | undefined): string {
  const levels = txLevels(list);
  if (level === 'auto') return '';
  if (level === 'custom') return current || String(levels?.high ?? 20);
  return levels ? String(levels[level]) : current;
}

/** Countries for a select, "World" (00) first, then by name. */
export function countryOptions(list: IwinfoCountry[] | undefined, current: string): { value: string; label: string }[] {
  const opts = (list ?? [])
    .map((c) => ({ value: c.code, label: c.code === '00' ? 'World (00)' : `${c.country} (${c.code})` }))
    .sort((a, b) => (a.value === '00' ? -1 : b.value === '00' ? 1 : a.label.localeCompare(b.label)));
  if (current && !opts.some((o) => o.value === current)) opts.unshift({ value: current, label: current });
  return opts;
}

// ---------------------------------------------------------------------------
// Channel utilisation from iwinfo survey.

/** Survey noise is reported as an unsigned byte; 146 means -110 dBm. */
export function signedNoise(n: number): number {
  return n > 127 ? n - 256 : n;
}

export interface ChannelLoad {
  /** Fraction of time the channel was busy (any transmitter, including ours). */
  busy: number;
  /** Part of `busy` that was this radio transmitting. */
  tx?: number;
  /** dBm */
  noise?: number;
}

/**
 * Utilisation of the in-use channel. Counters are cumulative, so with a
 * previous sample the result covers the interval between the two; without
 * one it is the average since the counters started.
 */
export function channelLoad(
  cur: IwinfoSurveyEntry[] | undefined,
  mhz: number | undefined,
  prev?: IwinfoSurveyEntry[],
): ChannelLoad | undefined {
  const c = cur?.find((e) => e.mhz === mhz);
  if (!c) return undefined;
  const p = prev?.find((e) => e.mhz === mhz);
  const useDelta = p && c.active_time > p.active_time && c.busy_time >= p.busy_time;
  const active = useDelta ? c.active_time - p.active_time : c.active_time;
  const busy = useDelta ? c.busy_time - p.busy_time : c.busy_time;
  const tx = c.tx_time !== undefined ? (useDelta ? c.tx_time - (p.tx_time ?? 0) : c.tx_time) : undefined;
  if (active <= 0) return undefined;
  const clamp = (x: number) => Math.min(1, Math.max(0, x / active));
  return { busy: clamp(busy), tx: tx === undefined ? undefined : clamp(tx), noise: c.noise ? signedNoise(c.noise) : undefined };
}
