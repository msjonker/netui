import { describe, expect, it, vi } from 'vitest';
import {
  buildHandoffUrl,
  completeHandoff,
  runApply,
  takeHandoff,
  takeRollbackNotice,
  type ApplyDeps,
  type ApplyPhase,
} from './apply';
import { onSessionExpired, SessionExpiredError, TransportError, UbusError, type Session } from './ubus';

const session: Session = { id: 'sid', username: 'netui', timeoutMs: 300_000, expiresAt: 0 };

/**
 * Fake deps on a virtual clock. `sleep` advances time instantly; each
 * dependency is a vi.fn so a test can script its answers per call.
 */
function harness(overrides: Partial<ApplyDeps> = {}) {
  let t = 1_000_000;
  const deps: ApplyDeps = {
    apply: vi.fn(async () => [0]),
    confirm: vi.fn(async () => [0]),
    revert: vi.fn(async () => {}),
    probe: vi.fn(async () => false),
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    now: () => t,
    navigate: vi.fn(),
    session: () => session,
    location: { protocol: 'http:', host: '192.168.1.1', hostname: '192.168.1.1', port: '', pathname: '/netui/' },
    ...overrides,
  };
  const phases: ApplyPhase['phase'][] = [];
  const run = (plan: Parameters<typeof runApply>[0]) =>
    runApply(plan, deps, (p) => phases.push(p.phase));
  return { deps, phases, run, start: t, advance: (ms: number) => (t += ms) };
}

const unreachable = () => new TransportError('Router unreachable');

describe('runApply', () => {
  it('applies with rollback and confirms on success', async () => {
    const h = harness();
    const result = await h.run({ packages: ['dhcp'] });

    expect(result).toEqual({ outcome: 'confirmed' });
    expect(h.deps.apply).toHaveBeenCalledWith(30);
    expect(h.deps.confirm).toHaveBeenCalledOnce();
    expect(h.deps.revert).not.toHaveBeenCalled();
    expect(h.phases).toEqual(['applying', 'waiting', 'confirming']);
  });

  it('keeps retrying confirm while the router is briefly unreachable', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(unreachable())
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValue([0]);
    const h = harness({ confirm });

    await expect(h.run({ packages: ['network'], disruptive: true })).resolves.toEqual({ outcome: 'confirmed' });
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('times out, lets the router roll back, then reverts the restored staged changes', async () => {
    const h = harness({ confirm: vi.fn().mockRejectedValue(unreachable()) });

    const result = await h.run({ packages: ['network', 'firewall'], disruptive: true });

    expect(result).toEqual({ outcome: 'rolledback' });
    // Never confirm at or after the router's deadline.
    expect(h.deps.now()).toBeGreaterThan(h.start + 30_000);
    expect(h.deps.revert).toHaveBeenCalledWith(['network', 'firewall']);
    expect(h.phases.at(-1)).toBe('reverting');
  });

  it('stops confirming as soon as the router reports nothing pending (already rolled back)', async () => {
    const h = harness({ confirm: vi.fn().mockRejectedValue(new UbusError(5, 'uci', 'confirm')) });

    await expect(h.run({ packages: ['wireless'] })).resolves.toEqual({ outcome: 'rolledback' });
    expect(h.deps.confirm).toHaveBeenCalledOnce();
    expect(h.deps.revert).toHaveBeenCalledWith(['wireless']);
  });

  it('retries the revert until the reverted router is reachable again', async () => {
    const revert = vi.fn().mockRejectedValueOnce(unreachable()).mockResolvedValue(undefined);
    const h = harness({ confirm: vi.fn().mockRejectedValue(unreachable()), revert });

    await h.run({ packages: ['network'] });
    expect(revert).toHaveBeenCalledTimes(2);
  });

  it('reports busy when another apply is pending, without changing anything', async () => {
    const h = harness({ apply: vi.fn().mockRejectedValue(new UbusError(6, 'uci', 'apply')) });

    await expect(h.run({ packages: ['dhcp'] })).resolves.toEqual({ outcome: 'busy' });
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(h.deps.revert).not.toHaveBeenCalled();
  });

  it('on session expiry mid-apply, routes to login with a rollback notice', async () => {
    const listener = vi.fn();
    const off = onSessionExpired(listener);
    const h = harness({ confirm: vi.fn().mockRejectedValue(new SessionExpiredError()) });

    const result = await h.run({ packages: ['dhcp'] });

    expect(result).toMatchObject({ outcome: 'expired', deadline: h.start + 30_000 });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatch(/reverts it automatically/);
    // Survives into the login page, then is consumed once.
    expect(takeRollbackNotice(h.start)).toMatch(/reverts it automatically/);
    expect(takeRollbackNotice(h.start)).toBeNull();
    off();
  });

  it('says the change was reverted when the notice is read after the deadline', async () => {
    const h = harness({ confirm: vi.fn().mockRejectedValue(new SessionExpiredError()) });
    const off = onSessionExpired(() => {});
    await h.run({ packages: ['dhcp'] });
    expect(takeRollbackNotice(h.start + 60_000)).toMatch(/router reverted it/);
    off();
  });

  it('hands the session over to the new address once it answers', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const h = harness({ probe });

    const result = await h.run({ packages: ['network'], newAddress: '192.168.2.1', returnTo: '/settings/networks' });

    expect(result.outcome).toBe('redirected');
    expect(probe).toHaveBeenCalledWith('192.168.2.1');
    expect(h.deps.confirm).not.toHaveBeenCalled();
    const url = vi.mocked(h.deps.navigate).mock.calls[0]![0];
    expect(url).toMatch(/^http:\/\/192\.168\.2\.1\/netui\/#\/settings\/networks\?netui-handoff=/);
  });

  it('when the new address never answers, reports the rollback and reverts at the old address', async () => {
    const h = harness();

    const result = await h.run({ packages: ['network'], newAddress: '192.168.2.1' });

    expect(result).toEqual({ outcome: 'rolledback', address: '192.168.2.1' });
    expect(h.deps.navigate).not.toHaveBeenCalled();
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(h.deps.revert).toHaveBeenCalledWith(['network']);
    expect(h.deps.now()).toBeGreaterThan(h.start + 30_000);
  });

  it('confirms in place when the "new" address is the one already in use', async () => {
    const h = harness();
    await expect(h.run({ packages: ['network'], newAddress: '192.168.1.1' })).resolves.toEqual({
      outcome: 'confirmed',
    });
  });
});

describe('handoff', () => {
  const loc = { protocol: 'http:', host: '192.168.1.1', hostname: '192.168.1.1', port: '', pathname: '/netui/' };

  function fakeWindow(url: string) {
    const u = new URL(url);
    const win = {
      location: { hash: u.hash, pathname: u.pathname, search: u.search },
      history: {
        replaceState: vi.fn((_s: unknown, _t: string, next: string) => {
          win.location.hash = next.slice(next.indexOf('#'));
        }),
      },
    };
    return win as unknown as Window & typeof win;
  }

  it('round-trips through the URL fragment and strips itself from the address bar', () => {
    const now = 1_000;
    const url = buildHandoffUrl(loc, '10.0.0.1', {
      session,
      from: '192.168.1.1',
      deadline: now + 20_000,
      packages: ['network'],
      returnTo: '/settings/networks',
    });
    const win = fakeWindow(url);

    const h = takeHandoff(win, now);

    expect(h).toMatchObject({ session: { id: 'sid' }, packages: ['network'] });
    expect(win.location.hash).toBe('#/settings/networks');
    expect(win.history.replaceState).toHaveBeenCalledOnce();
  });

  it('ignores an expired handoff but still strips it', () => {
    const url = buildHandoffUrl(loc, '10.0.0.1', { session, from: 'x', deadline: 500, packages: [], returnTo: '/' });
    const win = fakeWindow(url);
    expect(takeHandoff(win, 1_000)).toBeNull();
    expect(win.location.hash).toBe('#/');
  });

  it('ignores a garbled handoff', () => {
    const win = fakeWindow('http://10.0.0.1/netui/#/?netui-handoff=%%%');
    expect(takeHandoff(win, 0)).toBeNull();
  });

  it('confirms at the new address', async () => {
    let t = 0;
    const confirm = vi.fn().mockRejectedValueOnce(unreachable()).mockResolvedValue([0]);
    const result = await completeHandoff(
      { session, from: 'x', deadline: 30_000, packages: ['network'], returnTo: '/' },
      { confirm, sleep: async (ms) => void (t += ms), now: () => t },
    );
    expect(result).toEqual({ outcome: 'confirmed' });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('reports a rollback when confirm at the new address finds nothing pending', async () => {
    const result = await completeHandoff(
      { session, from: 'x', deadline: 30_000, packages: ['network'], returnTo: '/' },
      { confirm: vi.fn().mockRejectedValue(new UbusError(5, 'uci', 'confirm')), sleep: async () => {}, now: () => 0 },
    );
    expect(result).toEqual({ outcome: 'rolledback' });
  });
});
