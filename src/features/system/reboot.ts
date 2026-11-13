import { call, ENDPOINT, NULL_SESSION, SessionExpiredError, TransportError } from '../../api/ubus';

// Restart the router and wait for it to come back. Not a config change, so
// it bypasses the apply flow. rpcd keeps sessions in memory: after a restart
// the old session is gone and the user has to sign in again.

export interface RebootDeps {
  reboot(): Promise<unknown>;
  /** True when uhttpd answers at all. Must not throw. */
  probe(): Promise<boolean>;
  /** A cheap authenticated read, to see if the session survived. */
  check(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type RebootPhase = 'stopping' | 'starting' | 'checking';
export type RebootResult = 'back' | 'signed-out' | 'timeout';

const POLL_MS = 2_000;
/** If the router never seems to go down, carry on after this. */
const DOWN_WAIT_MS = 60_000;
const UP_WAIT_MS = 5 * 60_000;

export const rebootDeps: RebootDeps = {
  reboot: () => call('system', 'reboot', {}, { timeoutMs: 5_000, deferExpiry: true }),
  async probe() {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'call', params: [NULL_SESSION, 'session', 'access', {}] }),
        cache: 'no-store',
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  check: () => call('system', 'board', {}, { deferExpiry: true }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function rebootAndWait(deps: RebootDeps, onPhase: (p: RebootPhase) => void = () => {}): Promise<RebootResult> {
  onPhase('stopping');
  try {
    await deps.reboot();
  } catch (err) {
    // The connection may drop as the router goes down; anything else is real.
    if (!(err instanceof TransportError)) throw err;
  }
  const start = deps.now();
  while (deps.now() - start < DOWN_WAIT_MS) {
    await deps.sleep(POLL_MS);
    if (!(await deps.probe())) break;
  }
  onPhase('starting');
  while (!(await deps.probe())) {
    if (deps.now() - start > UP_WAIT_MS) return 'timeout';
    await deps.sleep(POLL_MS);
  }
  onPhase('checking');
  // uhttpd may answer before rpcd is ready.
  for (let i = 0; ; i++) {
    try {
      await deps.check();
      return 'back';
    } catch (err) {
      if (err instanceof SessionExpiredError) return 'signed-out';
      if (i >= 15) return 'timeout';
      await deps.sleep(POLL_MS);
    }
  }
}
