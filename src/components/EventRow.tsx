import type { ComponentChildren, JSX } from 'preact';
import { Link } from 'wouter-preact';
import type { EventCategory, EventPart, NetEvent } from '../model/events';
import { CATEGORY_LABEL, relativeTime } from '../model/events';
import { IconClients, IconGlobe, IconNetwork, IconRouter, IconShield, IconWifi } from './icons';
import { cx } from './ui';

// One event in the System Log: category icon, message with client
// names linking to the client, time on the right. Shared by the System Log,
// the dashboard and the notification popover.

const ICON: Record<EventCategory, (p: { size?: number; class?: string }) => JSX.Element> = {
  clients: IconClients,
  internet: IconGlobe,
  wifi: IconWifi,
  dhcp: IconNetwork,
  admin: IconShield,
  system: IconRouter,
};

export function EventIcon({ e, size = 16 }: { e: Pick<NetEvent, 'category' | 'severity'>; size?: number }) {
  const Icon = ICON[e.category];
  const tone =
    e.severity === 'error'
      ? 'bg-bad-soft text-bad'
      : e.severity === 'warning'
        ? 'bg-warn-soft text-warn'
        : e.category === 'internet' || e.category === 'clients'
          ? 'bg-accent-soft text-accent'
          : 'bg-subtle text-muted';
  return (
    <span
      class={cx('flex size-7 shrink-0 items-center justify-center rounded-full', tone)}
      title={CATEGORY_LABEL[e.category]}
    >
      <Icon size={size} />
    </span>
  );
}

export function EventMessage({ parts, onNavigate }: { parts: EventPart[]; onNavigate?: () => void }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <Link key={i} href={`/clients/${p.mac}`} onClick={onNavigate} class="font-medium text-accent hover:underline">
            {p.label}
          </Link>
        ),
      )}
    </>
  );
}

export function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * `skew` is added to the router's timestamps (see model/events clockSkew).
 * `relative` shows "5m ago" instead of the clock time.
 */
export function EventRow({
  event: e,
  count = 1,
  skew,
  now,
  relative,
  unread,
  badge,
  onNavigate,
}: {
  event: NetEvent;
  count?: number;
  skew: number;
  now: number;
  relative?: boolean;
  unread?: boolean;
  /** Shown before the message, e.g. a "New device" pill. */
  badge?: ComponentChildren;
  onNavigate?: () => void;
}) {
  const t = e.time + skew;
  return (
    <li class={cx('flex min-h-11 items-center gap-3 px-4 py-1.5', unread && 'bg-accent-soft/40')} data-event-id={e.id}>
      <EventIcon e={e} />
      <div class="min-w-0 flex-1">
        {badge && <span class="mr-1.5 align-middle">{badge}</span>}
        <span class={cx('break-words', e.raw && 'font-mono text-xs')}>
          <EventMessage parts={e.parts} onNavigate={onNavigate} />
        </span>
        {count > 1 && <span class="ml-1.5 rounded bg-subtle px-1 text-[11px] text-muted tabular-nums">×{count}</span>}
      </div>
      {unread && <span class="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
      <time
        class="shrink-0 text-xs text-muted tabular-nums"
        dateTime={new Date(t).toISOString()}
        title={`${new Date(t).toLocaleString()} (${relativeTime(t, now)})`}
      >
        {relative ? relativeTime(t, now) : formatClock(t)}
      </time>
    </li>
  );
}
