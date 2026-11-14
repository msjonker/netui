import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { recorded, seedDevices } from '../../../test/fakeReads/devices';
import { renderApp } from '../../../test/renderApp';
import { runServiceHooks } from '../../api/services';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const calls = (method: string) =>
  router.calls.filter((c) => c.object === 'netui.devices' && c.method === method).map((c) => c.args);

beforeEach(() => {
  resetRouter();
});

describe('Devices', () => {
  it('lists the gateway and an adopted access point with its radios', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp('#/devices');
    const table = await screen.findByRole('table', { name: 'Devices' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('Gateway');
    const row = (await within(table).findByText('Office AP')).closest('tr')!;
    expect(row.textContent).toContain('Xiaomi AX3600');
    expect(row.textContent).toContain('192.168.1.166');
    expect(row.textContent).toContain('25.12.6');
    await waitFor(() => expect(row.textContent).toMatch(/\d+m \d+s|\d+h \d+m/));

    fireEvent.click(row);
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });
    const radios = await within(drawer).findByRole('table', { name: 'Radios' });
    expect(within(radios).getAllByText('netui-test')).toHaveLength(2);
    expect(radios.textContent).toContain('5 GHz');
    expect(radios.textContent).toContain('2.4 GHz');
  });

  it('adopts a pending access point and copies the WiFi once it is back online', async () => {
    seedDevices(router, { pending: [recorded.pending] });
    renderApp('#/devices');
    const pending = await screen.findByRole('table', { name: 'Ready to adopt' });
    fireEvent.click(within(pending).getByRole('button', { name: 'Adopt' }));

    const dialog = await screen.findByRole('dialog', { name: 'Adopt Xiaomi AX3600' });
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Xiaomi AX3600 AP');
    fireEvent.input(name, { target: { value: 'Office AP' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt' }));

    await waitFor(() => expect(calls('adopt')).toEqual([{ ip: '192.168.1.2', password: '', name: 'Office AP' }]));
    await waitFor(() => expect(calls('sync')).toEqual([{ mac: recorded.pending.mac }]));
    expect(await screen.findByText(/Office AP is online and broadcasting/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Ready to adopt' })).toBeNull();
  });

  it('says so when the root password is wrong', async () => {
    seedDevices(router, { pending: [recorded.pending] });
    renderApp('#/devices');
    fireEvent.click(within(await screen.findByRole('table', { name: 'Ready to adopt' })).getByRole('button', { name: 'Adopt' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.input(within(dialog).getByLabelText('Current root password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt' }));
    expect(await within(dialog).findByText('Wrong root password for that device.')).toBeTruthy();
  });

  it('copies WiFi, shows the SSH password and forgets a device from its drawer', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp(`#/devices/${recorded.device.mac}`);
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });

    fireEvent.click(within(drawer).getByRole('button', { name: /Copy WiFi/ }));
    expect(await within(drawer).findByText(/Copied 2 WiFi networks/)).toBeTruthy();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Show SSH password' }));
    expect(await within(drawer).findByText('root / ap-root-secret')).toBeTruthy();

    fireEvent.click(within(drawer).getByRole('button', { name: /Forget/ }));
    const forget = await screen.findByRole('dialog', { name: 'Forget Office AP?' });
    expect(await within(forget).findByText('ap-root-secret')).toBeTruthy();
    fireEvent.click(within(forget).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(calls('forget')).toEqual([{ mac: recorded.device.mac }]);
    expect(screen.queryByText('Office AP')).toBeNull();
  });

  it('copies every WiFi change to the access points after an apply', async () => {
    seedDevices(router, { managed: [recorded.device] });
    expect(await runServiceHooks(['wireless'])).toEqual([]);
    expect(calls('sync')).toEqual([{}]);
    // Other packages leave the access points alone.
    await runServiceHooks(['firewall']);
    expect(calls('sync')).toHaveLength(1);
  });
});

describe('adopted access points elsewhere', () => {
  it('shows them in Topology and keeps them out of the client list', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp('#/topology');
    const node = await screen.findByRole('link', { name: 'Office AP details' });
    expect(node.getAttribute('href')).toContain(`/devices/${recorded.device.mac}`);
    expect(await within(node.closest('div.rounded-lg')!).findByText('netui-test')).toBeTruthy();
  });
});

describe('an adopted access point is infrastructure, not a client', () => {
  it('drops its DHCP lease from Client Devices', async () => {
    renderApp('#/clients');
    expect(await screen.findByText('laptop')).toBeTruthy();
  });

  it('once adopted', async () => {
    // Pretend the dev container's "laptop" lease belongs to an adopted AP.
    seedDevices(router, { managed: [{ ...recorded.device, mac: '02:4e:55:00:01:10', name: 'Hall AP' }] });
    renderApp('#/clients');
    await screen.findByRole('table');
    await waitFor(() => expect(screen.queryByText('laptop')).toBeNull());
  });
});
