import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { pick, type } from '../../../test/dom';
import { applyReviewed } from '../../../test/applyFlow';
import { seedNoRootPassword } from '../../../test/fakeReads/users';
import fresh from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.fresh.json';
import uciSystem from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.system.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  localStorage.clear();
  const r = resetRouter({ wireless: structuredClone(fresh.values), system: structuredClone(uciSystem.values) });
  seedNoRootPassword(r);
});

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

describe('first-run setup', () => {
  it('is offered on the dashboard of a fresh router', async () => {
    renderApp('#/');
    expect((await screen.findByText(/not set up yet/)).textContent).toMatch(/WiFi is off/);
    expect(screen.getByRole('link', { name: 'Set Up' }).getAttribute('href')).toBe('#/setup');
  });

  it('turns WiFi on, sets the time zone and the router password in one apply', async () => {
    renderApp('#/setup');
    const main = document.body;
    await screen.findByLabelText('WiFi name');
    type(main, 'WiFi name', 'Home');
    type(main, 'WiFi password', 'correct horse');
    await waitFor(() =>
      expect(within(main).getByLabelText('Country').querySelectorAll('option').length).toBeGreaterThan(5),
    );
    pick(main, 'Country', 'NL');
    next();
    await screen.findByLabelText('Connection type');
    next();
    pick(main, 'Time zone', 'Europe/Amsterdam');
    next();
    type(main, 'Router password', 'router pass 1');
    type(main, 'Again', 'router pass 1');
    next();
    expect(main.textContent).toMatch(/Home \(WPA2\/WPA3\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await applyReviewed();

    const w = router.configs.wireless!;
    expect(w.radio0).toMatchObject({ country: 'NL' });
    expect(w.default_radio1).toMatchObject({ ssid: 'Home', encryption: 'sae-mixed', key: 'correct horse' });
    expect(w.default_radio0!.disabled).toBeUndefined();
    expect(Object.values(router.configs.system!).find((s) => s['.type'] === 'system')).toMatchObject({
      zonename: 'Europe/Amsterdam',
    });
    await waitFor(() =>
      expect(router.calls.filter((c) => c.method === 'root_password')).toEqual([
        { object: 'netui.users', method: 'root_password', args: { password: 'router pass 1' } },
      ]),
    );
    expect(await screen.findByText(/Your WiFi “Home” is ready/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Join Home' })).toBeTruthy();
  });
});
