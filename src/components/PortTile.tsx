import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { cx } from './ui';

/** The dark front panel the port sockets sit in. */
export function PortPanel({ children }: { children: ComponentChildren }) {
  return (
    <div class="inline-flex flex-wrap gap-1 rounded-xl bg-[#1f2228] p-2 ring-1 ring-white/5" aria-label="Ports">
      {children}
    </div>
  );
}

/** A front-panel port socket; links to port settings. */
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
  const slow = p.carrier && p.speed != null && p.speed < 1000;
  return (
    <Link
      href="/settings/ports"
      aria-label={`Port ${label}: ${p.carrier ? 'link up' : 'no link'}`}
      title={title ?? `${p.name}: ${p.carrier ? `${p.speed ?? '?'} Mbps` : 'no link'}`}
      class="flex w-14 flex-col items-center gap-1 rounded-lg py-1.5 text-[10px] leading-tight text-white/50 tabular-nums hover:bg-white/5"
    >
      <span class={cx('relative h-8 w-10 rounded-[5px] border border-white/15 pt-3', p.carrier ? 'bg-[#30343c]' : 'opacity-60')}>
        <span class="mx-auto block h-3.5 w-6 rounded-[2px] bg-black/60" />
        <span
          class={cx(
            'absolute top-1 left-1 size-1.5 rounded-full bg-current',
            !p.carrier ? 'text-white/15' : slow ? 'text-warn' : p.role === 'wan' ? 'text-accent' : 'text-ok',
            p.carrier && 'shadow-[0_0_6px_currentColor]',
          )}
        />
      </span>
      <span class={cx('font-semibold', p.carrier ? 'text-white/90' : 'text-white/50')}>{label}</span>
      <span>{p.carrier && p.speed ? (p.speed >= 1000 ? `${p.speed / 1000}G` : `${p.speed}M`) : '—'}</span>
      {children}
    </Link>
  );
}
