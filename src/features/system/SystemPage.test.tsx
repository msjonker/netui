import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import type { UciGet } from '../../api/types';
import { SessionExpiredError } from '../../api/ubus';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { type } from '../../../test/dom';
import { applyReviewed } from '../../../test/applyFlow';
import uciSystem from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.system.json';
import { rebootDeps } from './reboot';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const recorded: UciGet = uciSystem;

beforeEach(() => {
  resetRouter({ system: structuredClone(recorded.values) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('System', () => {
  it('renames the router and sets the timezone with its TZ string', async () => {
    renderApp('#/settings/system');
    const name = (await screen.findByLabelText('Device name')) as HTMLInputElement;
    expect(name.value).toBe('OpenWrt');
    type(document.body, 'Device name', 'gateway');
    type(document.body, 'Timezone', 'Europe/Amsterdam');
    fireEvent.click(screen.getByRole('switch', { name: 'Act as NTP server for clients' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.system!.cfg01e48a).toMatchObject({
      hostname: 'gateway',
      zonename: 'Europe/Amsterdam',
      timezone: 'CET-1CEST,M3.5.0,M10.5.0/3',
    });
    expect(router.configs.system!.ntp!.enable_server).toBe('1');
  });

  it('rejects a timezone that is not in the list', async () => {
    renderApp('#/settings/system');
    await screen.findByLabelText('Device name');
    type(document.body, 'Timezone', 'Mars/Olympus');
    expect(await screen.findByText('Pick a timezone from the list.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply Changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns that the router clock is off', async () => {
    renderApp('#/settings/system');
    // The recording is from October 2025; the test clock is later.
    expect((await screen.findByText(/router's clock is .* behind this browser/)).textContent).toMatch(/NTP/);
  });

  it('shows hardware and firmware', async () => {
    renderApp('#/settings/system');
    expect(await screen.findByText('Kernel')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Backup & firmware upgrade/ }).getAttribute('href')).toBe('/cgi-bin/luci/admin/system/flash');
  });
});

describe('restart', () => {
  beforeEach(() => {
    vi.spyOn(rebootDeps, 'sleep').mockResolvedValue(undefined);
    // Down once, then back.
    vi.spyOn(rebootDeps, 'probe').mockResolvedValueOnce(false).mockResolvedValue(true);
  });

  async function restart() {
    renderApp('#/settings/system');
    fireEvent.click(await screen.findByRole('button', { name: /Restart/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart the router?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));
  }

  it('reboots, waits for the router and sends the user to sign in again', async () => {
    vi.spyOn(rebootDeps, 'check').mockRejectedValue(new SessionExpiredError());
    await restart();
    expect(await screen.findByText('The router restarted. Sign in again to continue.')).toBeTruthy();
    expect(router.calls.some((c) => c.object === 'system' && c.method === 'reboot')).toBe(true);
    expect(rebootDeps.probe).toHaveBeenCalledTimes(2);
  });

  it('carries on when the session survived', async () => {
    await restart();
    expect(await screen.findByText('The router restarted and is back online.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not touch the config', async () => {
    vi.spyOn(rebootDeps, 'check').mockRejectedValue(new SessionExpiredError());
    await restart();
    await screen.findByText(/Sign in again/);
    expect(router.writes()).toEqual([]);
    expect(router.calls.some((c) => c.method === 'apply')).toBe(false);
  });
});
