import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet, UciSection } from '../api/types';
import wrxFirewall from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import recorded from '../../test/fixtures/ubus/dl-wrx36/plain/netui.history.get.json';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import { diffConfigs, options, pageLabel, restoreOps } from './history';
import type { HistoryDetail } from '../api/types';

const fw = (): UciConfig => structuredClone((wrxFirewall as UciGet).values) as UciConfig;
const rule = (name: string, index: number, extra: Record<string, string> = {}): UciSection => ({
  '.anonymous': true,
  '.index': index,
  '.name': `cfg${name}`,
  '.type': 'rule',
  name,
  src: 'wan',
  target: 'ACCEPT',
  ...extra,
});

/** Sections in file order (anonymous names dropped): what a restore must reproduce. */
const shape = (cfg: UciConfig) =>
  Object.values(cfg).map((s) => [s['.anonymous'] ? '' : s['.name'], s['.type'], JSON.stringify(Object.entries(options(s)).sort())]);

/** Stage the restore on a fake router holding `current` and read the result back. */
function restored(current: UciConfig, target: UciConfig): UciConfig {
  const r = new FakeRouter({ firewall: structuredClone(current) });
  return stageOn(r, restoreOps('firewall', current, target)).firewall!;
}

const rulesOf = (cfg: UciConfig) => Object.values(cfg).filter((s) => s['.type'] === 'rule');

describe('restoreOps', () => {
  it('undoes an added rule by deleting it, and nothing else', () => {
    const before = fw();
    const after = { ...fw(), 'cfgAllow-SSH': rule('Allow-SSH', 99, { proto: 'tcp', dest_port: '22' }) };
    expect(restoreOps('firewall', after, before)).toEqual([{ op: 'delete', config: 'firewall', section: 'cfgAllow-SSH' }]);
    expect(restoreOps('firewall', before, before)).toEqual([]);
  });

  it('brings a removed rule back in its place, even though anonymous names moved', () => {
    const before = fw();
    const names = rulesOf(before).map((s) => s['.name']);
    const after = fw();
    delete after[names[1]!];
    // UCI renumbers anonymous sections when one goes; the names no longer line up.
    const renamed: UciConfig = Object.fromEntries(
      Object.values(after).map((s, i) => {
        const name = s['.anonymous'] ? `cfg${(0x90 + i).toString(16)}` : s['.name'];
        return [name, { ...s, '.name': name }];
      }),
    );
    const result = restored(renamed, before);
    expect(shape(result).filter((s) => s[1] === 'rule')).toEqual(shape(before).filter((s) => s[1] === 'rule'));
    expect(shape(result).filter((s) => s[1] === 'zone')).toEqual(shape(before).filter((s) => s[1] === 'zone'));
  });

  it('puts back options that were removed and removes ones that were added', () => {
    const before = fw();
    const after = fw();
    const zone = Object.values(after).find((s) => s['.type'] === 'zone' && s.name === 'wan')!;
    zone.input = 'ACCEPT';
    delete zone.mtu_fix;
    zone.log = '1';
    expect(restoreOps('firewall', after, before)).toEqual([
      { op: 'set', config: 'firewall', section: zone['.name'], values: { input: 'REJECT', mtu_fix: '1' } },
      { op: 'unset', config: 'firewall', section: zone['.name'], options: ['log'] },
    ]);
  });

  it('replaces a named section whose type changed and re-adds a removed named one', () => {
    const before: UciConfig = { ...fw(), netui_limits: { '.anonymous': false, '.index': 50, '.name': 'netui_limits', '.type': 'include', type: 'script', path: '/x' } };
    const after: UciConfig = { ...fw(), netui_limits: { '.anonymous': false, '.index': 50, '.name': 'netui_limits', '.type': 'rule', name: 'odd' } };
    expect(restoreOps('firewall', after, before)).toEqual([
      { op: 'delete', config: 'firewall', section: 'netui_limits' },
      { op: 'add', config: 'firewall', type: 'include', name: 'netui_limits', values: { type: 'script', path: '/x' } },
    ]);
    const gone = fw();
    expect(restoreOps('firewall', gone, before).at(-1)).toMatchObject({ op: 'add', name: 'netui_limits' });
  });
});

describe('diffConfigs', () => {
  it('lists what changed in a recorded entry', () => {
    const e = recorded as HistoryDetail;
    expect(diffConfigs(e.before.system!, e.after.system!)).toEqual([
      expect.objectContaining({ kind: 'change', options: [{ option: 'description', after: 'history test' }] }),
    ]);
  });

  it('masks secrets and reports added and removed sections', () => {
    const before: UciConfig = {
      w: { '.anonymous': false, '.index': 0, '.name': 'w', '.type': 'wifi-iface', ssid: 'Home', key: 'old-secret' },
      x: { '.anonymous': true, '.index': 1, '.name': 'cfg1', '.type': 'rule', name: 'gone' },
    };
    const after: UciConfig = {
      w: { ...before.w!, key: 'new-secret' },
      y: { '.anonymous': true, '.index': 1, '.name': 'cfg2', '.type': 'redirect', name: 'new', dest_port: '80' },
    };
    const d = diffConfigs(before, after);
    expect(d.find((c) => c.kind === 'change')!.options).toEqual([{ option: 'key', before: '••••••••', after: '••••••••' }]);
    expect(d.find((c) => c.kind === 'remove')!.section.name).toBe('gone');
    expect(d.find((c) => c.kind === 'add')!.options).toEqual([
      { option: 'name', after: 'new' },
      { option: 'dest_port', after: '80' },
    ]);
  });
});

describe('pageLabel', () => {
  it('names the page a change came from', () => {
    expect(pageLabel('/settings/wifi')).toBe('WiFi');
    expect(pageLabel('/clients/aa:bb:cc:dd:ee:ff')).toBe('Client Devices');
    expect(pageLabel(undefined)).toBeUndefined();
  });
});
