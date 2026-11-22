import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/preact';
import { resetRouter, router } from '../../test/fakeRouter';
import { recorded, seedDevices } from '../../test/fakeReads/devices';
import { renderApp } from '../../test/renderApp';

vi.mock('../api/ubus', async (orig) => (await import('../../test/fakeRouter')).fakeUbusModule(await orig()));
// Charts draw once time passes; the test DOM has no canvas paths.
vi.mock('uplot', () => ({
  default: class {
    setData() {}
    setSize() {}
    destroy() {}
  },
}));

// The polling contract, for every main page: on a router that takes 8 s to
// answer anything, no call is sent again while the same call is still
// waiting (a slow router must not get a queue of the same request), and no
// call goes out more often than once per answer. rpcd runs one call at a time,
// so either would keep it busy for good.

const LATENCY_MS = 8_000;
const RUN_MS = 120_000;
// One request per answer, plus the first and one cut off at the end.
const MAX_PER_CALL = RUN_MS / LATENCY_MS + 2;

const PAGES = [
  '#/',
  '#/clients',
  '#/topology',
  '#/devices',
  '#/insights',
  '#/logs',
  '#/settings/wifi',
  '#/settings/networks',
  '#/settings/ports',
  '#/settings/internet',
  '#/settings/system',
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('polling a slow router', () => {
  it.each(PAGES)('%s never repeats a call before it is answered', async (page) => {
    vi.useFakeTimers();
    resetRouter();
    seedDevices(router, { managed: [recorded.device] });
    router.latencyMs = LATENCY_MS;
    const { client } = renderApp(page);
    await vi.advanceTimersByTimeAsync(RUN_MS);

    const overlapping = [...router.maxInFlight].filter(([, n]) => n > 1);
    expect(overlapping).toEqual([]);
    const flooding = [...router.sent].filter(([, n]) => n > MAX_PER_CALL);
    expect(flooding).toEqual([]);
    // The page did poll: this checks something.
    expect(Math.max(...router.sent.values())).toBeGreaterThan(2);
    client.clear();
  });
});
