import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet, UciSection } from '../api/types';
import wrxFirewall from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import { hardwareOffload, limitOps, limitSummary, normalizeLimits, validateLimit } from './speedLimit';

const fw = (): UciConfig => structuredClone((wrxFirewall as UciGet).values) as UciConfig;
const section = (name: string, type: string, values: Record<string, string>): UciSection => ({
  '.anonymous': false,
  '.index': 99,
  '.name': name,
  '.type': type,
  ...values,
});
const MAC = '8c:de:f9:b6:f3:24';
const include = section('netui_limits', 'include', { type: 'script', path: '/usr/share/netui/limits.sh' });

describe('normalizeLimits', () => {
  it('reads limits and skips those without a valid MAC', () => {
    const cfg: UciConfig = { ...fw(), l1: section('l1', 'netui_limit', { mac: MAC.toUpperCase(), name: 'Office AP', download: '2', upload: '1' }) };
    cfg.l2 = section('l2', 'netui_limit', { mac: 'bad;mac', download: '5' });
    expect(normalizeLimits(cfg)).toEqual([{ section: 'l1', mac: MAC, name: 'Office AP', download: '2', upload: '1', enabled: true }]);
    expect(normalizeLimits(fw())).toEqual([]);
  });
});

describe('limitOps', () => {
  it('adds the limit and, the first time, the script include', () => {
    expect(limitOps(fw(), MAC, 'Office AP', { download: '10', upload: '' })).toEqual([
      { op: 'add', config: 'firewall', type: 'netui_limit', values: { name: 'Office AP', mac: MAC.toUpperCase(), download: '10' } },
      { op: 'add', config: 'firewall', type: 'include', name: 'netui_limits', values: { type: 'script', path: '/usr/share/netui/limits.sh' } },
    ]);
  });

  it('edits an existing limit in place and leaves a good include alone', () => {
    const cfg: UciConfig = { ...fw(), netui_limits: include, l1: section('l1', 'netui_limit', { mac: MAC, name: 'Office AP', download: '2', upload: '1' }) };
    expect(limitOps(cfg, MAC.toUpperCase(), 'Office AP', { download: '5', upload: '' })).toEqual([
      { op: 'set', config: 'firewall', section: 'l1', values: { mac: MAC.toUpperCase(), download: '5' } },
      { op: 'unset', config: 'firewall', section: 'l1', options: ['upload'] },
    ]);
  });

  it('re-enables a switched-off include', () => {
    const cfg = { ...fw(), netui_limits: { ...include, enabled: '0' } };
    expect(limitOps(cfg, MAC, 'x', { download: '1', upload: '' })).toContainEqual({
      op: 'unset',
      config: 'firewall',
      section: 'netui_limits',
      options: ['enabled'],
    });
  });

  it('removes every section for the device when both are empty, and keeps the include', () => {
    const cfg: UciConfig = { ...fw(), netui_limits: include, l1: section('l1', 'netui_limit', { mac: MAC, download: '2' }) };
    cfg.l2 = section('l2', 'netui_limit', { mac: MAC.toUpperCase(), upload: '3' });
    expect(limitOps(cfg, MAC, 'x', { download: '', upload: '' })).toEqual([
      { op: 'delete', config: 'firewall', section: 'l1' },
      { op: 'delete', config: 'firewall', section: 'l2' },
    ]);
  });

  it('drops a second section for the same device when editing', () => {
    const cfg: UciConfig = { ...fw(), netui_limits: include, l1: section('l1', 'netui_limit', { mac: MAC, name: 'x', download: '2' }) };
    cfg.l2 = section('l2', 'netui_limit', { mac: MAC, upload: '3' });
    expect(limitOps(cfg, MAC, 'x', { download: '2', upload: '' })).toEqual([
      { op: 'delete', config: 'firewall', section: 'l2' },
      { op: 'set', config: 'firewall', section: 'l1', values: { mac: MAC.toUpperCase() } },
    ]);
  });
});

describe('validateLimit and helpers', () => {
  it('takes positive Mbit/s, decimals too', () => {
    expect(validateLimit({ download: '10', upload: '0.5' })).toBeNull();
    expect(validateLimit({ download: '', upload: '' })).toBeNull();
    expect(validateLimit({ download: '0', upload: '' })).toMatch(/Download/);
    expect(validateLimit({ download: '', upload: '1e3' })).toMatch(/Upload/);
    expect(validateLimit({ download: '20000', upload: '' })).toMatch(/at most/);
  });

  it('summarises and spots hardware offloading', () => {
    expect(limitSummary({ download: '10', upload: '2' })).toBe('10 Mbit/s down, 2 Mbit/s up');
    expect(limitSummary({ download: '', upload: '2' })).toBe('2 Mbit/s up');
    const cfg = fw();
    const d = Object.values(cfg).find((s) => s['.type'] === 'defaults')!;
    expect(hardwareOffload(cfg)).toBe(false);
    Object.assign(d, { flow_offloading: '1' });
    expect(hardwareOffload(cfg)).toBe(false);
    Object.assign(d, { flow_offloading_hw: '1' });
    expect(hardwareOffload(cfg)).toBe(true);
  });
});
