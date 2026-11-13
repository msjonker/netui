import type { IwinfoScanEntry, IwinfoSurveyEntry } from '../api/types';
import { isDfs } from './radio';
import type { Band } from './wifi';

// WiFi environment: neighbouring networks from
// `iwinfo scan`, how crowded each channel is, and whether a quieter one
// exists.

export interface Neighbor {
  bssid: string;
  /** undefined for a hidden network */
  ssid?: string;
  band: Band;
  channel: number;
  mhz: number;
  /** Channel width in MHz (20/40/80/160; 8080 is reported as 160). */
  width: number;
  /** Centre frequency of the whole (possibly bonded) channel, MHz. */
  center: number;
  signal: number;
  security: string;
  mesh: boolean;
  /** iwinfo device that saw it */
  radio: string;
}

const GHZ_BAND: Record<number, Band> = { 2: '2g', 5: '5g', 6: '6g' };

/**
 * Width and centre from the HT/VHT operation elements, as iwinfo encodes
 * them: HT channel_width 2040 only means "may use 40", so 40 MHz needs a
 * secondary channel; VHT channel_width 40 means "20 or 40 as per HT", 80
 * means 80 or more, and a second centre 8 channels from the first is the
 * 160 MHz signalling (centre of the 160 is center_freq_2).
 */
export function scanWidth(e: IwinfoScanEntry): { width: number; center: number } {
  const ht = e.ht_operation;
  const vht = e.vht_operation;
  const base = e.band === 2 ? 2407 : e.band === 6 ? 5950 : 5000;
  if (vht && vht.channel_width >= 80) {
    const cf1 = vht.center_freq_1;
    const cf2 = vht.center_freq_2;
    if (cf2 && Math.abs(cf2 - cf1) === 8) return { width: 160, center: base + 5 * cf2 };
    if (vht.channel_width === 160) return { width: 160, center: base + 5 * cf1 };
    return { width: vht.channel_width === 8080 ? 160 : 80, center: base + 5 * cf1 };
  }
  const off = ht?.secondary_channel_offset;
  if (ht && ht.channel_width === 2040 && (off === 'above' || off === 'below')) {
    return { width: 40, center: e.mhz + (off === 'above' ? 10 : -10) };
  }
  return { width: 20, center: e.mhz };
}

export function scanSecurity(enc: IwinfoScanEntry['encryption']): string {
  if (!enc?.enabled) return 'Open';
  const auth = enc.authentication ?? [];
  if (auth.includes('802.1x')) return 'Enterprise';
  const wpa = enc.wpa ?? [];
  if (!wpa.length) return 'WEP';
  if (auth.includes('owe')) return 'OWE';
  return wpa.map((v) => `WPA${v === 1 ? '' : v}`).join('/');
}

export function normalizeScan(results: IwinfoScanEntry[], radio: string): Neighbor[] {
  return results.flatMap((e) => {
    const band = GHZ_BAND[e.band];
    if (!band) return [];
    return [
      {
        bssid: e.bssid.toLowerCase(),
        ssid: e.ssid || undefined,
        band,
        channel: e.channel,
        mhz: e.mhz,
        ...scanWidth(e),
        signal: e.signal,
        security: scanSecurity(e.encryption),
        mesh: e.mode === 'Mesh Point',
        radio,
      },
    ];
  });
}

/** Signal to interference weight: -50 dBm or louder counts fully, -95 hardly at all. */
export function signalWeight(dbm: number): number {
  return Math.min(1, Math.max(0.05, (dbm + 95) / 45));
}

export interface ChannelSlot {
  channel: number;
  mhz: number;
  /** Networks overlapping this 20 MHz channel. */
  count: number;
  /** Same, weighted by signal and by how much of the channel they cover. */
  load: number;
}

/**
 * Per 20 MHz channel, how many neighbours overlap it. A bonded network counts
 * on every channel it spans; on 2.4 GHz a 20 MHz network also partly covers
 * the channels next to it.
 */
export function channelOccupancy(neighbors: Neighbor[], slots: { channel: number; mhz: number }[]): ChannelSlot[] {
  return slots.map(({ channel, mhz }) => {
    let count = 0;
    let load = 0;
    for (const n of neighbors) {
      const overlap = Math.min(mhz + 10, n.center + n.width / 2) - Math.max(mhz - 10, n.center - n.width / 2);
      if (overlap <= 0) continue;
      count++;
      load += signalWeight(n.signal) * (overlap / 20);
    }
    return { channel, mhz, count, load };
  });
}

/** 20 MHz channels to chart, from the survey (allowed channels) or a default plan. */
export function bandSlots(band: Band, survey?: IwinfoSurveyEntry[]): { channel: number; mhz: number }[] {
  const toCh = (mhz: number) => (band === '2g' ? (mhz === 2484 ? 14 : (mhz - 2407) / 5) : (mhz - (band === '6g' ? 5950 : 5000)) / 5);
  const inBand = (mhz: number) => (band === '2g' ? mhz < 2500 : band === '5g' ? mhz > 5000 && mhz < 5925 : mhz >= 5925);
  const freqs = survey?.map((s) => s.mhz).filter(inBand) ?? [];
  const list = freqs.length
    ? freqs
    : band === '2g'
      ? Array.from({ length: 11 }, (_, i) => 2412 + 5 * i)
      : [5180, 5200, 5220, 5240, 5745, 5765, 5785, 5805, 5825];
  return [...new Set(list)].sort((a, b) => a - b).map((mhz) => ({ channel: toCh(mhz), mhz }));
}

export interface Recommendation {
  channel: number;
  /** Needs radar detection: a minute of silence on start, and moves on radar. */
  dfs: boolean;
  /** Why: compared with the current channel. */
  reason: string;
}

/** First channel of the `width` MHz block a 5 GHz channel belongs to (36-48, 52-64, ..., 149-161 for 80). */
export function blockStart(channel: number, width: number): number {
  const span = 4 * Math.max(1, width / 20);
  const base = channel >= 149 ? 149 : 36;
  return base + Math.floor((channel - base) / span) * span;
}

/**
 * A clearly quieter channel than the current one, if any. Candidates are
 * 1/6/11 on 2.4 GHz and blocks of the radio's width on 5 GHz, non-DFS ones
 * first (DFS channels go quiet for a minute on start and move on radar);
 * channels above 165 are new in U-NII-4 and many clients cannot use them. A block scores as
 * its worst 20 MHz channel: neighbour load plus the survey's busy time
 * (minus our own transmit time) where the radio dwelt long enough to measure.
 */
export function recommendChannel(
  band: Band,
  current: number,
  width: number,
  occupancy: ChannelSlot[],
  survey?: IwinfoSurveyEntry[],
): Recommendation | undefined {
  if (band !== '2g' && band !== '5g') return undefined;
  const busy = (mhz: number) => {
    const s = survey?.find((x) => x.mhz === mhz);
    return s && s.active_time >= 100 ? Math.max(0, s.busy_time - (s.tx_time ?? 0)) / s.active_time : 0;
  };
  // A fully busy channel weighs like four strong neighbours.
  const slotScore = (o: ChannelSlot) => o.load + 4 * busy(o.mhz);
  const w = band === '5g' ? width : 20;
  const blocks = new Map<number, ChannelSlot[]>();
  for (const o of occupancy) {
    const k = band === '5g' ? blockStart(o.channel, w) : o.channel;
    blocks.set(k, [...(blocks.get(k) ?? []), o]);
  }
  const score = (k: number) => Math.max(...(blocks.get(k) ?? []).map(slotScore));
  const count = (k: number) => Math.max(...(blocks.get(k) ?? []).map((o) => o.count));
  const cur = band === '5g' ? blockStart(current, w) : current;
  if (!blocks.has(cur)) return undefined;
  const now = score(cur);
  // Only worth a change (and the brief outage) for a real improvement.
  const better = (k: number) => now - score(k) >= 1 && score(k) <= now * 0.6;
  const usable = [...blocks.keys()].filter(
    (k) =>
      k !== cur &&
      (band === '2g'
        ? [1, 6, 11].includes(k)
        : blocks.get(k)!.length === w / 20 && !blocks.get(k)!.some((o) => o.mhz > 5835)),
  );
  const dfs = (k: number) => blocks.get(k)!.some((o) => isDfs(o.mhz));
  const quietest = (ks: number[]) => ks.sort((a, b) => score(a) - score(b)).find(better);
  // Prefer a channel without radar detection; fall back to a DFS one.
  const best = quietest(usable.filter((k) => !dfs(k))) ?? quietest(usable.filter(dfs));
  if (best === undefined) return undefined;
  const n = count(best);
  return {
    channel: best,
    dfs: dfs(best),
    reason: `Channel ${best} has ${n} overlapping network${n === 1 ? '' : 's'}, against ${count(cur)} on channel ${current}.${
      dfs(best) ? ' It needs radar detection (DFS): the network pauses for a minute when it starts there.' : ''
    }`,
  };
}
