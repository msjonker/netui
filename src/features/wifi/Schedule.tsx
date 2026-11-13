import { useMemo } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import {
  DAYS,
  deleteScheduleOps,
  describeDays,
  newScheduleDraft,
  normalizeSchedule,
  scheduleDraft,
  scheduleEnableOps,
  scheduleOps,
  validateSchedule,
  type ScheduleEntry,
  type WifiSchedule,
} from '../../model/wifiSchedule';
import { useDraft } from '../../lib/useDraft';
import { Drawer } from '../../components/overlay';
import { IconPlus, IconTrash } from '../../components/icons';
import { Banner, Button, Card, Dot, Empty, Field, FormSection, Toggle, ToggleRow, cx } from '../../components/ui';

// Editing the schedule does not touch the radios; the package's cron job does.
const NEW = '+new';
const PLAN = { returnTo: '/settings/wifi' };

function ScheduleForm({
  entry,
  schedule,
  cfg,
  onClose,
}: {
  entry?: ScheduleEntry;
  schedule: WifiSchedule;
  cfg: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo(() => (entry ? scheduleDraft(entry) : newScheduleDraft()), [entry]);
  const { draft, dirty, reset, update } = useDraft(source);
  if (!draft) return null;
  const error = validateSchedule(draft, schedule.entries, !entry);

  return (
    <Drawer
      title={entry ? entry.section : 'New WiFi Schedule'}
      subtitle={entry ? describeDays(entry.days) : undefined}
      onClose={onClose}
      footer={
        <>
          {entry && (
            <Button
              variant="danger"
              class="mr-auto"
              disabled={apply.busy}
              onClick={() => apply.start(deleteScheduleOps(entry), PLAN)}
            >
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={(entry && !dirty) || !!error || apply.busy}
            onClick={() => apply.start(scheduleOps(draft, entry, cfg), { ...PLAN, onConfirmed: onClose })}
          >
            {entry ? 'Apply Changes' : 'Add Schedule'}
          </Button>
        </>
      }
    >
      <div class="px-5">
        <FormSection title="Schedule">
          {!entry && (
            <Field label="Name" stacked hint="Letters, digits and _.">
              {(id) => <input id={id} class="input" value={draft.name} onInput={(e) => update({ name: e.currentTarget.value.trim() })} />}
            </Field>
          )}
          <ToggleRow label="Enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
          <div class="py-2.5">
            <div class="mb-2 text-muted">Days</div>
            <div class="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const on = draft.days.includes(day);
                return (
                  <label
                    key={day}
                    class={cx(
                      'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5',
                      on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-line-strong',
                    )}
                  >
                    <input
                      type="checkbox"
                      class="sr-only"
                      aria-label={day}
                      checked={on}
                      onChange={(e) =>
                        update((d) => ({
                          ...d,
                          days: e.currentTarget.checked ? [...d.days, day] : d.days.filter((x) => x !== day),
                        }))
                      }
                    />
                    {day.slice(0, 3)}
                  </label>
                );
              })}
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <Field label="WiFi on at" stacked>
              {(id) => <input id={id} type="time" class="input" value={draft.start} onInput={(e) => update({ start: e.currentTarget.value })} />}
            </Field>
            <Field label="WiFi off at" stacked>
              {(id) => <input id={id} type="time" class="input" value={draft.stop} onInput={(e) => update({ stop: e.currentTarget.value })} />}
            </Field>
          </div>
          <p class="pb-2 text-xs text-muted">
            An off time earlier than the on time runs past midnight. The same time for both only turns WiFi off.
          </p>
          <ToggleRow
            label="Turn off even with devices connected"
            hint="Otherwise WiFi stays on until the last device leaves, checking again every few minutes."
            checked={draft.forceDown}
            onChange={(forceDown) => update({ forceDown })}
          />
        </FormSection>
        {error && (dirty || entry) && (
          <p class="py-3 text-xs text-bad" role="alert">
            {error}
          </p>
        )}
      </div>
    </Drawer>
  );
}

/**
 * WiFi Schedule (the wifischedule package). Renders nothing if the package is
 * not installed. `sel` is the open entry's section, or "+new" (not a valid section name) for a new one.
 */
export function ScheduleCard({ sel, setSel }: { sel: string | null; setSel: (s: string | null) => void }) {
  const q = useUci('wifi_schedule');
  const apply = useApply();
  const schedule = useMemo(() => (q.data ? normalizeSchedule(q.data) : undefined), [q.data]);
  if (!q.data || !schedule) return null;
  const entry = schedule.entries.find((e) => e.section === sel);

  return (
    <Card
      title="WiFi Schedule"
      flush
      actions={
        <>
          <Toggle
            label="WiFi schedule enabled"
            checked={schedule.enabled}
            disabled={apply.busy}
            onChange={(on) => apply.start(scheduleEnableOps(on, schedule, q.data!), PLAN)}
          />
          <Button variant="ghost" onClick={() => setSel(NEW)}>
            <IconPlus size={14} /> Add
          </Button>
        </>
      }
    >
      <div class="px-4 pt-3">
        <Banner tone="warn">Schedules switch every radio on and off, not single WiFi networks.</Banner>
      </div>
      {schedule.entries.length === 0 ? (
        <Empty>No schedules yet.</Empty>
      ) : (
        <table class="table mt-2">
          <thead>
            <tr>
              <th>Name</th>
              <th>Days</th>
              <th>WiFi on</th>
              <th>At off time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {schedule.entries.map((e) => (
              <tr key={e.section} data-clickable aria-selected={sel === e.section} onClick={() => setSel(e.section)}>
                <td class="font-medium">{e.section}</td>
                <td>{describeDays(e.days)}</td>
                <td class="tabular-nums">
                  {e.start} &ndash; {e.stop}
                </td>
                <td>{e.forceDown ? 'Force off' : 'Wait for devices'}</td>
                <td>
                  <span class="inline-flex items-center gap-1.5">
                    <Dot tone={e.enabled && schedule.enabled ? 'ok' : 'neutral'} />
                    {e.enabled ? (schedule.enabled ? 'Active' : 'Enabled (schedule off)') : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel === NEW && <ScheduleForm schedule={schedule} cfg={q.data} onClose={() => setSel(null)} />}
      {entry && <ScheduleForm key={entry.section} entry={entry} schedule={schedule} cfg={q.data} onClose={() => setSel(null)} />}
    </Card>
  );
}
