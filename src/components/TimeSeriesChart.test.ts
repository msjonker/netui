import { describe, expect, it } from 'vitest';
import { xRange } from './TimeSeriesChart';

describe('xRange', () => {
  it('shows the last minute before there are two samples', () => {
    expect(xRange(null, null, 1000)).toEqual([940, 1000]);
    expect(xRange(500, 500)).toEqual([440, 500]);
  });

  it('fits the samples once they span time', () => {
    expect(xRange(500, 503)).toEqual([500, 503]);
  });
});
