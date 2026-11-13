import { RingBuffer } from './ringbuffer';

export const POLL_INTERVAL_MS = 3_000;
export const HISTORY_MS = 10 * 60_000;

export interface CounterSample {
  /** ms since epoch */
  t: number;
  rxBytes: number;
  txBytes: number;
}

export interface RatePoint {
  /** seconds since epoch, uPlot's native x unit */
  t: number;
  /** bytes per second; null across a counter reset or a polling gap */
  rx: number | null;
  tx: number | null;
}

/**
 * Bytes/s between two counter readings. Null when the counter went backwards
 * (interface restart, wrap) so the chart shows a gap instead of a spike.
 */
export function counterRate(prev: number, next: number, dtMs: number): number | null {
  if (dtMs <= 0 || next < prev) return null;
  return ((next - prev) * 1000) / dtMs;
}

/**
 * Turns successive counter samples for one device into a rolling rate series.
 * Gaps longer than `maxGapMs` (tab hidden, router unreachable) produce a null
 * point rather than averaging over the outage.
 */
export class ThroughputSeries {
  private prev: CounterSample | null = null;
  readonly points: RingBuffer<RatePoint>;
  private readonly maxGapMs: number;

  constructor(historyMs = HISTORY_MS, intervalMs = POLL_INTERVAL_MS) {
    this.points = new RingBuffer(Math.ceil(historyMs / intervalMs));
    this.maxGapMs = intervalMs * 3;
  }

  add(sample: CounterSample): void {
    const prev = this.prev;
    this.prev = sample;
    if (!prev) return;
    const dt = sample.t - prev.t;
    if (dt <= 0) return;
    const gap = dt > this.maxGapMs;
    this.points.push({
      t: sample.t / 1000,
      rx: gap ? null : counterRate(prev.rxBytes, sample.rxBytes, dt),
      tx: gap ? null : counterRate(prev.txBytes, sample.txBytes, dt),
    });
  }

  /** uPlot AlignedData: [x[], rx[], tx[]] */
  toAligned(): [number[], (number | null)[], (number | null)[]] {
    const pts = this.points.toArray();
    return [pts.map((p) => p.t), pts.map((p) => p.rx), pts.map((p) => p.tx)];
  }
}
