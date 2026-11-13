// WiFi experience: one 0-100 number per wireless client from
// what the AP can see. Signal carries most of the weight; the link rate the
// station negotiated, relative to what the radio's width allows, carries the
// rest. A rate is only meaningful while the station is talking: idle
// stations report the last (often lowest) rate, so it is ignored after a few
// seconds of silence.

import type { Client } from './clients';

export interface ExperienceInput {
  /** dBm */
  signal: number;
  /** AP to client, Mbit/s */
  txRate: number;
  /** Client to AP, Mbit/s */
  rxRate: number;
  /** ms since last heard from */
  inactive?: number;
  /** Radio mode, e.g. "HE80", "VHT40", "HT20". */
  htmode?: string;
  /** "2.4 GHz", "5 GHz", ... used when htmode is unknown. */
  band?: string;
}

export type ExperienceTone = 'ok' | 'warn' | 'bad';

export interface Experience {
  score: number;
  label: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  tone: ExperienceTone;
  reasons: string[];
}

// Single-stream PHY rate at the top MCS with short guard interval, Mbit/s.
const PER_STREAM: Record<string, Record<number, number>> = {
  HT: { 20: 72.2, 40: 150 },
  VHT: { 20: 86.7, 40: 200, 80: 433.3, 160: 866.7 },
  HE: { 20: 143.4, 40: 286.8, 80: 600.5, 160: 1201 },
  EHT: { 20: 172.1, 40: 344.1, 80: 720.6, 160: 1441.2, 320: 2882.4 },
};

/** Phones and laptops are almost all two-stream. */
const STREAMS = 2;

/** Best rate a typical (two-stream) client can reach on this radio mode, Mbit/s. */
export function maxLinkRate(htmode: string | undefined, band?: string): number {
  const m = /^(EHT|HE|VHT|HT)(\d+)/.exec(htmode ?? '');
  const rate = m && PER_STREAM[m[1]!]?.[Number(m[2])];
  if (rate) return rate * STREAMS;
  // Unknown mode: assume WiFi 6 at the band's usual width.
  return (band?.startsWith('2') ? 143.4 : 600.5) * STREAMS;
}

/** dBm to 0..1: full marks to -55, 0.7 at -70 (still fine for most uses), zero at -85. */
function signalQuality(dbm: number): number {
  const q = dbm >= -70 ? 1 - (0.3 * (-55 - dbm)) / 15 : (0.7 * (dbm + 85)) / 15;
  return Math.min(1, Math.max(0, q));
}

function grade(score: number, reasons: string[]): Experience {
  const label = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  return { score, label, tone: score >= 75 ? 'ok' : score >= 50 ? 'warn' : 'bad', reasons };
}

const IDLE_MS = 10_000;
const SILENT_MS = 60_000;

export function wifiExperience(i: ExperienceInput): Experience {
  const reasons: string[] = [];
  const sig = signalQuality(i.signal);
  const max = maxLinkRate(i.htmode, i.band);
  const idle = (i.inactive ?? 0) > IDLE_MS;
  // Downlink matters more to users; weight it a little higher.
  const rate = Math.min(1, (0.6 * i.txRate + 0.4 * i.rxRate) / max);

  let score = idle ? sig : 0.6 * sig + 0.4 * Math.sqrt(rate);
  if (i.signal < -75) reasons.push(`Very weak signal (${i.signal} dBm)`);
  else if (i.signal < -67) reasons.push(`Weak signal (${i.signal} dBm)`);
  if (!idle && rate < 0.15) reasons.push(`Low link rate (${Math.round(Math.max(i.txRate, i.rxRate))} of ${Math.round(max)} Mbps possible)`);
  if ((i.inactive ?? 0) > SILENT_MS) {
    score -= 0.2;
    reasons.push(`Not heard from for ${Math.round(i.inactive! / 1000)} s`);
  } else if (idle) reasons.push('Idle: rated on signal only');

  return grade(Math.round(Math.min(1, Math.max(0, score)) * 100), reasons);
}

/** Experience of a wireless client; undefined for wired ones. */
export function clientExperience(c: Client): Experience | undefined {
  const w = c.wireless;
  return w && wifiExperience({ signal: w.signal, txRate: w.txRate, rxRate: w.rxRate, inactive: w.inactive, htmode: w.htmode, band: w.band });
}

/** The network-wide figure: the mean over wireless clients, or undefined with none. */
export function averageExperience(clients: Client[]): Experience | undefined {
  const scores = clients.map(clientExperience).filter((e): e is Experience => !!e);
  if (!scores.length) return undefined;
  return grade(Math.round(scores.reduce((a, e) => a + e.score, 0) / scores.length), []);
}
