import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet, UciSection } from '../api/types';
import wrxFirewall from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import {
  daysLabel,
  inBedtime,
  nextClockTime,
  wallClock,
  newPerson,
  normalizePeople,
  pauseOps,
  pauseState,
  personOf,
  personOps,
  validatePerson,
  type Person,
} from './people';

const fw = (): UciConfig => structuredClone((wrxFirewall as UciGet).values) as UciConfig;
const section = (name: string, type: string, values: Record<string, string | string[]>): UciSection => ({
  '.anonymous': false,
  '.index': 99,
  '.name': name,
  '.type': type,
  ...values,
});
const A = 'aa:bb:cc:00:00:01';
const B = 'aa:bb:cc:00:00:02';
const C = 'aa:bb:cc:00:00:03';
const INCLUDE = { op: 'add', config: 'firewall', type: 'include', name: 'netui_limits', values: { type: 'script', path: '/usr/share/netui/limits.sh' } };

function withSam(extra: Record<string, string | string[]> = {}): UciConfig {
  return {
    ...fw(),
    sam: section('sam', 'netui_person', { name: 'Sam', mac: [A.toUpperCase(), B.toUpperCase(), 'nonsense'], ...extra }),
  };
}

describe('normalizePeople', () => {
  it('reads people, their devices, pause and bedtime', () => {
    const cfg = withSam({ paused: '1', paused_until: '1800000000', bedtime: '1', bed_day: ['sun', 'Thu', 'Mon'], bed_start: '21:00', bed_stop: '07:00' });
    expect(normalizePeople(cfg)).toEqual([
      {
        section: 'sam',
        name: 'Sam',
        macs: [A, B],
        paused: true,
        pausedUntil: 1800000000,
        bedtime: { days: ['Mon', 'Thu', 'Sun'], start: '21:00', stop: '07:00' },
        bedtimeOn: true,
      },
    ]);
    expect(normalizePeople(fw())).toEqual([]);
  });
});

describe('pauseState', () => {
  const [sam] = normalizePeople(withSam({ paused: '1', paused_until: '1000' })) as [Person];
  it('runs out on its own', () => {
    expect(pauseState(sam, 999)).toEqual({ paused: true, until: 1000 });
    expect(pauseState(sam, 1000)).toEqual({ paused: false });
    expect(pauseState({ ...sam, pausedUntil: undefined }, 5000)).toEqual({ paused: true });
    expect(pauseState({ ...sam, paused: false }, 5)).toEqual({ paused: false });
  });
});

describe('inBedtime', () => {
  const [sam] = normalizePeople(
    withSam({ bedtime: '1', bed_day: ['Sun', 'Fri'], bed_start: '21:30', bed_stop: '07:00' }),
  ) as [Person];
  // 2026-11-22 is a Sunday; the clock read in the browser's zone.
  const at = (d: string) => wallClock(new Date(`${d}:00`));
  it('covers a night from its start into the next morning', () => {
    expect(inBedtime(sam, at('2026-11-22T21:29'))).toBe(false);
    expect(inBedtime(sam, at('2026-11-22T21:30'))).toBe(true);
    expect(inBedtime(sam, at('2026-11-23T06:59'))).toBe(true);
    expect(inBedtime(sam, at('2026-11-23T07:00'))).toBe(false);
    // Monday night is not a bedtime night.
    expect(inBedtime(sam, at('2026-11-23T22:00'))).toBe(false);
    // Friday night into Saturday.
    expect(inBedtime(sam, at('2026-11-28T02:00'))).toBe(true);
    expect(inBedtime({ ...sam, bedtimeOn: false }, at('2026-11-22T22:00'))).toBe(false);
  });
  it('handles a window within one day', () => {
    const nap = { ...sam, bedtime: { days: ['Sat' as const], start: '13:00', stop: '15:00' } };
    expect(inBedtime(nap, at('2026-11-28T14:00'))).toBe(true);
    expect(inBedtime(nap, at('2026-11-28T15:00'))).toBe(false);
  });
});

describe('wallClock', () => {
  const t = new Date('2026-11-23T02:30:00Z');
  it('reads the router’s zone', () => {
    expect(wallClock(t, 'UTC')).toEqual({ day: 0, minutes: 150 });
    // 21:30 on Sunday in New York.
    expect(wallClock(t, 'America/New_York')).toEqual({ day: 6, minutes: 21 * 60 + 30 });
    expect(wallClock(t, 'Not/AZone')).toEqual(wallClock(t));
  });
  it('finds the next time on that clock', () => {
    expect(nextClockTime('07:00', t, 'UTC')).toBe(Date.parse('2026-11-23T07:00:00Z') / 1000);
    expect(nextClockTime('07:00', t, 'America/New_York')).toBe(Date.parse('2026-11-23T12:00:00Z') / 1000);
    expect(nextClockTime('02:30', t, 'UTC')).toBe(Date.parse('2026-11-24T02:30:00Z') / 1000);
  });
});

describe('validatePerson', () => {
  const people = normalizePeople(withSam());
  it('needs a unique name and a sensible bedtime', () => {
    expect(validatePerson({ ...newPerson(), name: ' ' }, people)).toBe('Give this person a name.');
    expect(validatePerson({ ...newPerson(), name: 'sam' }, people)).toBe('sam is already on the list.');
    expect(validatePerson({ ...newPerson(), name: 'Sam' }, people, 'sam')).toBeNull();
    const d = { ...newPerson(), name: 'Alex', bedtimeOn: true };
    expect(validatePerson(d, people)).toBeNull();
    expect(validatePerson({ ...d, bedtime: { ...d.bedtime, stop: '21:00' } }, people)).toMatch(/same time/);
    expect(validatePerson({ ...d, bedtime: { ...d.bedtime, start: '25:00' } }, people)).toMatch(/start and an end/);
    expect(validatePerson({ ...d, bedtime: { ...d.bedtime, days: [] } }, people)).toMatch(/one night/);
  });
});

describe('personOps', () => {
  it('adds a person and, the first time, the script include', () => {
    const d = { ...newPerson(), name: ' Alex ', macs: [C], bedtimeOn: true };
    expect(personOps(fw(), d)).toEqual([
      {
        op: 'add',
        config: 'firewall',
        type: 'netui_person',
        values: { name: 'Alex', mac: [C.toUpperCase()], bedtime: '1', bed_day: ['Mon', 'Tue', 'Wed', 'Thu', 'Sun'], bed_start: '21:00', bed_stop: '07:00' },
      },
      INCLUDE,
    ]);
  });

  it('moves a device from someone else and edits only what changed', () => {
    const cfg: UciConfig = { ...withSam(), netui_limits: section('netui_limits', 'include', { type: 'script', path: '/usr/share/netui/limits.sh' }) };
    cfg.alex = section('alex', 'netui_person', { name: 'Alex', mac: [C.toUpperCase()] });
    const alex = normalizePeople(cfg).find((p) => p.name === 'Alex')!;
    expect(personOps(cfg, { ...newPerson(), name: 'Alex', macs: [C, B] }, alex)).toEqual([
      { op: 'set', config: 'firewall', section: 'sam', values: { mac: [A.toUpperCase()] } },
      { op: 'set', config: 'firewall', section: 'alex', values: { mac: [C.toUpperCase(), B.toUpperCase()] } },
    ]);
    // Taking someone's only device leaves them with none.
    cfg.sam!.mac = [B.toUpperCase()];
    expect(personOps(cfg, { ...newPerson(), name: 'Alex', macs: [C, B] }, alex)[0]).toEqual({
      op: 'unset',
      config: 'firewall',
      section: 'sam',
      options: ['mac'],
    });
  });

  it('turns bedtime off by removing its options', () => {
    const cfg = withSam({ bedtime: '1', bed_day: ['Sun'], bed_start: '21:00', bed_stop: '07:00' });
    cfg.netui_limits = section('netui_limits', 'include', { type: 'script', path: '/usr/share/netui/limits.sh' });
    const [sam] = normalizePeople(cfg) as [Person];
    expect(personOps(cfg, { name: 'Sam', macs: [A, B], bedtimeOn: false, bedtime: sam.bedtime }, sam)).toEqual([
      // The unreadable MAC goes too.
      { op: 'set', config: 'firewall', section: 'sam', values: { mac: [A.toUpperCase(), B.toUpperCase()] } },
      { op: 'unset', config: 'firewall', section: 'sam', options: ['bedtime', 'bed_day', 'bed_start', 'bed_stop'] },
    ]);
  });
});

describe('pauseOps', () => {
  it('pauses until a time or until resumed, and resumes', () => {
    const cfg = withSam();
    const [sam] = normalizePeople(cfg) as [Person];
    expect(pauseOps(cfg, sam, 1800000000.7)).toEqual([
      { op: 'set', config: 'firewall', section: 'sam', values: { paused: '1', paused_until: '1800000000' } },
      INCLUDE,
    ]);
    expect(pauseOps(cfg, sam, null)[0]).toEqual({ op: 'set', config: 'firewall', section: 'sam', values: { paused: '1' } });
    const paused = withSam({ paused: '1', paused_until: '5' });
    expect(pauseOps(paused, normalizePeople(paused)[0]!, false)).toEqual([
      { op: 'unset', config: 'firewall', section: 'sam', options: ['paused', 'paused_until'] },
    ]);
  });
});

describe('helpers', () => {
  it('labels nights and finds a device’s person', () => {
    expect(daysLabel(['Mon', 'Tue', 'Wed', 'Thu', 'Sun'])).toBe('Sun–Thu');
    expect(daysLabel(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).toBe('Every night');
    expect(daysLabel(['Fri', 'Sat'])).toBe('Fri, Sat');
    const people = normalizePeople(withSam());
    expect(personOf(people, B.toUpperCase())?.name).toBe('Sam');
    expect(personOf(people, C)).toBeUndefined();
  });
});
