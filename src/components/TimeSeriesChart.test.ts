import { describe, expect, it } from 'vitest';
import { drawable, xRange } from './TimeSeriesChart';

describe('xRange', () => {
  it('shows the last minute before there are two samples', () => {
    expect(xRange(null, null, 1000)).toEqual([940, 1000]);
    expect(xRange(500, 500)).toEqual([440, 500]);
  });

  it('fits the samples once they span time', () => {
    expect(xRange(500, 503)).toEqual([500, 503]);
  });
});

describe('drawable', () => {
  it('draws nothing until there are two samples', () => {
    expect(drawable([[100], [5], [6]])).toEqual([[], [], []]);
    const two: [number[], number[], number[]] = [[100, 103], [5, 6], [1, 2]];
    expect(drawable(two)).toBe(two);
  });
});
