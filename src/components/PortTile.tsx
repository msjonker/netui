import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { IconEthernet } from './icons';
import { cx } from './ui';

/** A front-panel port in the port strip; links to port settings. */
export function PortTile({
  p,
  title,
  children,
}: {
  p: { name: string; role: string; carrier: boolean; speed?: number; wanLabel?: string };
  title?: string;
  /** Extra line under the speed, e.g. the live rate. */
  children?: ComponentChildren;
}) {
  const label = p.role === 'wan' ? (p.wanLabel ?? 'WAN') : p.name;
  return (
    <Link
      href="/settings/ports"
      aria-label={`Port ${label}: ${p.carrier ? 'link up' : 'no link'}`}
      title={title ?? `${p.name}: ${p.carrier ? `${p.speed ?? '?'} Mbps` : 'no link'}`}
      class={cx(
        'flex min-h-11 w-14 flex-col items-center justify-center rounded border py-1 text-[10px] leading-tight hover:border-accent',
        p.carrier
          ? p.role === 'wan'
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-ok bg-ok-soft text-ok'
          : 'border-line bg-subtle text-faint',
      )}
    >
      <IconEthernet size={14} />
      <span class="font-medium">{label}</span>
      <span>{p.carrier && p.speed ? (p.speed >= 1000 ? `${p.speed / 1000}G` : `${p.speed}M`) : '—'}</span>
      {children}
    </Link>
  );
}
