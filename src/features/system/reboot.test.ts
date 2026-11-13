import { describe, expect, it, vi } from 'vitest';
import { TransportError, UbusError, UbusStatus } from '../../api/ubus';
import { rebootAndWait, type RebootDeps } from './reboot';

function deps(over: Partial<RebootDeps> = {}): RebootDeps {
  let clock = 0;
  return {
    reboot: vi.fn(async () => undefined),
    probe: vi.fn(async () => true),
    check: vi.fn(async () => ({})),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
}

describe('rebootAndWait', () => {
  it('treats a dropped connection on the reboot call as started', async () => {
    const d = deps({ reboot: vi.fn(async () => Promise.reject(new TransportError('gone'))) });
    const phases: string[] = [];
    expect(await rebootAndWait(d, (p) => phases.push(p))).toBe('back');
    expect(phases).toEqual(['stopping', 'starting', 'checking']);
  });

  it('fails on a real error from the reboot call', async () => {
    const d = deps({ reboot: vi.fn(async () => Promise.reject(new UbusError(UbusStatus.PERMISSION_DENIED, 'system', 'reboot'))) });
    await expect(rebootAndWait(d)).rejects.toBeInstanceOf(UbusError);
  });

  it('gives up when the router never answers again', async () => {
    expect(await rebootAndWait(deps({ probe: vi.fn(async () => false) }))).toBe('timeout');
  });

  it('retries the session check while rpcd starts', async () => {
    const check = vi.fn().mockRejectedValueOnce(new TransportError('502')).mockResolvedValue({});
    expect(await rebootAndWait(deps({ check }))).toBe('back');
    expect(check).toHaveBeenCalledTimes(2);
  });
});
