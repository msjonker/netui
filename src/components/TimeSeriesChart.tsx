import { useEffect, useRef, useState } from 'preact/hooks';
import { isDark, onThemeChange } from '../lib/theme';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface SeriesSpec {
  label: string;
  /** A CSS color or a theme variable name such as "--accent". */
  color: string;
}

/** Canvas cannot read CSS variables; resolve them against the current theme. */
function resolve(color: string): string {
  if (!color.startsWith('--')) return color;
  return getComputedStyle(document.documentElement).getPropertyValue(color).trim() || '#808893';
}

function withAlpha(hex: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex;
}

/**
 * x range in seconds. uPlot widens a zero-width span by orders of magnitude, so
 * with fewer than two samples a single timestamp spans years; show the last
 * minute instead until there is a real span.
 */
export function xRange(min: number | null, max: number | null, now = Date.now() / 1000): uPlot.Range.MinMax {
  if (min == null || max == null) return [now - 60, now];
  if (max - min < 1) return [max - 60, max];
  return [min, max];
}

/**
 * What to draw: nothing until there are two samples. With a single point uPlot
 * does not consult the x range above and spans years; empty data takes the
 * "last minute" path instead (the caller shows a "collecting" note meanwhile).
 */
export function drawable(data: uPlot.AlignedData): uPlot.AlignedData {
  return data[0].length < 2 ? (data.map(() => []) as unknown as uPlot.AlignedData) : data;
}

/** Re-render when the theme changes: the account menu's choice or the system's. */
function useColorScheme(): string {
  const [dark, setDark] = useState(isDark);
  useEffect(() => onThemeChange(() => setDark(isDark())), []);
  return dark ? 'dark' : 'light';
}

/**
 * Live area chart on uPlot. `data` is AlignedData: [x seconds[], ...y[]];
 * null y values render as gaps. Data updates do not rebuild the plot.
 */
export function TimeSeriesChart({
  data,
  series,
  height = 180,
  formatValue = String,
}: {
  data: uPlot.AlignedData;
  series: SeriesSpec[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const fmt = useRef(formatValue);
  fmt.current = formatValue;
  const scheme = useColorScheme();
  const seriesKey = series.map((s) => `${s.label}:${s.color}`).join('|');

  useEffect(() => {
    const host = el.current!;
    const line = resolve('--line');
    const muted = resolve('--muted');
    const grid = { stroke: line, width: 1 };
    const opts: uPlot.Options = {
      width: host.clientWidth || 300,
      height,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      scales: {
        x: { time: true, range: (_u, min, max) => xRange(min, max) },
        y: { range: (_u, _min, max) => [0, Math.max(max ?? 0, 1) * 1.1] },
      },
      axes: [
        { stroke: muted, grid: { show: false }, ticks: { show: false }, font: '11px sans-serif', gap: 6 },
        {
          stroke: muted,
          grid,
          ticks: { show: false },
          size: 64,
          font: '11px sans-serif',
          values: (_u, ticks) => ticks.map((v) => fmt.current(v)),
        },
      ],
      series: [
        {},
        ...series.map((s) => {
          const c = resolve(s.color);
          return {
            label: s.label,
            stroke: c,
            fill: withAlpha(c, '1f'),
            width: 1.75,
            points: { show: false },
          };
        }),
      ],
    };
    plot.current = new uPlot(opts, drawable(data), host);

    const ro = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) plot.current?.setSize({ width: entry.contentRect.width, height });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // Rebuild only when the shape or theme changes; data flows through setData below.
  }, [height, seriesKey, scheme]);

  useEffect(() => {
    plot.current?.setData(drawable(data));
  }, [data]);

  return <div ref={el} class="w-full" />;
}
