import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { useLog } from '../api/queries';
import {
  isNewClient,
  latestMarker,
  notableEvents,
  parseEvents,
  trackMacs,
  unreadEvents,
  type KnownMacs,
  type SeenMarker,
} from '../model/events';
import { useEvents } from '../model/hooks';
import { EventRow } from '../components/EventRow';
import { IconBell } from '../components/icons';
import { Empty, Pill, Spinner, cx } from '../components/ui';

// The bell in the top bar: important events (internet down/up, a device never
// seen before, admin logins, router restarts) since the popover was last
// opened. What was seen is kept per browser in localStorage. The badge only
// needs the log; names are resolved when the popover opens.

const SEEN_KEY = 'netui.notifications.seen';
const KNOWN_KEY = 'netui.notifications.knownMacs';
const BELL_POLL_MS = 30_000;
const SHOWN = 20;

function load<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: notifications just stop remembering.
  }
}

function Popover({ seen, known, onClose }: { seen: SeenMarker | null; known: KnownMacs | null; onClose: () => void }) {
  const { events, skew, log } = useEvents(BELL_POLL_MS);
  const notable = useMemo(() => notableEvents(events, known).slice(0, SHOWN), [events, known]);
  const unread = useMemo(() => new Set(unreadEvents(notable, events, seen).map((e) => e.id)), [notable, events, seen]);
  const now = Date.now();

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      class="absolute top-10 right-0 z-40 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
    >
      <header class="flex h-10 items-center justify-between border-b border-line px-4">
        <h2 class="text-[13px] font-semibold">Notifications</h2>
        <Link href="/logs" onClick={onClose} class="text-xs text-accent hover:underline">
          View all events
        </Link>
      </header>
      <div class="max-h-[60vh] overflow-y-auto">
        {log.isPending ? (
          <div class="flex justify-center p-6">
            <Spinner />
          </div>
        ) : notable.length === 0 ? (
          <Empty>Nothing important in the router's log.</Empty>
        ) : (
          <ul class="divide-y divide-line">
            {notable.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                skew={skew}
                now={now}
                relative
                unread={unread.has(e.id)}
                badge={isNewClient(e, known) && <Pill tone="accent">New device</Pill>}
                onNavigate={onClose}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Notifications() {
  const log = useLog(BELL_POLL_MS);
  // Names do not matter for counting; the popover resolves them.
  const events = useMemo(() => parseEvents(log.data ?? []), [log.data]);
  const [seen, setSeen] = useState<SeenMarker | null>(() => load<SeenMarker>(SEEN_KEY));
  const [known, setKnown] = useState<KnownMacs | null>(() => load<KnownMacs>(KNOWN_KEY));
  const [open, setOpen] = useState<{ seen: SeenMarker | null } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!log.data) return;
    // First use: everything already in the log counts as seen.
    if (!seen) {
      const m = latestMarker(events);
      if (m) {
        setSeen(m);
        save(SEEN_KEY, m);
      }
    }
    const next = trackMacs(events, known);
    if (next !== known) {
      setKnown(next);
      save(KNOWN_KEY, next);
    }
  }, [events, log.data, seen, known]);

  const unread = useMemo(() => unreadEvents(notableEvents(events, known), events, seen), [events, known, seen]);

  const toggle = () => {
    if (open) return setOpen(null);
    // Keep the old marker for highlighting what was new, then mark all seen.
    setOpen({ seen });
    const m = latestMarker(events);
    if (m) {
      setSeen(m);
      save(SEEN_KEY, m);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const count = unread.length;
  return (
    <div ref={ref} class="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={count ? `Notifications (${count} new)` : 'Notifications'}
        aria-expanded={!!open}
        class={cx(
          'relative flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg',
          open && 'bg-hover text-fg',
        )}
      >
        <IconBell size={18} />
        {count > 0 && (
          <span
            data-testid="notification-count"
            class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white tabular-nums"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && <Popover seen={open.seen} known={known} onClose={() => setOpen(null)} />}
    </div>
  );
}
