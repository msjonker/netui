import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { fireEvent as dispatch } from '@testing-library/dom';
import { act } from 'preact/test-utils';
import type { UciGet } from '../../api/types';
import { SessionExpiredError, UbusError, UbusStatus } from '../../api/ubus';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { type } from '../../../test/dom';
import { applyReviewed } from '../../../test/applyFlow';
import uciSystem from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.system.json';
import { rebootDeps } from './reboot';
import { seedNoRootPassword } from '../../../test/fakeReads/users';
import fwRecorded from '../../../test/fixtures/ubus/dl-wrx36/plain/system.validate_firmware_image.json';
import unixtime from '../../../test/fixtures/ubus/bench-v2/gateway.luci.getUnixtime.json';

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

  it('reads the clock with getUnixtime on luci-base 26.x, without the old method', async () => {
    router.overrides.push((c) => (c.object === 'luci' && c.method === 'getUnixtime' ? structuredClone(unixtime) : undefined));
    renderApp('#/settings/system');
    expect(await screen.findByText(/Nov 14, 2026/)).toBeTruthy();
    expect(router.calls.some((c) => c.method === 'getLocaltime')).toBe(false);
  });

  it('shows hardware and firmware', async () => {
    renderApp('#/settings/system');
    expect(await screen.findByText('Kernel')).toBeTruthy();
    // Backup and a manual upgrade are netui's own now, not a LuCI link.
    expect(screen.queryByRole('link', { name: /manual upgrade/ })).toBeNull();
  });
});

describe('firmware file', () => {
  const image = new File([new Uint8Array(1024)], 'openwrt-25.12.6-qualcommax-ipq807x-dynalink_dl-wrx36-squashfs-sysupgrade.bin');

  async function upload(answer: unknown) {
    router.overrides.push((c) => (c.object === 'system' && c.method === 'validate_firmware_image' ? answer : undefined));
    renderApp('#/settings/system');
    fireEvent.click(await screen.findByRole('button', { name: 'Install it by hand' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install a firmware file' });
    const input = within(dialog).getByLabelText('Firmware file');
    Object.defineProperty(input, 'files', { value: [image], configurable: true });
    await act(async () => {
      dispatch.change(input);
    });
    return dialog;
  }

  it('uploads, checks and flashes an image for this model, keeping settings', async () => {
    vi.spyOn(rebootDeps, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(rebootDeps, 'probe').mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(rebootDeps, 'check').mockRejectedValue(new SessionExpiredError());
    // rpcd gives up waiting for sysupgrade (recorded: status 7).
    router.overrides.push((c) => (c.object === 'file' ? new UbusError(UbusStatus.TIMEOUT, 'file', 'exec') : undefined));
    const dialog = await upload(fwRecorded.valid);
    await within(dialog).findByText(/made for this model/);
    expect(router.uploads.get('/tmp/firmware.bin')).toBe(image);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install and Restart' }));
    expect(await screen.findByText('The firmware was installed and the router restarted. Sign in again to continue.')).toBeTruthy();
    expect(router.calls.filter((c) => c.object === 'file')).toEqual([
      { object: 'file', method: 'exec', args: { command: '/sbin/sysupgrade', params: ['/tmp/firmware.bin'] } },
    ]);
    expect(router.writes()).toHaveLength(0);
  });

  it('will not install an image for another model', async () => {
    const dialog = await upload(fwRecorded.truncated);
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/different model/);
    expect((within(dialog).getByRole('button', { name: 'Install and Restart' }) as HTMLButtonElement).disabled).toBe(true);
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

describe('router password', () => {
  it('says root has none and sets one', async () => {
    seedNoRootPassword(router);
    renderApp('#/settings/system');
    const card = (await screen.findByRole('heading', { name: 'Router password' })).closest('section')!;
    expect((await within(card).findByText(/Not set/)).textContent).toMatch(/ssh/);
    fireEvent.click(within(card).getByRole('button', { name: 'Set Password' }));
    const dialog = await screen.findByRole('dialog', { name: 'Router password' });
    type(dialog, 'New password', 'router pass 1');
    type(dialog, 'Again', 'router pass 2');
    expect(within(dialog).getByText('The passwords do not match.')).toBeTruthy();
    type(dialog, 'Again', 'router pass 1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText(/^Set\./)).toBeTruthy();
    expect(router.calls.filter((c) => c.method === 'root_password')).toHaveLength(1);
  });
});
