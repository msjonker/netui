import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet } from '../api/types';
import recorded from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wifi_schedule.json';
import {
  deleteScheduleOps,
  describeDays,
  newScheduleDraft,
  normalizeSchedule,
  scheduleDraft,
  scheduleEnableOps,
  scheduleOps,
  validateSchedule,
} from './wifiSchedule';

const get: UciGet = recorded;
const cfg = (): UciConfig => structuredClone(get.values);

describe('wifi_schedule', () => {
  it('reads the global switch and entries', () => {
    const s = normalizeSchedule(cfg());
    expect(s.global).toBe('cfg013fd6');
    expect(s.enabled).toBe(false);
    expect(s.entries).toEqual([
      {
        section: 'Businesshours',
        enabled: false,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        start: '06:00',
        stop: '22:00',
        forceDown: false,
      },
      { section: 'Weekend', enabled: false, days: ['Saturday', 'Sunday'], start: '00:00', stop: '00:00', forceDown: true },
    ]);
  });

  it('describes days', () => {
    expect(describeDays(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])).toBe('Weekdays');
    expect(describeDays(['Sunday', 'Saturday'])).toBe('Weekends');
    expect(describeDays(['Monday', 'Wednesday'])).toBe('Mon, Wed');
    expect(describeDays([])).toBe('No days');
  });

  it('adds a named entry in the form LuCI writes', () => {
    const d = { ...newScheduleDraft(), name: 'School', days: ['Friday' as const, 'Monday' as const], start: '07:30', stop: '21:00' };
    expect(scheduleOps(d, undefined, cfg())).toEqual([
      {
        op: 'add',
        config: 'wifi_schedule',
        type: 'entry',
        name: 'School',
        values: { enabled: '1', daysofweek: 'Monday Friday', starttime: '07:30', stoptime: '21:00', forcewifidown: '0' },
      },
    ]);
  });

  it('edits only what changed, and deletes', () => {
    const c = cfg();
    const [biz] = normalizeSchedule(c).entries;
    expect(scheduleOps(scheduleDraft(biz!), biz, c)).toEqual([]);
    expect(scheduleOps({ ...scheduleDraft(biz!), enabled: true, stop: '23:00' }, biz, c)).toEqual([
      { op: 'set', config: 'wifi_schedule', section: 'Businesshours', values: { enabled: '1', stoptime: '23:00' } },
    ]);
    expect(deleteScheduleOps(biz!)).toEqual([{ op: 'delete', config: 'wifi_schedule', section: 'Businesshours' }]);
  });

  it('toggles the global switch, creating it if missing', () => {
    const c = cfg();
    expect(scheduleEnableOps(true, normalizeSchedule(c), c)).toEqual([
      { op: 'set', config: 'wifi_schedule', section: 'cfg013fd6', values: { enabled: '1' } },
    ]);
    delete c.cfg013fd6;
    expect(scheduleEnableOps(true, normalizeSchedule(c), c)).toEqual([
      {
        op: 'add',
        config: 'wifi_schedule',
        type: 'global',
        values: { enabled: '1', logging: '0', recheck_interval: '10', modules_retries: '10' },
      },
    ]);
  });

  it('validates', () => {
    const entries = normalizeSchedule(cfg()).entries;
    const d = { ...newScheduleDraft(), name: 'Night' };
    expect(validateSchedule(d, entries, true)).toBeNull();
    expect(validateSchedule({ ...d, name: 'Weekend' }, entries, true)).toMatch(/already exists/);
    expect(validateSchedule({ ...d, name: 'my schedule' }, entries, true)).toMatch(/letters/);
    expect(validateSchedule({ ...d, days: [] }, entries, true)).toMatch(/day/);
    expect(validateSchedule({ ...d, stop: '24:00' }, entries, true)).toMatch(/HH:MM/);
  });
});
