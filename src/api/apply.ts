// The apply/rollback flow, as a plain async function with its
// side effects injected so every outcome can be tested without a router.
//
// Observed rpcd behaviour this relies on (test/fixtures/ubus/dev-container/
// uci.apply-semantics.json):
//   - apply {rollback, timeout} returns 0 and starts the timer; a second apply
//     while one is pending returns 6.
//   - confirm returns 0 once, 5 when nothing is pending (i.e. it already
//     rolled back), 6 when the pending apply belongs to another session.
//   - after a rollback the session's staged changes come back, so we revert
//     the touched packages to leave a clean slate.
//   - an invalid session is -32002 (SessionExpiredError), never a bare 6.

import * as uci from './uci';
import { expireSession, getSession, SessionExpiredError, TransportError, UbusError, UbusStatus, type Session } from './ubus';

export interface ApplyPlan {
  /** Packages that were staged; reverted if the router rolls back. */
  packages: readonly string[];
  /**
   * The UI's address after the change, when it differs from the current one
   * (LAN IP edit). The flow probes it and hands the session over to it.
   */
  newAddress?: string;
  /** Network/firewall changes that may briefly drop the connection. */
  disruptive?: boolean;
  /** Route to open at the new address after a handoff. */
  returnTo?: string;
  /** Runs once the router confirmed the change, e.g. to close the drawer that made it. */
  onConfirmed?: () => void;
}

export type ApplyPhase =
  | { phase: 'applying' }
  | { phase: 'waiting'; deadline: number }
  | { phase: 'confirming'; deadline: number }
  | { phase: 'probing'; address: string; deadline: number }
  | { phase: 'reverting' };

export type ApplyResult =
  | { outcome: 'confirmed' }
  /** Nothing was staged. */
  | { outcome: 'nothing' }
  /** Handing over to the new address; this page is about to navigate away. */
  | { outcome: 'redirected'; url: string }
  /** The router reverted on its own. `address` is set when the new address never answered. */
  | { outcome: 'rolledback'; address?: string }
  /** Another session has an apply pending. Nothing changed. */
  | { outcome: 'busy' }
  /** The session expired while the change was pending; the router will revert. */
  | { outcome: 'expired'; deadline: number };

export interface ApplyDeps {
  apply(timeoutS: number): Promise<unknown>;
  confirm(): Promise<unknown>;
  revert(packages: readonly string[]): Promise<void>;
  /** Resolve true if a page at `address` answers. Must not throw. */
  probe(address: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  navigate(url: string): void;
  session(): Session | null;
  /** Current origin's host and URL pieces, for building the handoff URL. */
  location: Pick<Location, 'protocol' | 'host' | 'hostname' | 'port' | 'pathname'>;
}

export const HANDOFF_PARAM = 'netui-handoff';
const ROLLBACK_NOTICE_KEY = 'netui.rollback';

/** Holdoff before the first confirm: give netifd and the firewall time to settle. */
const HOLDOFF_DISRUPTIVE_MS = 4_000;
const HOLDOFF_MS = 1_000;
const RETRY_MS = 1_500;
/** Stop trying this long before the router's own deadline, so we never confirm into a rollback. */
const SAFETY_MS = 2_000;
/** After the deadline, how long to wait for the router to come back before reverting. */
const RECOVER_MS = 30_000;

export async function runApply(
  plan: ApplyPlan,
  deps: ApplyDeps,
  onPhase: (p: ApplyPhase) => void = () => {},
): Promise<ApplyResult> {
  onPhase({ phase: 'applying' });
  const started = deps.now();
  const deadline = started + uci.APPLY_TIMEOUT_S * 1000;

  try {
    await deps.apply(uci.APPLY_TIMEOUT_S);
  } catch (err) {
    if (err instanceof UbusError && err.status === UbusStatus.PERMISSION_DENIED) return { outcome: 'busy' };
    if (err instanceof UbusError && err.status === UbusStatus.NO_DATA) return { outcome: 'nothing' };
    if (err instanceof SessionExpiredError) {
      // Nothing was applied; this is an ordinary expiry.
      expireSession();
      throw err;
    }
    // A transport error is ambiguous: the request may have landed and taken
    // the network down with it. Carry on as if it applied; confirm will tell.
    if (!(err instanceof TransportError)) throw err;
  }

  onPhase({ phase: 'waiting', deadline });
  await deps.sleep(plan.disruptive || plan.newAddress ? HOLDOFF_DISRUPTIVE_MS : HOLDOFF_MS);

  const movesUi = plan.newAddress !== undefined && plan.newAddress !== deps.location.hostname;
  if (movesUi) return handOff(plan, plan.newAddress!, deadline, deps, onPhase);

  onPhase({ phase: 'confirming', deadline });
  while (deps.now() < deadline - SAFETY_MS) {
    try {
      await deps.confirm();
      return { outcome: 'confirmed' };
    } catch (err) {
      if (err instanceof SessionExpiredError) return expiredMidApply(deadline);
      // NO_DATA: nothing pending any more, so the router already rolled back.
      if (err instanceof UbusError && err.status === UbusStatus.NO_DATA) break;
      if (err instanceof UbusError && err.status === UbusStatus.PERMISSION_DENIED) break;
      if (!(err instanceof TransportError)) throw err;
    }
    await deps.sleep(RETRY_MS);
  }

  await recover(plan, deadline, deps, onPhase);
  return { outcome: 'rolledback' };
}

async function handOff(
  plan: ApplyPlan,
  address: string,
  deadline: number,
  deps: ApplyDeps,
  onPhase: (p: ApplyPhase) => void,
): Promise<ApplyResult> {
  onPhase({ phase: 'probing', address, deadline });
  const s = deps.session();
  // Leave enough time for the new page to load and confirm.
  while (s && deps.now() < deadline - SAFETY_MS * 3) {
    if (await deps.probe(address)) {
      const url = buildHandoffUrl(deps.location, address, {
        session: s,
        from: deps.location.host,
        deadline,
        packages: [...plan.packages],
        returnTo: plan.returnTo ?? '/',
      });
      deps.navigate(url);
      return { outcome: 'redirected', url };
    }
    await deps.sleep(RETRY_MS);
  }
  await recover(plan, deadline, deps, onPhase);
  return { outcome: 'rolledback', address };
}

/**
 * The router has reverted (or will by the deadline). Wait for the old address
 * to answer, then drop the staged changes that rollback restored.
 */
async function recover(
  plan: ApplyPlan,
  deadline: number,
  deps: ApplyDeps,
  onPhase: (p: ApplyPhase) => void,
): Promise<void> {
  onPhase({ phase: 'reverting' });
  const wait = deadline - deps.now();
  if (wait > 0) await deps.sleep(wait + 1_000);
  const giveUp = deps.now() + RECOVER_MS;
  for (;;) {
    try {
      await deps.revert(plan.packages);
      return;
    } catch (err) {
      if (err instanceof TransportError && deps.now() < giveUp) {
        await deps.sleep(RETRY_MS);
        continue;
      }
      if (err instanceof SessionExpiredError) {
        expireSession();
        return;
      }
      throw err;
    }
  }
}

function expiredMidApply(deadline: number): ApplyResult {
  sessionStorage.setItem(ROLLBACK_NOTICE_KEY, String(deadline));
  expireSession(rollbackNotice(deadline));
  return { outcome: 'expired', deadline };
}

export function rollbackNotice(deadline: number): string {
  const at = new Date(deadline).toLocaleTimeString();
  return `Your session ended before the change was confirmed. The router reverts it automatically at ${at}.`;
}

/** A pending rollback notice left by an expiry mid-apply, consumed once. */
export function takeRollbackNotice(now = Date.now()): string | null {
  const raw = sessionStorage.getItem(ROLLBACK_NOTICE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(ROLLBACK_NOTICE_KEY);
  const deadline = Number(raw);
  if (!Number.isFinite(deadline)) return null;
  return deadline > now
    ? rollbackNotice(deadline)
    : 'Your session ended before a change was confirmed, so the router reverted it.';
}

// ---------------------------------------------------------------------------
// Handoff between origins after a LAN address change.
//
// The session id travels in the URL fragment, which browsers never send to
// the server. The receiving page strips it with history.replaceState before
// rendering anything. It is still a bearer token in the address bar for a
// moment, which is one more reason to serve netui over HTTPS.

export interface Handoff {
  session: Session;
  /** The address we came from, to point the user back after a rollback. */
  from: string;
  deadline: number;
  packages: string[];
  returnTo: string;
}

export function buildHandoffUrl(loc: ApplyDeps['location'], address: string, h: Handoff): string {
  const port = loc.port ? `:${loc.port}` : '';
  const host = address.includes(':') ? `[${address}]` : address;
  const payload = encodeURIComponent(btoa(JSON.stringify(h)));
  return `${loc.protocol}//${host}${port}${loc.pathname}#${h.returnTo}?${HANDOFF_PARAM}=${payload}`;
}

/**
 * Read and remove a handoff from the current URL. Returns null when there is
 * none or it is malformed or past its deadline.
 */
export function takeHandoff(win: Pick<Window, 'location' | 'history'> = window, now = Date.now()): Handoff | null {
  const hash = win.location.hash;
  const at = hash.indexOf(`${HANDOFF_PARAM}=`);
  if (at < 0) return null;
  const route = hash.slice(1, hash.lastIndexOf('?', at)) || '/';
  win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}#${route}`);
  try {
    const h = JSON.parse(atob(decodeURIComponent(hash.slice(at + HANDOFF_PARAM.length + 1)))) as Handoff;
    if (typeof h.session?.id !== 'string' || typeof h.deadline !== 'number' || !Array.isArray(h.packages)) {
      return null;
    }
    if (h.deadline <= now) return null;
    return h;
  } catch {
    return null;
  }
}

/**
 * Finish an apply on the new address: confirm with the handed-over session
 * until the deadline. Runs before the app renders.
 */
export async function completeHandoff(
  h: Handoff,
  deps: Pick<ApplyDeps, 'confirm' | 'sleep' | 'now'>,
): Promise<ApplyResult> {
  while (deps.now() < h.deadline - SAFETY_MS) {
    try {
      await deps.confirm();
      return { outcome: 'confirmed' };
    } catch (err) {
      if (err instanceof SessionExpiredError) return expiredMidApply(h.deadline);
      if (err instanceof UbusError) return { outcome: 'rolledback' };
      if (!(err instanceof TransportError)) throw err;
    }
    await deps.sleep(RETRY_MS);
  }
  return { outcome: 'rolledback' };
}

// ---------------------------------------------------------------------------
// Real dependencies

export async function probeAddress(address: string, loc: Location = window.location): Promise<boolean> {
  const port = loc.port ? `:${loc.port}` : '';
  const host = address.includes(':') ? `[${address}]` : address;
  try {
    // An opaque no-cors response is enough: it proves something at that
    // address served our page path. No CORS on the router is needed.
    await fetch(`${loc.protocol}//${host}${port}${loc.pathname}`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    return true;
  } catch {
    return false;
  }
}

export function browserDeps(): ApplyDeps {
  return {
    apply: (t) => uci.applyWithRollback(t),
    confirm: () => uci.confirm(),
    revert: (p) => uci.revert(p, { deferExpiry: true }),
    probe: (a) => probeAddress(a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    navigate: (url) => window.location.assign(url),
    session: getSession,
    location: window.location,
  };
}
