// Render the whole signed-in app against the fake router. Test files must
// also mock api/ubus (vi.mock is per file):
//
//   vi.mock('../../api/ubus', async (orig) =>
//     (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

import { vi } from 'vitest';
import { render } from '@testing-library/preact';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../src/api/queries';
import { saveSession } from '../src/api/ubus';
import * as uci from '../src/api/uci';
import type { ApplyDeps } from '../src/api/apply';
import { App } from '../src/app/App';

export const session = { id: 'sid', username: 'netui', timeoutMs: 300_000, expiresAt: Date.now() + 3_600_000 };

/** browserDeps with a virtual clock: sleeps return at once and advance `now`. */
export function fastDeps(over: Partial<ApplyDeps> = {}) {
  let clock = 1_000_000;
  const deps: ApplyDeps = {
    apply: (t) => uci.applyWithRollback(t),
    confirm: () => uci.confirm(),
    revert: (p) => uci.revert(p, { deferExpiry: true }),
    probe: vi.fn(async () => true),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    navigate: vi.fn(),
    session: () => session,
    location: window.location,
    ...over,
  };
  return deps;
}

export function renderApp(hash = '#/', deps = fastDeps()) {
  location.hash = hash;
  saveSession(session);
  const client = createQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <App applyDeps={() => deps} />
    </QueryClientProvider>,
  );
  return { ...utils, client, deps };
}
