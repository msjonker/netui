import { describe, expect, it } from 'vitest';
import { formatBitrate, formatBytes, formatDuration, formatPercent } from './format';

describe('format', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512.0 MB');
    expect(formatBytes(NaN)).toBe('—');
  });

  it('formats byte rates as decimal bitrates', () => {
    expect(formatBitrate(125)).toBe('1.0 Kbps');
    expect(formatBitrate(125_000_000)).toBe('1.0 Gbps');
    expect(formatBitrate(10)).toBe('80 bps');
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3_700)).toBe('1h 1m');
    expect(formatDuration(93_784)).toBe('1d 2h 3m');
    expect(formatDuration(-1)).toBe('—');
  });

  it('formats percentages', () => {
    expect(formatPercent(0.4567, 1)).toBe('45.7%');
  });
});
