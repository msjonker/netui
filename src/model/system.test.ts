import { describe, expect, it } from 'vitest';
import type { LuciTimezones, UciGet } from '../api/types';
import { wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import uciSystem from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.system.json';
import tzJson from '../../test/fixtures/ubus/dl-wrx36/plain/luci.getTimezones.json';
import {
  clockSkew,
  normalizeSystemSettings,
  normalizeTimezones,
  systemDetails,
  systemOps,
  validateSystem,
} from './system';

const recorded: UciGet = uciSystem;
const tz: LuciTimezones = tzJson;
const cfg = () => structuredClone(recorded.values);
const zones = normalizeTimezones(tz);

function staged(c: ReturnType<typeof cfg>, ops: Parameters<typeof stageOn>[1]) {
  const r = new FakeRouter({ system: c });
  stageOn(r, ops);
  return r.current('system')!;
}

describe('system settings', () => {
  it('reads the recorded config', () => {
    expect(normalizeSystemSettings(cfg())).toEqual({
      section: 'cfg01e48a',
      hostname: 'OpenWrt',
      zonename: 'UTC',
      ntpSection: 'ntp',
      ntpEnabled: true,
      ntpServer: false,
      ntpServers: ['0.openwrt.pool.ntp.org', '1.openwrt.pool.ntp.org', '2.openwrt.pool.ntp.org', '3.openwrt.pool.ntp.org'],
    });
  });

  it('lists zones with UTC first, names as LuCI stores them', () => {
    expect(zones[0]).toEqual({ name: 'UTC', tz: 'GMT0' });
    expect(zones.find((z) => z.name === 'Europe/Amsterdam')).toEqual({ name: 'Europe/Amsterdam', tz: 'CET-1CEST,M3.5.0,M10.5.0/3' });
    expect(zones.some((z) => z.name === 'Africa/Addis Ababa')).toBe(true);
  });

  it('writes hostname, zone name with its TZ string, and NTP', () => {
    const c = cfg();
    const s = normalizeSystemSettings(c)!;
    const next = { ...s, hostname: 'gateway', zonename: 'Europe/Amsterdam', ntpServer: true, ntpServers: ['time.cloudflare.com'] };
    expect(validateSystem(next, zones)).toEqual({});
    const out = staged(c, systemOps(next, c, zones));
    expect(out.cfg01e48a).toMatchObject({ hostname: 'gateway', zonename: 'Europe/Amsterdam', timezone: 'CET-1CEST,M3.5.0,M10.5.0/3' });
    expect(out.ntp).toMatchObject({ enabled: '1', enable_server: '1', server: ['time.cloudflare.com'] });
  });

  it('only touches what changed', () => {
    const c = cfg();
    const s = normalizeSystemSettings(c)!;
    expect(systemOps(s, c, zones)).toEqual([]);
    expect(systemOps({ ...s, ntpEnabled: false }, c, zones)).toEqual([
      { op: 'set', config: 'system', section: 'ntp', values: { enabled: '0' } },
    ]);
  });

  it('creates the NTP section when missing', () => {
    const c = cfg();
    delete c.ntp;
    const s = normalizeSystemSettings(c)!;
    expect(s.ntpEnabled).toBe(false);
    const out = staged(c, systemOps({ ...s, ntpEnabled: true, ntpServers: ['pool.ntp.org'] }, c, zones));
    expect(out.ntp).toMatchObject({ '.type': 'timeserver', enabled: '1', server: ['pool.ntp.org'] });
  });

  it('validates', () => {
    const s = normalizeSystemSettings(cfg())!;
    expect(validateSystem({ ...s, hostname: 'my router', zonename: 'Mars/Base', ntpServers: [] }, zones)).toEqual({
      hostname: expect.any(String),
      zonename: expect.any(String),
      ntpServers: 'Add at least one server.',
    });
  });
});

describe('clock and hardware', () => {
  it('computes skew in seconds', () => {
    expect(clockSkew(1_000, 1_000_000)).toBe(0);
    expect(clockSkew(1_000, 1_600_000)).toBe(-600);
  });

  it('summarises the recorded board', () => {
    const f = wrxFixtures('plain');
    const d = systemDetails(f.systemBoard(), f.systemInfo());
    expect(d).toMatchObject({
      model: 'Dynalink DL-WRX36',
      firmware: 'OpenWrt SNAPSHOT r0-957029c3',
      kernel: '6.12.51',
      uptime: 975,
      memory: { used: 906334208 - 689954816, total: 906334208 },
      storage: { used: 332 * 1024, total: 63076 * 1024 },
    });
    expect(d.load[0]).toBeCloseTo(0.03, 2);
  });
});
