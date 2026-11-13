import { useMemo, useState } from 'preact/hooks';
import { LOG_LINES } from '../../api/queries';
import { useEvents } from '../../model/hooks';
import {
  CATEGORY_LABEL,
  collapseRepeats,
  dayLabel,
  isListed,
  type EventCategory,
  type NetEvent,
} from '../../model/events';
import { EventRow, formatClock } from '../../components/EventRow';
import { IconSearch } from '../../components/icons';
import { Banner, Card, Empty, LoadError, Page, Segmented, Spinner, Toggle, cx } from '../../components/ui';

type SeverityFilter = 'all' | 'warning' | 'error';
const CATEGORIES = Object.keys(CATEGORY_LABEL) as EventCategory[];

function matchesSeverity(e: NetEvent, f: SeverityFilter): boolean {
  if (f === 'error') return e.severity === 'error';
  if (f === 'warning') return e.severity === 'error' || e.severity === 'warning';
  return true;
}

function matchesQuery(e: NetEvent, q: string): boolean {
  if (!q) return true;
  const hay = `${e.text} ${e.line} ${e.mac ?? ''} ${e.ip ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

/** "about 365 days" for the clock note. */
function roughly(ms: number): string {
  const s = Math.abs(ms) / 1000;
  if (s >= 2 * 86400) return `about ${Math.round(s / 86400)} days`;
  if (s >= 2 * 3600) return `about ${Math.round(s / 3600)} hours`;
  return `about ${Math.max(1, Math.round(s / 60))} minutes`;
}

function CategoryChips({
  value,
  onChange,
  counts,
}: {
  value: EventCategory | 'all';
  onChange: (v: EventCategory | 'all') => void;
  counts: Record<string, number>;
}) {
  const chip = (v: EventCategory | 'all', label: string) => (
    <button
      key={v}
      type="button"
      aria-pressed={value === v}
      onClick={() => onChange(v)}
      class={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
        value === v ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-muted hover:text-fg',
      )}
    >
      {label}{' '}
      <span class="text-faint tabular-nums">{counts[v] ?? 0}</span>
    </button>
  );
  return (
    <div role="group" aria-label="Category" class="flex flex-wrap gap-1.5">
      {chip('all', 'All')}
      {CATEGORIES.map((c) => chip(c, CATEGORY_LABEL[c]))}
    </div>
  );
}

function RawLog({ events, skew }: { events: NetEvent[]; skew: number }) {
  if (events.length === 0) return <Empty>No log lines match.</Empty>;
  return (
    <ol aria-label="Raw syslog" class="divide-y divide-line font-mono text-xs">
      {events.map((e) => (
        <li key={e.id} class="flex gap-3 px-4 py-1">
          <time class="shrink-0 text-muted tabular-nums">
            {new Date(e.time + skew).toLocaleDateString(undefined, { month: 'short', day: '2-digit' })} {formatClock(e.time + skew)}
          </time>
          <span
            class={cx(
              'w-28 shrink-0 truncate',
              e.severity === 'error' ? 'text-bad' : e.severity === 'warning' ? 'text-warn' : 'text-faint',
            )}
          >
            {e.level}
          </span>
          <span class="min-w-0 break-all whitespace-pre-wrap">{e.line}</span>
        </li>
      ))}
    </ol>
  );
}

function EventList({ events, skew, now }: { events: NetEvent[]; skew: number; now: number }) {
  const days = useMemo(() => {
    const out: { label: string; events: NetEvent[] }[] = [];
    for (const e of events) {
      const label = dayLabel(e.time + skew, now);
      const last = out[out.length - 1];
      if (last?.label === label) last.events.push(e);
      else out.push({ label, events: [e] });
    }
    return out;
  }, [events, skew, now]);

  if (events.length === 0) return <Empty>No events match.</Empty>;
  return (
    <div>
      {days.map((d) => (
        <section key={d.label} aria-label={d.label}>
          <h3 class="sticky top-0 z-[1] border-b border-line bg-subtle px-4 py-1.5 text-xs font-semibold text-muted">
            {d.label}
          </h3>
          <ul class="divide-y divide-line">
            {collapseRepeats(d.events).map(({ event, count }) => (
              <EventRow key={event.id} event={event} count={count} skew={skew} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function LogsPage() {
  const { events, skew, log } = useEvents();
  const [category, setCategory] = useState<EventCategory | 'all'>('all');
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);
  const now = Date.now();

  const listed = useMemo(() => events.filter(isListed), [events]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const e of listed) {
      if (!matchesSeverity(e, severity) || !matchesQuery(e, query)) continue;
      c.all = (c.all ?? 0) + 1;
      c[e.category] = (c[e.category] ?? 0) + 1;
    }
    return c;
  }, [listed, severity, query]);

  const visible = useMemo(
    () =>
      (raw ? events : listed).filter(
        (e) =>
          (raw || category === 'all' || e.category === category) && matchesSeverity(e, severity) && matchesQuery(e, query),
      ),
    [raw, events, listed, category, severity, query],
  );

  return (
    <Page
      title="System Log"
      subtitle="Events from the router's syslog. Refreshes every 10 seconds."
      actions={
        <label class="inline-flex items-center gap-2 text-muted">
          Show raw syslog
          <Toggle label="Show raw syslog" checked={raw} onChange={setRaw} />
        </label>
      }
    >
      <LoadError error={log.error} />
      {Math.abs(skew) >= 3600_000 && (
        <div class="mb-3">
          <Banner tone="warn">
            The router's clock is off by {roughly(skew)} (no time sync yet). Times here are corrected to this computer's
            clock.
          </Banner>
        </div>
      )}
      <div class="mb-3 flex flex-wrap items-center gap-3">
        {!raw && <CategoryChips value={category} onChange={setCategory} counts={counts} />}
        <div class="ml-auto flex flex-wrap items-center gap-3">
          <Segmented
            label="Severity"
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'all', label: 'All' },
              { value: 'warning', label: 'Warnings' },
              { value: 'error', label: 'Errors' },
            ]}
          />
          <label class="relative w-64">
            <IconSearch size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <input
              type="search"
              aria-label="Search events"
              placeholder="Search events, MAC or IP"
              class="input pl-8"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
        </div>
      </div>
      <Card flush>
        {log.isPending ? (
          <div class="flex justify-center p-10">
            <Spinner />
          </div>
        ) : raw ? (
          <RawLog events={visible} skew={skew} />
        ) : (
          <EventList events={visible} skew={skew} now={now} />
        )}
      </Card>
      <p class="mt-2 text-xs text-faint">
        From the router's in-memory log ({LOG_LINES} most recent lines per read; older lines drop off as it fills, and
        it is cleared on reboot). Logins to netui itself are not logged by the router.
      </p>
    </Page>
  );
}
