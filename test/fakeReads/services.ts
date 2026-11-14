import type { FakeReadHandler } from '../fakeRouter';
import nlbwRecorded from '../fixtures/ubus/bench-v2/gateway.nlbw.json.mac-layer7.json';

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

export const handle: FakeReadHandler = (object, method, args) => {
  if (object !== 'file' || method !== 'exec') return undefined;
  if (args.command === '/usr/sbin/nlbw') return nlbw((args.params as string[]) ?? []);
  return { code: 0 };
};
