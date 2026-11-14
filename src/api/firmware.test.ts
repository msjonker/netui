import { describe, expect, it, vi } from 'vitest';
import type { FirmwareStatus } from './types';
import { SessionExpiredError, TransportError } from './ubus';
import { upgradeAndWait, type UpgradeDeps, type UpgradeStep } from './firmware';
import building from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-building.json';
import installing from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.upgrade-installing.synthetic.json';
import failed from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-failed.json';
import idle from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.idle.json';

const S = (x: unknown) => x as FirmwareStatus;

function deps(statuses: (FirmwareStatus | Error)[], over: Partial<UpgradeDeps> = {}): UpgradeDeps {
  const status = vi.fn();
  for (const r of statuses) {
    if (r instanceof Error) status.mockRejectedValueOnce(r);
    else status.mockResolvedValueOnce(r);
  }
  status.mockRejectedValue(new TransportError('gone'));
  return { start: vi.fn(async () => {}), status, restart: vi.fn(async () => 'back' as const), sleep: async () => {}, ...over };
}

describe('upgradeAndWait', () => {
  it('follows the build, then waits for the restart', async () => {
    const d = deps([S(building), S(installing)]);
    const steps: UpgradeStep[] = [];
    expect(await upgradeAndWait(d, '25.12.6', (s) => steps.push(s))).toEqual({ result: 'back' });
    expect(d.start).toHaveBeenCalledWith('25.12.6');
    expect(steps.map((s) => s.phase)).toEqual(['preparing', 'building', 'installing', 'restarting']);
    expect(d.restart).toHaveBeenCalledOnce();
  });

  it('stops on a failed build without waiting for a restart', async () => {
    const d = deps([S(building), S(failed)]);
    expect(await upgradeAndWait(d, '25.12.6', () => {})).toMatchObject({ result: 'failed', errors: [expect.stringMatching(/not available/)] });
    expect(d.restart).not.toHaveBeenCalled();
  });

  it('treats a device that stops answering as restarting', async () => {
    const d = deps([S(building)]);
    expect(await upgradeAndWait(d, '25.12.6', () => {})).toEqual({ result: 'back' });
    expect(d.status).toHaveBeenCalledTimes(4);
  });

  it('rides out a single missed poll', async () => {
    const d = deps([new TransportError('slow'), S(building), S(failed)]);
    expect((await upgradeAndWait(d, '25.12.6', () => {})).result).toBe('failed');
  });

  it('goes straight to waiting when the session or the job is gone (already rebooted)', async () => {
    expect((await upgradeAndWait(deps([new SessionExpiredError()]), 'x', () => {})).result).toBe('back');
    const d = deps([S(idle)]);
    expect((await upgradeAndWait(d, 'x', () => {})).result).toBe('back');
    expect(d.status).toHaveBeenCalledOnce();
  });

  it('passes on a refused start', async () => {
    const d = deps([], { start: vi.fn(async () => Promise.reject(new Error('a firmware job is already running'))) });
    await expect(upgradeAndWait(d, 'x', () => {})).rejects.toThrow('already running');
  });
});
