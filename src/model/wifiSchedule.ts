import type { UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';

// The `wifischedule` package (/etc/config/wifi_schedule). Each enabled entry
// is a window in which WiFi is on: at `starttime` /usr/bin/wifi_schedule.sh
// turns every radio on, at `stoptime` it turns them all off, waiting for
// associated clients to leave unless `forcewifidown` is set. Equal start and
// stop times only schedule the stop. The script runs from cron, and its cron
// lines are only rebuilt by `wifi_schedule.sh cron` (LuCI runs that on Save &
// Apply); `uci apply` alone does not, as the package has no ucitrack/reload
// hook.

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Day = (typeof DAYS)[number];

export interface ScheduleEntry {
  /** Section name; LuCI shows it as the entry's name. */
  section: string;
  enabled: boolean;
  days: Day[];
  /** HH:MM */
  start: string;
  stop: string;
  forceDown: boolean;
}

export interface WifiSchedule {
  /** The global section, if the config has one. */
  global?: string;
  enabled: boolean;
  entries: ScheduleEntry[];
}

export function normalizeSchedule(cfg: UciConfig): WifiSchedule {
  const g = sectionsOfType(cfg, 'global')[0];
  return {
    global: g?.['.name'],
    enabled: bool(g?.enabled, false),
    entries: sectionsOfType(cfg, 'entry').map((s) => {
      const days = list(s.daysofweek);
      return {
        section: s['.name'],
        enabled: bool(s.enabled, false),
        days: DAYS.filter((d) => days.includes(d)),
        start: str(s.starttime) ?? '',
        stop: str(s.stoptime) ?? '',
        forceDown: bool(s.forcewifidown, false),
      };
    }),
  };
}

const WEEKDAYS: Day[] = DAYS.slice(0, 5);

/** "Every day", "Weekdays", "Weekends" or "Mon, Wed, Fri". */
export function describeDays(days: Day[]): string {
  const has = (ds: readonly Day[]) => ds.length === days.length && ds.every((d) => days.includes(d));
  if (has(DAYS)) return 'Every day';
  if (has(WEEKDAYS)) return 'Weekdays';
  if (has(['Saturday', 'Sunday'])) return 'Weekends';
  if (!days.length) return 'No days';
  return days.map((d) => d.slice(0, 3)).join(', ');
}

export type ScheduleDraft = Omit<ScheduleEntry, 'section'> & { name: string };

export function scheduleDraft(e: ScheduleEntry): ScheduleDraft {
  const { section, ...rest } = e;
  return { name: section, ...rest };
}

export function newScheduleDraft(): ScheduleDraft {
  return { name: '', enabled: true, days: [...WEEKDAYS], start: '07:00', stop: '23:00', forceDown: false };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateSchedule(d: ScheduleDraft, others: ScheduleEntry[], isNew: boolean): string | null {
  if (isNew) {
    if (!/^[A-Za-z0-9_]+$/.test(d.name)) return 'Name may only use letters, digits and _.';
    if (others.some((e) => e.section === d.name)) return `A schedule named "${d.name}" already exists.`;
  }
  if (!d.days.length) return 'Pick at least one day.';
  if (!TIME.test(d.start) || !TIME.test(d.stop)) return 'Times are HH:MM, e.g. 07:00.';
  return null;
}

function entryValues(d: ScheduleDraft) {
  return {
    enabled: d.enabled ? '1' : '0',
    daysofweek: DAYS.filter((x) => d.days.includes(x)).join(' '),
    starttime: d.start,
    stoptime: d.stop,
    forcewifidown: d.forceDown ? '1' : '0',
  };
}

export function scheduleOps(d: ScheduleDraft, existing: ScheduleEntry | undefined, cfg: UciConfig): UciOp[] {
  if (!existing) return [{ op: 'add', config: 'wifi_schedule', type: 'entry', name: d.name, values: entryValues(d) }];
  return diffSection('wifi_schedule', existing.section, cfg[existing.section], entryValues(d));
}

export function deleteScheduleOps(e: ScheduleEntry): UciOp[] {
  return [{ op: 'delete', config: 'wifi_schedule', section: e.section }];
}

/** Turn the whole schedule on or off, creating the global section with the package defaults if missing. */
export function scheduleEnableOps(enabled: boolean, s: WifiSchedule, cfg: UciConfig): UciOp[] {
  const value = enabled ? '1' : '0';
  if (s.global) return diffSection('wifi_schedule', s.global, cfg[s.global], { enabled: value });
  return [
    {
      op: 'add',
      config: 'wifi_schedule',
      type: 'global',
      values: { enabled: value, logging: '0', recheck_interval: '10', modules_retries: '10' },
    },
  ];
}
