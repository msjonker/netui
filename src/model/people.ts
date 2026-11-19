// People: a name for a group of devices (a child's phone, laptop and
// console), so their internet can be paused or given a bedtime together.
//
// Each person is a `netui_person` section in the firewall config, which fw4
// ignores:
//   option name 'Sam'
//   list mac 'AA:BB:CC:DD:EE:FF'
//   option paused '1'             paused now ...
//   option paused_until '<epoch>' ... until then (seconds), else until resumed
//   option bedtime '1'
//   list bed_day 'Sun'            nights, "Sun" = Sunday into Monday
//   option bed_start '21:00'      router local time
//   option bed_stop '07:00'
// The netui package's limits.sh (the same script include as speed limits)
// turns them into the inet table "netui": a forward chain ahead of fw4's that
// rejects what those devices send through the router while paused or during
// bedtime, including connections already open. A pause that runs out simply
// stops matching; nothing has to run at that time. Changing a person is a
// firewall change, so it goes through apply/rollback like any other.

import type { UciConfig, UciValue } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { normalizeMac } from '../lib/mac';
import { includeOps } from './speedLimit';

export const PERSON_TYPE = 'netui_person';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Day = (typeof DAYS)[number];
/** School nights: Sunday to Thursday. */
export const SCHOOL_NIGHTS: Day[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'];

export interface Bedtime {
  /** Nights, in DAYS order. */
  days: Day[];
  /** "HH:MM", router local time. */
  start: string;
  stop: string;
}

export interface Person {
  section: string;
  name: string;
  /** Normalized lowercase MACs. */
  macs: string[];
  /** Paused in the config; see pauseState() for whether it still applies. */
  paused: boolean;
  /** Epoch seconds the pause ends; undefined: until resumed. */
  pausedUntil?: number;
  /** Bedtime as stored, and whether it is on. */
  bedtime: Bedtime;
  bedtimeOn: boolean;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function days(v: unknown): Day[] {
  const want = new Set(list(v).map((d) => d.slice(0, 1).toUpperCase() + d.slice(1, 3).toLowerCase()));
  return DAYS.filter((d) => want.has(d));
}

export function normalizePeople(fw: UciConfig): Person[] {
  return sectionsOfType(fw, PERSON_TYPE).map((s) => {
    const until = Number(str(s.paused_until));
    return {
      section: s['.name'],
      name: str(s.name) ?? s['.name'],
      macs: list(s.mac)
        .map(normalizeMac)
        .filter((m): m is string => m !== null),
      paused: bool(s.paused, false),
      ...(Number.isInteger(until) && until > 0 ? { pausedUntil: until } : {}),
      bedtime: { days: days(s.bed_day), start: str(s.bed_start) ?? '', stop: str(s.bed_stop) ?? '' },
      bedtimeOn: bool(s.bedtime, false),
    };
  });
}

/** Whether the pause is in force at `nowS` (epoch seconds), and until when. */
export function pauseState(p: Person, nowS: number): { paused: boolean; until?: number } {
  if (!p.paused) return { paused: false };
  if (p.pausedUntil === undefined) return { paused: true };
  return p.pausedUntil > nowS ? { paused: true, until: p.pausedUntil } : { paused: false };
}

const minutes = (t: string) => {
  const m = TIME.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A moment as the router's wall clock shows it. */
export interface WallClock {
  /** Monday = 0. */
  day: number;
  /** Minutes since midnight. */
  minutes: number;
}

/** IANA name for the system config's zonename ("America/New York" is stored with a space). */
export function ianaZone(zonename: string | undefined): string | undefined {
  return zonename ? zonename.replace(/ /g, '_') : undefined;
}

const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * `at` on the router's clock, given its time zone (IANA name); the browser's
 * own zone if none is given or the name is unknown.
 */
export function wallClock(at: Date, zone?: string): WallClock {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    const day = WEEKDAY[get('weekday')];
    if (day !== undefined) return { day, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  } catch {
    // Unknown zone: fall through to the browser's.
  }
  return { day: (at.getDay() + 6) % 7, minutes: at.getHours() * 60 + at.getMinutes() };
}

/** Epoch seconds of the next `HH:MM` on the router's clock after `at`. */
export function nextClockTime(hhmm: string, at: Date, zone?: string): number {
  const target = minutes(hhmm) ?? 7 * 60;
  const wall = wallClock(at, zone);
  const ahead = (target - wall.minutes + 1440) % 1440 || 1440;
  return Math.floor(at.getTime() / 60_000) * 60 + ahead * 60;
}

/**
 * Whether bedtime is on at `clock` (the router's wall clock). Mirrors
 * limits.sh: the night of a day runs from its start time into the next
 * morning.
 */
export function inBedtime(p: Person, clock: WallClock): boolean {
  const b = p.bedtime;
  const start = minutes(b.start);
  const stop = minutes(b.stop);
  if (!p.bedtimeOn || start === null || stop === null || start === stop) return false;
  const length = (stop - start + 1440) % 1440;
  const at = clock.day * 1440 + clock.minutes;
  return b.days.some((d) => {
    const from = DAYS.indexOf(d) * 1440 + start;
    return (at - from + 10080) % 10080 < length;
  });
}

/** "Sun–Thu", "Every night", "Fri, Sat". */
export function daysLabel(d: Day[]): string {
  if (d.length === 7) return 'Every night';
  if (d.length === 5 && SCHOOL_NIGHTS.every((x) => d.includes(x))) return 'Sun–Thu';
  if (d.length === 5 && DAYS.slice(0, 5).every((x) => d.includes(x))) return 'Mon–Fri';
  return d.join(', ');
}

// ---------------------------------------------------------------------------
// Editing

export interface PersonDraft {
  name: string;
  macs: string[];
  bedtimeOn: boolean;
  bedtime: Bedtime;
}

export function newPerson(): PersonDraft {
  return { name: '', macs: [], bedtimeOn: false, bedtime: { days: [...SCHOOL_NIGHTS], start: '21:00', stop: '07:00' } };
}

export function personDraft(p: Person): PersonDraft {
  return {
    name: p.name,
    macs: [...p.macs],
    bedtimeOn: p.bedtimeOn,
    bedtime: p.bedtime.start ? { ...p.bedtime, days: [...p.bedtime.days] } : newPerson().bedtime,
  };
}

export function validatePerson(d: PersonDraft, people: Person[], section?: string): string | null {
  const name = d.name.trim();
  if (!name) return 'Give this person a name.';
  if (name.length > 32) return 'Use a name of at most 32 characters.';
  if (people.some((p) => p.section !== section && p.name.toLowerCase() === name.toLowerCase())) return `${name} is already on the list.`;
  if (d.bedtimeOn) {
    const start = minutes(d.bedtime.start);
    const stop = minutes(d.bedtime.stop);
    if (start === null || stop === null) return 'Bedtime needs a start and an end time.';
    if (start === stop) return 'Bedtime cannot start and end at the same time.';
    if (!d.bedtime.days.length) return 'Choose at least one night for bedtime.';
  }
  return null;
}

/**
 * Ops to save a person (new when `existing` is undefined). A device belongs
 * to one person: it is taken off anyone else who had it. Pause state is kept.
 */
export function personOps(fw: UciConfig, d: PersonDraft, existing?: Person): UciOp[] {
  const macs = [...new Set(d.macs.map((m) => normalizeMac(m)).filter((m): m is string => m !== null))];
  const ops: UciOp[] = [];
  for (const other of normalizePeople(fw)) {
    if (other.section === existing?.section) continue;
    const keep = other.macs.filter((m) => !macs.includes(m));
    if (keep.length !== other.macs.length) {
      ops.push(
        keep.length
          ? { op: 'set', config: 'firewall', section: other.section, values: { mac: keep.map((m) => m.toUpperCase()) } }
          : { op: 'unset', config: 'firewall', section: other.section, options: ['mac'] },
      );
    }
  }
  const values: Record<string, UciValue> = {
    name: d.name.trim(),
    mac: macs.map((m) => m.toUpperCase()),
    bedtime: d.bedtimeOn ? '1' : '',
    bed_day: d.bedtimeOn ? DAYS.filter((x) => d.bedtime.days.includes(x)) : [],
    bed_start: d.bedtimeOn ? d.bedtime.start : '',
    bed_stop: d.bedtimeOn ? d.bedtime.stop : '',
  };
  if (existing) {
    ops.push(...diffSection('firewall', existing.section, fw[existing.section], values));
  } else {
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== '')));
    ops.push({ op: 'add', config: 'firewall', type: PERSON_TYPE, values: set });
  }
  return [...ops, ...includeOps(fw)];
}

export function deletePersonOps(p: Person): UciOp[] {
  return [{ op: 'delete', config: 'firewall', section: p.section }];
}

/**
 * Pause until `until` (epoch seconds), or until resumed (null); `false`
 * resumes.
 */
export function pauseOps(fw: UciConfig, p: Person, until: number | null | false): UciOp[] {
  const values: Record<string, UciValue> =
    until === false ? { paused: '', paused_until: '' } : { paused: '1', paused_until: until === null ? '' : String(Math.floor(until)) };
  return [...diffSection('firewall', p.section, fw[p.section], values), ...(until === false ? [] : includeOps(fw))];
}

/** The person a device belongs to. */
export function personOf(people: Person[], mac: string): Person | undefined {
  const m = normalizeMac(mac);
  return m ? people.find((p) => p.macs.includes(m)) : undefined;
}
