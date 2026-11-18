import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { seedSpeedTest } from '../../../test/fakeReads/speedtest';
import { renderApp } from '../../../test/renderApp';
import type { SpeedTestStatus } from '../../api/types';
import done from '../../../test/fixtures/ubus/bench-v2/netui.speedtest.status.done.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  resetRouter();
});

async function card() {
  renderApp('#/settings/internet');
  return (await screen.findByRole('heading', { name: /^Speed test/ })).closest('section') as HTMLElement;
}

describe('speed test', () => {
  it('runs a test on the router and shows the result', async () => {
    const c = await card();
    expect(within(c).getByText(/No speed test yet/)).toBeTruthy();
    fireEvent.click(within(c).getByRole('button', { name: 'Run speed test' }));
    expect(await within(c).findByText(/takes about 30 seconds/)).toBeTruthy();
    expect(await within(c).findByText('913 Mbps', {}, { timeout: 8_000 })).toBeTruthy();
    expect(within(c).getByText('40 Mbps')).toBeTruthy();
    expect(within(c).getByText('15 ms')).toBeTruthy();
    expect(within(c).getByText(/Example City \(LibreSpeed\)/)).toBeTruthy();
    expect(router.calls.filter((x) => x.object === 'netui.speedtest' && x.method === 'start')).toHaveLength(1);
  }, 12_000);

  it('lists earlier results and shows the last one on the dashboard', async () => {
    const r = (done as SpeedTestStatus).history[0]!;
    seedSpeedTest(router, { ...(done as SpeedTestStatus), history: [r, { ...r, at: r.at - 86400, download: 500e6 }] });
    const c = await card();
    expect(within(await within(c).findByRole('table', { name: 'Earlier speed tests' })).getByText('500 Mbps')).toBeTruthy();
  });

  it('says what to install when no speed test tool is there', async () => {
    seedSpeedTest(router, { available: false, tool: null, running: false, started: null, error: null, history: [] });
    const c = await card();
    expect(c.textContent).toMatch(/Test the internet speed from the router/);
    expect(within(c).getByRole('heading').textContent).toMatch(/Not installed/);
    expect(within(c).getByRole('button', { name: 'Install' })).toBeTruthy();
  });

  it('shows why the last run failed', async () => {
    seedSpeedTest(router, { ...(done as SpeedTestStatus), error: 'The speed test did not finish within 2 minutes.' });
    const c = await card();
    expect((await within(c).findByRole('alert')).textContent).toMatch(/did not finish within 2 minutes/);
  });
});

describe('dashboard', () => {
  it('shows the last speed test under the internet chart', async () => {
    seedSpeedTest(router, done as SpeedTestStatus);
    renderApp('#/');
    expect((await screen.findByText(/^Speed test /)).textContent).toMatch(/913 Mbps down, 40 Mbps up, 15 ms/);
  });
});
