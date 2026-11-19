import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { useApply } from '../../api/useApply';
import { bool, sectionsOfType } from '../../api/uci';
import type { UciConfig } from '../../api/types';
import { displayName, isOffline, type Client } from '../../model/clients';
import { useClients } from '../../model/hooks';
import { useUci } from '../../api/queries';
import {
  DAYS,
  daysLabel,
  deletePersonOps,
  ianaZone,
  inBedtime,
  nextClockTime,
  wallClock,
  newPerson,
  normalizePeople,
  pauseOps,
  pauseState,
  personDraft,
  personOps,
  validatePerson,
  type Person,
  type PersonDraft,
} from '../../model/people';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconPeople, IconPlus, IconSearch, IconTrash } from '../../components/icons';
import { Banner, Button, Card, Dot, Empty, Field, FormSection, LoadError, Page, Pill, Spinner, ToggleRow, cx } from '../../components/ui';

const RETURN = '/people';
const PLAN = { returnTo: RETURN, disruptive: true };

/** Re-render every 30 s so pauses and bedtimes start and end on screen. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** A pause's end on the router's clock: "21:30", "tomorrow 07:00", "Sat 09:00". */
function untilLabel(epochS: number, now: Date, zone?: string): string {
  const end = wallClock(new Date(epochS * 1000), zone);
  const today = wallClock(now, zone);
  const time = `${String(Math.floor(end.minutes / 60)).padStart(2, '0')}:${String(end.minutes % 60).padStart(2, '0')}`;
  const days = epochS - now.getTime() / 1000 < 7 * 86400 ? (end.day - today.day + 7) % 7 : 7;
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${DAYS[end.day]} ${time}`;
}

function offloading(fw: UciConfig): boolean {
  return sectionsOfType(fw, 'defaults').some((s) => bool(s.flow_offloading, false));
}

// ---------------------------------------------------------------------------

function Status({ p, now, zone }: { p: Person; now: Date; zone?: string }) {
  const pause = pauseState(p, now.getTime() / 1000);
  if (pause.paused) return <Pill tone="bad">{pause.until ? `Paused until ${untilLabel(pause.until, now, zone)}` : 'Paused'}</Pill>;
  if (inBedtime(p, wallClock(now, zone))) return <Pill tone="accent">Bedtime until {p.bedtime.stop}</Pill>;
  return <Pill tone="ok">Internet on</Pill>;
}

function PauseMenu({ p, fw, now, zone }: { p: Person; fw: UciConfig; now: Date; zone?: string }) {
  const apply = useApply();
  const ref = useRef<HTMLDetailsElement>(null);
  const morning = p.bedtimeOn && p.bedtime.stop ? p.bedtime.stop : '07:00';
  const choices: [string, number | null][] = [
    ['30 minutes', now.getTime() / 1000 + 30 * 60],
    ['1 hour', now.getTime() / 1000 + 3600],
    ['2 hours', now.getTime() / 1000 + 2 * 3600],
    [`Until ${morning}`, nextClockTime(morning, now, zone)],
    ['Until I resume', null],
  ];
  return (
    <details ref={ref} class="relative">
      <summary
        aria-disabled={apply.busy}
        class={cx(
          'inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-transparent bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover [&::-webkit-details-marker]:hidden',
          apply.busy && 'pointer-events-none opacity-50',
        )}
      >
        Pause Internet
      </summary>
      <div role="menu" class="absolute right-0 z-40 mt-1 w-48 rounded-lg border border-line bg-surface p-1 shadow-pop">
        {choices.map(([label, until]) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            class="flex h-8 w-full items-center rounded-md px-3 text-left hover:bg-hover"
            onClick={() => {
              ref.current?.removeAttribute('open');
              void apply.start(pauseOps(fw, p, until), PLAN);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </details>
  );
}

function PersonCard({
  p,
  clients,
  fw,
  now,
  zone,
  onEdit,
}: {
  p: Person;
  clients: Client[];
  fw: UciConfig;
  now: Date;
  zone?: string;
  onEdit: () => void;
}) {
  const apply = useApply();
  const devices = p.macs.map((mac) => clients.find((c) => c.mac === mac) ?? ({ mac, randomMac: false } as Client));
  const online = devices.filter((c) => !isOffline(c)).length;
  const paused = pauseState(p, now.getTime() / 1000).paused;
  return (
    <Card
      title={
        <span class="flex items-center gap-3">
          <span class="grid size-9 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent uppercase">
            {p.name.slice(0, 1)}
          </span>
          <span class="flex flex-col">
            <span>{p.name}</span>
            <span class="text-xs font-normal text-muted">
              {devices.length ? `${online} of ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} online` : 'No devices yet'}
            </span>
          </span>
        </span>
      }
      actions={<Status p={p} now={now} zone={zone} />}
    >
      {devices.length > 0 ? (
        <ul class="mb-3 divide-y divide-line rounded-lg border border-line">
          {devices.map((c) => (
            <li key={c.mac} class="flex h-9 items-center gap-2.5 px-3">
              <Dot tone={isOffline(c) ? 'neutral' : 'ok'} />
              <Link href={`/clients/${c.mac}`} class="min-w-0 flex-1 truncate hover:underline">
                {displayName(c)}
              </Link>
              <span class="text-xs text-muted">{c.ip ?? (isOffline(c) ? 'Offline' : '')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="mb-3 text-muted">Add this person's phone, computer and other devices to pause them together.</p>
      )}
      <p class="mb-3 text-xs text-muted">
        {p.bedtimeOn && p.bedtime.days.length
          ? `Bedtime: ${daysLabel(p.bedtime.days)}, ${p.bedtime.start} to ${p.bedtime.stop}.`
          : 'No bedtime.'}
      </p>
      <div class="flex flex-wrap justify-end gap-2">
        <Button onClick={onEdit} disabled={apply.busy}>
          Edit
        </Button>
        {paused ? (
          <Button variant="primary" disabled={apply.busy} onClick={() => void apply.start(pauseOps(fw, p, false), PLAN)}>
            Resume Internet
          </Button>
        ) : (
          devices.length > 0 && <PauseMenu p={p} fw={fw} now={now} zone={zone} />
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function PersonForm({
  person,
  people,
  clients,
  fw,
  onClose,
}: {
  person?: Person;
  people: Person[];
  clients: Client[];
  fw: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo(() => (person ? personDraft(person) : newPerson()), [person]);
  const { draft: d, dirty, stale, reset, update } = useDraft<PersonDraft>(source);
  const [touched, setTouched] = useState(false);
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!d) return null;

  const error = validatePerson(d, people, person?.section);
  const owner = (mac: string) => people.find((p) => p.section !== person?.section && p.macs.includes(mac));
  // Chosen devices first, then online ones, then the rest; plus chosen devices the router no longer lists.
  const listed = [
    ...clients,
    ...d.macs.filter((m) => !clients.some((c) => c.mac === m)).map((mac) => ({ mac, randomMac: false }) as Client),
  ];
  const q = query.trim().toLowerCase();
  const shown = listed
    .filter((c) => !q || displayName(c).toLowerCase().includes(q) || c.mac.includes(q) || (c.ip ?? '').includes(q))
    .sort(
      (a, b) =>
        // Devices that were already chosen first; not re-sorted while ticking boxes.
        Number(source.macs.includes(b.mac)) - Number(source.macs.includes(a.mac)) ||
        Number(isOffline(a)) - Number(isOffline(b)) ||
        displayName(a).localeCompare(displayName(b)),
    );
  const submit = () => {
    setTouched(true);
    if (error) return;
    void apply.start(personOps(fw, d, person), { ...PLAN, onConfirmed: onClose });
  };
  const b = d.bedtime;

  return (
    <Drawer
      title={person ? person.name : 'Add Person'}
      icon={<IconPeople size={20} />}
      onClose={onClose}
      footer={
        <>
          {person && (
            <Button variant="danger" class="mr-auto" onClick={() => setConfirmDelete(true)} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || (!!person && !dirty)}>
            {person ? 'Save' : 'Add Person'}
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-3">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This person changed on the router.
            </Banner>
          </div>
        )}
        <FormSection title="Person">
          <Field label="Name" stacked>
            {(id) => (
              <input id={id} class="input w-full" value={d.name} maxLength={32} onInput={(e) => update({ name: e.currentTarget.value })} />
            )}
          </Field>
        </FormSection>
        <FormSection title={`Devices (${d.macs.length})`}>
          <div class="relative my-2">
            <IconSearch size={16} class="pointer-events-none absolute top-2 left-2.5 text-muted" />
            <input
              class="input w-full pl-8"
              placeholder="Find a device"
              aria-label="Find a device"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div class="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {shown.length === 0 && <p class="px-3 py-4 text-center text-muted">No device matches.</p>}
            {shown.map((c) => {
              const other = owner(c.mac);
              return (
                <label key={c.mac} class="flex h-10 cursor-pointer items-center gap-2.5 px-3 hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={d.macs.includes(c.mac)}
                    onChange={(e) => update({ macs: e.currentTarget.checked ? [...d.macs, c.mac] : d.macs.filter((m) => m !== c.mac) })}
                  />
                  <Dot tone={isOffline(c) ? 'neutral' : 'ok'} />
                  <span class="min-w-0 flex-1 truncate">{displayName(c)}</span>
                  {other && <span class="text-xs text-muted">{other.name}'s</span>}
                  <span class="hidden font-mono text-[11px] text-muted sm:inline">{c.mac}</span>
                </label>
              );
            })}
          </div>
          <p class="pt-1.5 text-xs text-muted">
            Matched by MAC address. A phone that uses a private (random) address for this WiFi keeps it as long as it does not
            forget the network.
          </p>
        </FormSection>
        <FormSection title="Bedtime">
          <ToggleRow
            label="Internet off at night"
            hint="The internet goes off at the start time and comes back in the morning. Devices stay on WiFi."
            checked={d.bedtimeOn}
            onChange={(bedtimeOn) => update({ bedtimeOn })}
          />
          {d.bedtimeOn && (
            <>
              <p class="pt-2 pb-1.5 text-muted">Nights</p>
              <div class="flex flex-wrap gap-1.5">
                {DAYS.map((x) => (
                  <button
                    key={x}
                    type="button"
                    aria-pressed={b.days.includes(x)}
                    onClick={() => update({ bedtime: { ...b, days: DAYS.filter((y) => (y === x) !== b.days.includes(y)) } })}
                    class={cx('h-7 w-11 rounded-md border text-xs', b.days.includes(x) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted')}
                  >
                    {x}
                  </button>
                ))}
              </div>
              <div class="grid grid-cols-2 gap-3">
                <Field label="Off at" stacked>
                  {(id) => <input id={id} type="time" class="input" value={b.start} onInput={(e) => update({ bedtime: { ...b, start: e.currentTarget.value } })} />}
                </Field>
                <Field label="Back on at" stacked>
                  {(id) => <input id={id} type="time" class="input" value={b.stop} onInput={(e) => update({ bedtime: { ...b, stop: e.currentTarget.value } })} />}
                </Field>
              </div>
              <p class="pb-2 text-xs text-muted">
                Router time. "Sun" is the night from Sunday into Monday.
                {offloading(fw) && ' With flow offloading on, a connection already open at the start time can last until it closes.'}
              </p>
            </>
          )}
        </FormSection>
        {(touched || dirty) && error && (
          <p class="py-2 text-xs text-bad" role="alert">
            {error}
          </p>
        )}
      </div>
      {confirmDelete && person && (
        <Modal
          title={`Remove ${person.name}?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void apply.start(deletePersonOps(person), { ...PLAN, onConfirmed: onClose });
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">Their devices stay as they are; any pause or bedtime ends.</p>
        </Modal>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

export function PeoplePage() {
  const { clients, firewall, error, isPending } = useClients();
  const apply = useApply();
  const now = useNow();
  // Bedtime and pause times are on the router's clock.
  const system = useUci('system');
  const zone = ianaZone(system.data && sectionsOfType(system.data, 'system')[0]?.zonename?.toString());
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const people = useMemo(() => (firewall.data ? normalizePeople(firewall.data) : undefined), [firewall.data]);
  const fw = firewall.data;
  // Follow the router: a person removed elsewhere closes the form.
  const current = editing && editing !== 'new' ? people?.find((p) => p.section === editing.section) : undefined;

  return (
    <Page
      title="People"
      subtitle="Pause the internet for someone's devices, or give them a bedtime"
      actions={
        <Button variant="primary" onClick={() => setEditing('new')} disabled={apply.busy || !fw}>
          <IconPlus size={14} /> Add Person
        </Button>
      }
    >
      <LoadError error={error} />
      {!people || !fw ? (
        isPending && <Spinner class="m-6" />
      ) : people.length === 0 ? (
        <Card>
          <Empty>
            <p class="font-medium text-fg">No one here yet.</p>
            <p class="mx-auto mt-1 max-w-md">
              Add the people in your household and choose their devices. Then pause the internet for all of someone's devices
              with one button, or turn it off at bedtime on school nights.
            </p>
          </Empty>
        </Card>
      ) : (
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {people.map((p) => (
            <PersonCard key={p.section} p={p} clients={clients} fw={fw} now={now} zone={zone} onEdit={() => setEditing(p)} />
          ))}
        </div>
      )}
      {fw && people && (editing === 'new' || current) && (
        <PersonForm
          key={current?.section ?? 'new'}
          person={current}
          people={people}
          clients={clients}
          fw={fw}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}
