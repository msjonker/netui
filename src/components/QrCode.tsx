import { useMemo } from 'preact/hooks';
import { encode } from 'uqr';

/**
 * QR code as a crisp SVG (one path, scales to any size). Black on white with
 * the standard quiet zone regardless of theme: phone cameras need the contrast.
 */
export function QrCode({ value, size = 192, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const { data, size: n } = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, n };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shape-rendering="crispEdges" class="rounded-md">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
