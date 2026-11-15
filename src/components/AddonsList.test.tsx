import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../test/fakeRouter';
import { recorded, seedDevices } from '../../test/fakeReads/devices';
import { seedPackages } from '../../test/fakeReads/packages';
import { renderApp } from '../../test/renderApp';

vi.mock('../api/ubus', async (orig) => (await import('../../test/fakeRouter')).fakeUbusModule(await orig()));

const relayed = () =>
  router.calls
    .filter((c) => c.object === 'netui.devices' && c.method === 'call' && c.args.object === 'netui.packages')
    .map((c) => [c.args.method, (c.args.args as { addon?: string } | undefined)?.addon]);

beforeEach(() => resetRouter());

async function systemList(readOnly = false) {
  renderApp('#/settings/system', undefined, { readOnly });
  return screen.findByRole('list', { name: 'Add-ons' });
}

describe('Add-ons on the System page', () => {
  it('lists every add-on with its state', async () => {
    const list = await systemList();
    const wireguard = within(list).getByText('WireGuard VPN').closest('li')!;
    expect(wireguard.textContent).toMatch(/Installed/);
    expect(within(list).getByRole('button', { name: 'Install Ad blocking' })).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(16);
  });

  it('removes one, after saying its settings stay', async () => {
    seedPackages(router, '', { wol: true });
    const list = await systemList();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove Wake-on-LAN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Wake-on-LAN?' });
    expect(dialog.textContent).toMatch(/settings stay on the router/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('Wake-on-LAN is removed.', {}, { timeout: 8000 })).toBeTruthy();
    expect(await within(list).findByRole('button', { name: 'Install Wake-on-LAN' })).toBeTruthy();
  }, 12_000);

  it('never offers to remove the full WiFi package', async () => {
    seedPackages(router, '', { mesh: true });
    const list = await systemList();
    expect(within(list).getByText('Full WiFi package (mesh)').closest('li')!.textContent).toMatch(/Installed/);
    expect(within(list).queryByRole('button', { name: /Remove Full WiFi/ })).toBeNull();
  });

  it('shows a viewer the states without buttons', async () => {
    const list = await systemList(true);
    expect(within(list).getAllByRole('listitem')).toHaveLength(16);
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('Add-ons on an access point', () => {
  it('installs on the access point through the gateway', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp('#/devices');
    fireEvent.click(await screen.findByText('Office AP'));
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });
    const list = await within(drawer).findByRole('list', { name: 'Add-ons' });
    expect(within(list).getAllByRole('listitem').map((li) => li.firstElementChild!.firstElementChild!.textContent)).toEqual([
      'Full WiFi package (mesh)',
      'Client steering',
      'Firmware updates',
    ]);
    fireEvent.click(within(list).getByRole('button', { name: 'Install Client steering' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Client steering on Office AP?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(await within(dialog).findByText('Client steering is installed.', {}, { timeout: 8000 })).toBeTruthy();
    expect(relayed()).toContainEqual(['install', 'steering']);
    // The gateway's own packages are untouched.
    expect(router.calls.some((c) => c.object === 'netui.packages' && c.method === 'install')).toBe(false);
  }, 12_000);
});
