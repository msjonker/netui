import { describe, expect, it } from 'vitest';
import type { FirmwareJob, FirmwareStatus } from '../api/types';
import idle from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.idle.json';
import checking from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.checking.json';
import checked from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.checked.json';
import setup from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-setup.json';
import building from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-building.json';
import saved from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-saved.json';
import failed from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-failed.json';
import installing from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.upgrade-installing.synthetic.json';
import { firmwareView, logLines, newerRelease, parseCheck, upgradeProgress } from './firmware';

const s = (x: unknown) => x as FirmwareStatus;
const job = (over: Partial<FirmwareJob>): FirmwareJob => ({ action: 'check', version: null, started: 0, running: false, exit: 0, log: '', ...over });

describe('firmware check', () => {
  it('reads the recorded check: same release, package updates, safe', () => {
    expect(parseCheck(s(checked).job!)).toMatchObject({ from: '25.12.6', to: '25.12.6', outdated: 35, verdict: 'update', errors: [] });
  });

  it('shows nothing while the check runs, and before any', () => {
    expect(firmwareView(s(checking))).toMatchObject({ checking: true });
    expect(firmwareView(s(checking)).check).toBeUndefined();
    expect(firmwareView(s(idle))).toEqual({ available: true, installed: '25.12.6', checking: false, newerRelease: undefined });
  });

  it('is current when owut sees no changes', () => {
    const log = 'Version-from   25.12.7 r1\nVersion-to     25.12.7 r1\nAll packages are up-to-date\nThere are no changes, upgrade not necessary (re-run with \'--verbose\' for details)\n';
    expect(parseCheck(job({ log }))).toMatchObject({ outdated: 0, verdict: 'current' });
  });

  it('reports owut errors and downgrades as blocked', () => {
    const log = 'ERROR: There are 2 missing packages in the build package list, run \'owut check\'\nERROR: Checks reveal errors, do not upgrade\n';
    expect(parseCheck(job({ log, exit: 1 }))).toMatchObject({ verdict: 'blocked', errors: [expect.stringMatching(/missing packages/), expect.any(String)] });
    const down = parseCheck(job({ log: 'WARNING: Checks reveal package downgrades, upgrade still possible with \'--force\'\n' }));
    expect(down).toMatchObject({ verdict: 'blocked', errors: ['Some packages would be downgraded.'] });
  });

  it('strips colours and cursor movement', () => {
    expect(logLines('\x1b[1A\x1b[KStatus:   \x1b[32mqueued\x1b[0m - 1 ahead of you\r\n')).toEqual(['Status:   queued - 1 ahead of you']);
  });
});

describe('firmware upgrade', () => {
  it('follows the recorded upgrade through the build server', () => {
    expect(upgradeProgress(s(setup).job!)).toEqual({ phase: 'building', detail: 'setting up', errors: [] });
    expect(upgradeProgress(s(building).job!)).toEqual({ phase: 'building', detail: 'building the image', errors: [] });
    expect(upgradeProgress(s(saved).job!)).toEqual({ phase: 'verifying', errors: [] });
    const queued = (n: number) => upgradeProgress(job({ action: 'upgrade', running: true, exit: null, log: `Status:   queued - ${n} ahead of you\n` }));
    expect(queued(2)).toMatchObject({ phase: 'queued', detail: '2 ahead in the queue' });
    expect(queued(0)).toMatchObject({ phase: 'queued', detail: 'next in the queue' });
    expect(upgradeProgress(job({ action: 'upgrade', running: true, exit: null, log: 'Status:   done\n' })).phase).toBe('downloading');
    expect(upgradeProgress(job({ action: 'upgrade', running: true, exit: null, log: 'Download progress:  41.6%  8388608/20185600 bytes\n' }))).toMatchObject({
      phase: 'downloading',
      detail: '41%',
    });
    expect(upgradeProgress(job({ action: 'upgrade', running: true, exit: null, log: 'Version-from 25.12.6\n' })).phase).toBe('preparing');
  });

  it('counts a clean exit as installing: sysupgrade takes over', () => {
    expect(upgradeProgress(s(installing).job!).phase).toBe('installing');
    expect(firmwareView(s(installing)).upgrade).toMatchObject({ phase: 'installing', version: '25.12.6' });
  });

  it('reports a failed upgrade with owut\'s last word when it prints no ERROR line', () => {
    expect(upgradeProgress(s(failed).job!)).toEqual({
      phase: 'failed',
      errors: ["Your specified version-to '25.12.99' is not available.  Pick one from above."],
    });
    const log = 'Build failed in  61s total =  18s in queue +  43s to build:\nERROR: Build failed with status 500\n';
    expect(upgradeProgress(job({ action: 'upgrade', exit: 1, log })).errors).toEqual(['Build failed with status 500']);
    // A finished, failed upgrade is not shown as running.
    expect(firmwareView(s(failed)).upgrade).toBeUndefined();
  });

  it('notices owut finding nothing to do', () => {
    const log = "There are no changes to upgrade (see '--force')\n";
    expect(upgradeProgress(job({ action: 'upgrade', log })).phase).toBe('unchanged');
  });
});

describe('newer release', () => {
  const latest = { '23.05': '23.05.6', '24.10': '24.10.8', '25.12': '25.12.6', SNAPSHOT: 'SNAPSHOT' };

  it('offers the newest stable release of a later branch', () => {
    expect(newerRelease({ current: '24.10', latest })).toBe('25.12.6');
    expect(newerRelease({ current: '25.12', latest })).toBeUndefined();
  });

  it('skips release candidates', () => {
    expect(newerRelease({ current: '25.12', latest: { ...latest, '26.06': '26.06.0-rc1' } })).toBeUndefined();
  });
});
