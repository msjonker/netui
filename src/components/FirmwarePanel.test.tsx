import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../test/fakeRouter';
import { recorded, seedDevices } from '../../test/fakeReads/devices';
import { seedFirmware } from '../../test/fakeReads/firmware';
import { renderApp } from '../../test/renderApp';
import { SessionExpiredError } from '../api/ubus';
import { firmwareTiming } from '../api/firmware';
import { rebootDeps } from '../features/system/reboot';
import type { FirmwareStatus } from '../api/types';
import failed from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.ap-upgrade-failed.json';
import checked from '../../test/fixtures/ubus/bench-v2/netui.firmware.status.checked.json';

vi.mock('../api/ubus', async (orig) => (await import('../../test/fakeRouter')).fakeUbusModule(await orig()));

const fwCalls = () => router.calls.filter((c) => c.object === 'netui.firmware').map((c) => c.method);
const relayed = () =>
  router.calls.filter((c) => c.object === 'netui.devices' && c.method === 'call' && c.args.object === 'netui.firmware').map((c) => c.args.method);

beforeEach(() => {
  resetRouter();
  vi.restoreAllMocks();
  vi.spyOn(firmwareTiming, 'sleep').mockResolvedValue(undefined);
  vi.spyOn(rebootDeps, 'sleep').mockResolvedValue(undefined);
  vi.spyOn(rebootDeps, 'probe').mockResolvedValueOnce(false).mockResolvedValue(true);
});

async function firmwareCard() {
  renderApp('#/settings/system');
  const card = (await screen.findByRole('heading', { name: 'Firmware' })).closest('section')!;
  await within(card).findByText('OpenWrt 25.12.6');
  return card as HTMLElement;
}

describe('router firmware', () => {
  it('checks for updates and offers the package updates owut found', async () => {
    const card = await firmwareCard();
    expect(within(card).getByText('Not checked for updates yet.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Check for updates' }));
    expect(await within(card).findByText('35 package updates available.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Update' })).toBeTruthy();
    expect(fwCalls()).toContain('check');
  });

  it('upgrades, waits through the restart and sends the user to sign in', async () => {
    seedFirmware(router, '', checked as FirmwareStatus);
    vi.spyOn(rebootDeps, 'check').mockRejectedValue(new SessionExpiredError());
    const card = await firmwareCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update to OpenWrt 25.12.6?' });
    expect(dialog.textContent).toMatch(/Settings and netui are kept/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('The firmware was updated and the router restarted. Sign in again to continue.')).toBeTruthy();
    expect(router.calls.find((c) => c.object === 'netui.firmware' && c.method === 'upgrade')?.args).toEqual({ version: '25.12.6' });
    // Not a config change.
    expect(router.writes()).toEqual([]);
  });

  it('reports a failed build; nothing was installed', async () => {
    seedFirmware(router, '', checked as FirmwareStatus);
    const card = await firmwareCard();
    seedFirmware(router, '', failed as FirmwareStatus);
    // The fake goes to installing on upgrade; make it fail instead.
    router.overrides.push((c) => (c.object === 'netui.firmware' && c.method === 'upgrade' ? { result: true } : undefined));
    fireEvent.click(await within(card).findByRole('button', { name: 'Update' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update' }));
    expect((await within(card).findByRole('alert')).textContent).toMatch(/nothing was installed: Your specified version-to '25.12.99' is not available/);
    expect(rebootDeps.probe).not.toHaveBeenCalled();
  });

  it('points to owut when it is not installed', async () => {
    seedFirmware(router, '', { available: false, installed: '25.12.6', job: null, branches: null });
    renderApp('#/settings/system');
    expect(await screen.findByText(/Install the/)).toBeTruthy();
  });
});

describe('access point firmware', () => {
  it('upgrades an access point through the gateway and waits for it to come back', async () => {
    seedDevices(router, { managed: [recorded.device] });
    seedFirmware(router, recorded.device.mac, checked as FirmwareStatus);
    renderApp('#/devices');
    fireEvent.click(await screen.findByText('Office AP'));
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update to OpenWrt 25.12.6?' });
    expect(dialog.textContent).toMatch(/WiFi clients move to another access point/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    expect(await within(drawer).findByText('Firmware updated. The access point is running OpenWrt 25.12.6.')).toBeTruthy();
    expect(relayed()).toEqual(expect.arrayContaining(['status', 'upgrade']));
    // The gateway's own firmware is untouched.
    expect(fwCalls()).not.toContain('upgrade');
    expect(rebootDeps.probe).not.toHaveBeenCalled();
  });
});
