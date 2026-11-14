import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { recorded, seedDevices } from '../../../test/fakeReads/devices';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { wrxFixtures } from '../../../test/fixtures';
import { runServiceHooks } from '../../api/services';
import type { AssocStation } from '../../api/types';

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

describe('wireless mesh', () => {
  it('shows the uplink and the backhaul radio of a meshed access point', async () => {
    seedDevices(router, { managed: [recorded.device], mesh: true });
    renderApp('#/devices');
    const row = (await within(await screen.findByRole('table', { name: 'Devices' })).findByText('Office AP')).closest('tr')!;
    await waitFor(() => expect(row.textContent).toContain('Wired (lan1), mesh on standby'));
    fireEvent.click(row);
    const radios = await within(await screen.findByRole('complementary', { name: 'Office AP' })).findByRole('table', { name: 'Radios' });
    await waitFor(() => expect(radios.textContent).toContain('Mesh backhaul'));
    // The mesh peer is the gateway, not a WiFi client.
    expect(within(radios).getAllByRole('row').map((r) => r.textContent)).toContainEqual(expect.stringMatching(/Mesh backhaul.*—$/));
  });

  it('turns meshing on from the WiFi page: 802.11s on 5 GHz and spanning tree, in one review', async () => {
    resetRouter({ wireless: wrxFixtures('plain').uci.wireless() });
    renderApp('#/settings/wifi');
    const card = (await screen.findByText('Wireless mesh')).closest('section, div.rounded-lg') as HTMLElement;
    fireEvent.click(within(card).getByRole('switch', { name: 'Wireless meshing' }));
    await applyReviewed();
    expect(router.configs.wireless!.netui_mesh).toMatchObject({ mode: 'mesh', device: 'radio0', encryption: 'sae', network: 'lan' });
    const bridge = Object.values(router.configs.network!).find((x) => x.name === 'br-lan');
    expect(bridge).toMatchObject({ stp: '1', forward_delay: '4' });
  });
});

describe('copying WiFi after a bridge change', () => {
  it('retries while spanning tree settles, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      seedDevices(router, { managed: [recorded.device] });
      let tries = 0;
      router.overrides.push((c) =>
        c.object === 'netui.devices' && c.method === 'sync' && ++tries === 1
          ? { devices: { [recorded.device.mac]: { error: 'unreachable' } } }
          : undefined,
      );
      const done = runServiceHooks(['wireless', 'network']);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await done).toEqual([]);
      expect(tries).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after half a minute and reports the access points', async () => {
    vi.useFakeTimers();
    try {
      seedDevices(router, { managed: [recorded.device] });
      router.overrides.push((c) =>
        c.object === 'netui.devices' && c.method === 'sync' ? { devices: { [recorded.device.mac]: { error: 'unreachable' } } } : undefined,
      );
      const done = runServiceHooks(['wireless', 'network']);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await done).toEqual(['access points']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clients on access points', () => {
  // The dev container's "laptop" lease, associated to the AP's 5 GHz WiFi.
  // Station shape as in iwinfo assoclist (see src/model/clients.test.ts).
  const laptop: AssocStation = {
    mac: '02:4E:55:00:01:10',
    signal: -61,
    noise: -105,
    inactive: 200,
    connected_time: 900,
    rx: { rate: 288200, packets: 900, bytes: 120_000 },
    tx: { rate: 576500, packets: 1200, bytes: 4_500_000 },
  };

  it('names the access point a client is on and reconnects it through that device', async () => {
    seedDevices(router, { managed: [recorded.device], stations: [laptop] });
    renderApp('#/clients');
    const row = (await screen.findByText('laptop')).closest('tr')!;
    await waitFor(() => expect(row.textContent).toContain('netui-test · 5 GHz · Ch 36 · Office AP'));

    renderApp('#/clients/02:4e:55:00:01:10');
    const drawer = await screen.findAllByRole('complementary').then((d) => d.at(-1)!);
    expect(await within(drawer).findByText('Office AP')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: /Reconnect/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Reconnect/ }));
    await waitFor(() =>
      expect(calls('call')).toContainEqual({
        mac: recorded.device.mac,
        object: 'hostapd.phy1-ap0',
        method: 'del_client',
        args: { addr: '02:4e:55:00:01:10', reason: 5, deauth: true, ban_time: 0 },
      }),
    );
  });

  it('lists the client under its access point in Topology and in the device drawer', async () => {
    seedDevices(router, { managed: [recorded.device], stations: [laptop] });
    renderApp(`#/devices/${recorded.device.mac}`);
    const list = await screen.findByRole('list', { name: 'Clients on this access point' });
    expect(within(list).getByText('laptop')).toBeTruthy();

    renderApp('#/topology');
    const ap = (await screen.findByRole('link', { name: 'Office AP details' })).closest('div.flex-col') as HTMLElement;
    expect(await within(ap).findByRole('link', { name: /laptop/ })).toBeTruthy();
  });
});
