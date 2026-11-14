import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import nlbwRecorded from '../fixtures/ubus/bench-v2/gateway.nlbw.json.mac-layer7.json';
import adblockBlocking from '../fixtures/ubus/bench-v2/netui.services.adblock.blocking.json';
import adblockApplying from '../fixtures/ubus/bench-v2/netui.services.adblock.applying.json';
import adblockStopped from '../fixtures/ubus/bench-v2/netui.services.adblock.stopped.json';
import ndsPreauth from '../fixtures/ubus/bench-v2/gateway.ndsctl.json.preauth.json';
import ndsAuthenticated from '../fixtures/ubus/bench-v2/gateway.ndsctl.json.authenticated.json';
import portalStopped from '../fixtures/ubus/bench-v2/netui.services.portal.stopped.json';

// `file exec` for the post-apply service hooks (api/services.ts) and nlbw
// (usage history). Records the call like any other; returns what rpcd does
// for a clean exit.

/** The recorded table, with the dev-container's "laptop" lease added as a client. */
export const nlbwTable = {
  ...nlbwRecorded,
  data: [...nlbwRecorded.data, ['TCP', 443, '02:4e:55:00:01:10', 40, 2_000_000_000, 1, 300_000_000, 1, 'HTTPS']],
};

/** Stored periods `nlbw -c list` prints, oldest first like the real one. */
export const NLBW_PERIODS = ['2026-09-01', '2026-10-01'];

function nlbw(params: string[]) {
  if (params[1] === 'list') return { code: 0, stdout: NLBW_PERIODS.join('\n') + '\n' };
  const t = params.indexOf('-t');
  // An earlier period: the same hosts at a tenth of the traffic.
  const table =
    t < 0
      ? nlbwTable
      : { ...nlbwTable, data: nlbwTable.data.map((r) => r.map((v, i) => (i === 4 || i === 6 ? Math.round(Number(v) / 10) : v))) };
  return { code: 0, stdout: JSON.stringify(table) };
}

/**
 * netui.services adblock: off until an apply turns it on; then one status
 * poll still downloading, after that blocking (the recorded states).
 */
const adblockPolls = new WeakMap<object, number>();

function adblock(method: string, router: FakeRouter) {
  if (!router.current('adblock-fast')) return { installed: false };
  const on = router.current('adblock-fast')!.config?.enabled === '1';
  if (method === 'adblock_apply') {
    adblockPolls.set(router, 0);
    return { result: true };
  }
  const polls = adblockPolls.get(router);
  if (polls === undefined) return structuredClone(on ? adblockBlocking : adblockStopped);
  adblockPolls.set(router, polls + 1);
  return structuredClone(polls === 0 ? adblockApplying : on ? adblockBlocking : adblockStopped);
}

/** What the plugin makes of `ndsctl json` (see netui-services). */
function fromNdsctl(list: { clients: Record<string, Record<string, string>> }) {
  const num = (v?: string) => (v == null || v === 'null' ? null : Number(v));
  return Object.entries(list.clients).map(([mac, c]) => ({
    mac,
    ip: c.ip,
    state: c.state!,
    session_start: num(c.session_start),
    session_end: num(c.session_end),
    last_active: num(c.last_active),
    download: num(c.download_this_session),
    upload: num(c.upload_this_session),
  }));
}

/** openNDS: runs once an apply turned it on; the recorded guest is at the portal until let in. */
const portalGuests = new WeakMap<object, 'preauth' | 'authenticated' | 'none'>();

function portal(method: string, args: Record<string, unknown>, router: FakeRouter) {
  if (!router.current('opennds')) return { installed: false };
  const on = Object.values(router.current('opennds')!)[0]?.enabled !== '0';
  if (method === 'portal_apply') {
    portalGuests.set(router, 'preauth');
    return { result: true };
  }
  if (method === 'portal_auth' || method === 'portal_deauth') {
    portalGuests.set(router, method === 'portal_auth' ? 'authenticated' : 'none');
    return args.mac ? { result: true } : { error: 'invalid MAC address' };
  }
  if (!on || !portalGuests.has(router)) return structuredClone(portalStopped);
  const g = portalGuests.get(router);
  return { installed: true, busy: false, running: true, clients: g === 'none' ? [] : fromNdsctl(g === 'authenticated' ? ndsAuthenticated : ndsPreauth) };
}

export const handle: FakeReadHandler = (object, method, args, router) => {
  if (object === 'netui.services') return method.startsWith('portal') ? portal(method, args, router) : adblock(method, router);
  if (object !== 'file' || method !== 'exec') return undefined;
  if (args.command === '/usr/sbin/nlbw') return nlbw((args.params as string[]) ?? []);
  return { code: 0 };
};
