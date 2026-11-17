const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];

function scale(value: number, base: number, units: string[], digits: number): string {
  if (!Number.isFinite(value)) return '—';
  let i = 0;
  let v = Math.abs(value);
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  const sign = value < 0 ? '-' : '';
  return `${sign}${i === 0 ? Math.round(v) : v.toFixed(digits)} ${units[i]}`;
}

/** 1536 -> "1.5 KB". Binary multiples, the way OpenWrt and LuCI report memory and counters. */
export function formatBytes(bytes: number, digits = 1): string {
  return scale(bytes, 1024, BYTE_UNITS, digits);
}

/** Bytes per second in, link-style bits per second out (decimal multiples). */
export function formatBitrate(bytesPerSecond: number, digits = 1): string {
  return scale(bytesPerSecond * 8, 1000, BIT_UNITS, digits);
}

/** 93784 -> "1d 2h 3m". Seconds in; drops leading zero units and seconds past the first hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}
