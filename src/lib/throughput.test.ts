import { describe, expect, it } from 'vitest';
import { ThroughputSeries, counterRate } from './throughput';

describe('counterRate', () => {
  it('computes bytes per second', () => {
    expect(counterRate(1_000, 4_000, 3_000)).toBe(1_000);
  });

  it('returns null when the counter resets', () => {
    expect(counterRate(5_000, 100, 3_000)).toBeNull();
  });
});

describe('ThroughputSeries', () => {
  it('holds 10 minutes of 3s samples', () => {
    expect(new ThroughputSeries().points.capacity).toBe(200);
  });

  it('emits a rate per sample after the first', () => {
    const s = new ThroughputSeries();
    s.add({ t: 0, rxBytes: 0, txBytes: 0 });
    s.add({ t: 3_000, rxBytes: 3_000, txBytes: 6_000 });
    expect(s.toAligned()).toEqual([[3], [1_000], [2_000]]);
  });

  it('breaks the line across a polling gap instead of averaging', () => {
    const s = new ThroughputSeries();
    s.add({ t: 0, rxBytes: 0, txBytes: 0 });
    s.add({ t: 60_000, rxBytes: 60_000, txBytes: 0 });
    expect(s.points.last()).toEqual({ t: 60, rx: null, tx: null });
  });

  it('breaks the line across a counter reset', () => {
    const s = new ThroughputSeries();
    s.add({ t: 0, rxBytes: 10_000, txBytes: 10_000 });
    s.add({ t: 3_000, rxBytes: 50, txBytes: 13_000 });
    expect(s.points.last()).toEqual({ t: 3, rx: null, tx: 1_000 });
  });
});
