import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed, review } from '../../../test/applyFlow';
import { wireless } from '../../../test/wireless';
import type { AssocStation } from '../../api/types';
import { UbusError, UbusStatus } from '../../api/ubus';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const UNNAMED = 'DA:A1:19:00:01:11';

async function openClient(match: string | RegExp) {
  renderApp('#/clients');
  fireEvent.click(await screen.findByText(match));
  return screen.findByRole('complementary');
}

beforeEach(() => {
  resetRouter();
});

describe('Client Devices', () => {
  it('lists leases and LAN host hints, merged by MAC', async () => {
    renderApp('#/clients');
    await screen.findByRole('heading', { name: 'Client Devices' });
    await screen.findByText('laptop');
    // Header, the two leases, and the dev host's bridge seen only in host hints.
    // The router's own MACs and the WAN-side host are left out.
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.textContent!.includes('10.231.1.2'))).toBe(false);
    expect(rows.some((r) => r.textContent!.includes('10.231.0.1'))).toBe(false);
  });

  it('re-enables the existing netui rule instead of adding a second one', async () => {
    const drawer = await openClient(UNNAMED.toLowerCase());
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await within(drawer).findByRole('button', { name: /Block/ }));

    expect((await review()).textContent).toMatch(/firewall/i);
    await applyReviewed();

    // The recording holds a disabled "netui: block phone" rule for this MAC.
    const rules = Object.values(router.configs.firewall!).filter((s) => s['.type'] === 'rule' && s.src_mac);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ '.name': 'cfg0f92bd', src_mac: [UNNAMED], target: 'REJECT' });
    expect(rules[0]!.enabled).toBeUndefined();
    expect(router.writes()).toEqual([
      { object: 'uci', method: 'delete', args: { config: 'firewall', section: 'cfg0f92bd', options: ['enabled'] } },
    ]);
  });

  it('blocks a device with a new firewall rule', async () => {
    const drawer = await openClient('laptop');
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await within(drawer).findByRole('button', { name: /Block/ }));
    await applyReviewed();

    const rule = Object.values(router.configs.firewall!).find(
      (s) => s['.type'] === 'rule' && String(s.src_mac).toUpperCase() === '02:4E:55:00:01:10',
    );
    expect(rule).toMatchObject({ src: '*', dest: '*', target: 'REJECT' });
    expect(rule!.enabled).toBeUndefined();
  });

  it('gives a device a fixed IP', async () => {
    const drawer = await openClient(UNNAMED.toLowerCase());
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await within(drawer).findByRole('switch', { name: 'Fixed IP address' }));
    const ip = within(drawer).getByLabelText('IP address') as HTMLInputElement;
    fireEvent.input(ip, { target: { value: '10.231.1.60' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();

    const hosts = Object.values(router.configs.dhcp!).filter((s) => s['.type'] === 'host');
    expect(hosts).toContainEqual(expect.objectContaining({ mac: [UNNAMED], ip: '10.231.1.60' }));
  });

  it('rejects an address already reserved for another device', async () => {
    const drawer = await openClient(UNNAMED.toLowerCase());
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await within(drawer).findByRole('switch', { name: 'Fixed IP address' }));
    fireEvent.input(within(drawer).getByLabelText('IP address'), { target: { value: '10.231.1.50' } });

    expect((await within(drawer).findByRole('alert')).textContent).toMatch(/reserved/i);
    expect((within(drawer).getByRole('button', { name: 'Apply Changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(router.writes()).toHaveLength(0);
  });

  it('discarding the review reverts the staged changes', async () => {
    const drawer = await openClient(UNNAMED.toLowerCase());
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await within(drawer).findByRole('button', { name: /Block/ }));
    fireEvent.click(within(await review()).getByRole('button', { name: 'Discard' }));

    await vi.waitFor(() => expect(router.calls.some((c) => c.method === 'revert')).toBe(true));
    expect(router.calls.some((c) => c.method === 'apply')).toBe(false);
    expect(router.current('firewall')).toEqual(router.configs.firewall);
  });
});

describe('Client Devices: deep links and WiFi actions', () => {
  // Shape as in iwinfo assoclist; see src/model/clients.test.ts.
  const phone: AssocStation = {
    mac: UNNAMED,
    signal: -58,
    noise: -105,
    inactive: 300,
    connected_time: 1800,
    rx: { rate: 433300, packets: 900, bytes: 120_000 },
    tx: { rate: 866700, packets: 1200, bytes: 4_500_000 },
  };

  function withStation() {
    resetRouter({ wireless: wireless() });
    router.overrides.push((c) => {
      if (c.object === 'iwinfo' && c.method === 'devices') return { devices: ['phy0-ap0'] };
      if (c.object === 'iwinfo' && c.method === 'assoclist') return { results: [phone] };
      if (c.object === 'hostapd.phy0-ap0' && c.method === 'del_client') return {};
      return undefined;
    });
  }

  it('opens the drawer for #/clients/<mac>', async () => {
    renderApp(`#/clients/${UNNAMED.toLowerCase()}`);
    const drawer = await screen.findByRole('complementary');
    expect(within(drawer).getByRole('heading', { name: 'netui-client-phone' })).toBeTruthy();
    expect(drawer.textContent).toMatch(/Private address/);
  });

  it('accepts other MAC notations in the link and says when a MAC is unknown', async () => {
    renderApp('#/clients/02-4E-55-00-01-10');
    expect(within(await screen.findByRole('complementary')).getByRole('heading', { name: 'laptop' })).toBeTruthy();
    location.hash = '#/clients/00:11:22:33:44:55';
    expect((await screen.findByRole('status')).textContent).toMatch(/No known client has the MAC address 00:11:22:33:44:55/);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('closing the drawer goes back to the list', async () => {
    renderApp(`#/clients/${UNNAMED.toLowerCase()}`);
    const drawer = await screen.findByRole('complementary');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(location.hash).toBe('#/clients'));
  });

  it('shows WiFi experience and reconnects a station after confirmation', async () => {
    withStation();
    renderApp(`#/clients/${UNNAMED.toLowerCase()}`);
    const drawer = await screen.findByRole('complementary');
    await vi.waitFor(() => expect(drawer.textContent).toMatch(/WiFi experience/));
    expect(drawer.textContent).toMatch(/-58 dBm/);

    fireEvent.click(within(drawer).getByRole('button', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog', { name: /Reconnect netui-client-phone/ });
    expect(router.calls.some((c) => c.method === 'del_client')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reconnect' }));

    await vi.waitFor(() =>
      expect(router.calls.filter((c) => c.method === 'del_client')).toEqual([
        {
          object: 'hostapd.phy0-ap0',
          method: 'del_client',
          args: { addr: UNNAMED.toLowerCase(), reason: 5, deauth: true, ban_time: 0 },
        },
      ]),
    );
    expect(await within(drawer).findByText(/should rejoin/)).toBeTruthy();
    expect(router.writes()).toHaveLength(0);
  });

  it('wakes a wired device on its network bridge, and offers etherwake when it is missing', async () => {
    const drawer = await openClient('laptop');
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Wake' }));
    await within(drawer).findByText(/Wake-up sent/);
    expect(router.calls.filter((c) => c.object === 'file')).toEqual([
      { object: 'file', method: 'exec', args: { command: '/usr/bin/etherwake', params: ['-i', 'br-lan', '02:4e:55:00:01:10'] } },
    ]);

    // Without the package rpcd answers NOT_FOUND (recorded on the DL-WRX36).
    router.overrides.push((c) => (c.object === 'file' ? new UbusError(UbusStatus.NOT_FOUND, 'file', 'exec') : undefined));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Wake' }));
    expect(await within(drawer).findByText(/Wake-on-LAN needs a small add-on/)).toBeTruthy();
    expect(router.writes()).toHaveLength(0);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('dialog', { name: 'Install Wake-on-LAN?' })).toBeTruthy();
  });

  it('filters offline clients', async () => {
    renderApp('#/clients');
    await screen.findByText('laptop');
    fireEvent.click(screen.getByRole('tab', { name: /Offline/ }));
    // Only the LAN host known from host hints alone.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/9a:3d:59:1b:de:92/);
  });
});

describe('speed limits', () => {
  const limits = () => Object.values(router.configs.firewall!).filter((s) => s['.type'] === 'netui_limit');

  it('limits a device, adding the firewall include once, and shows it', async () => {
    const drawer = await openClient('laptop');
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.input(await within(drawer).findByLabelText('Download (Mbit/s)'), { target: { value: '10' } });
    fireEvent.input(within(drawer).getByLabelText('Upload (Mbit/s)'), { target: { value: '2' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Limit' }));
    expect((await review()).textContent).toMatch(/netui_limit/);
    await applyReviewed();
    expect(limits()).toEqual([expect.objectContaining({ mac: '02:4E:55:00:01:10', name: 'laptop', download: '10', upload: '2' })]);
    expect(router.configs.firewall!.netui_limits).toMatchObject({ '.type': 'include', type: 'script', path: '/usr/share/netui/limits.sh' });

    // The list re-reads the firewall config after the apply.
    await waitFor(() => {
      const row = within(screen.getByRole('table')).getByText('laptop').closest('tr')!;
      expect(within(row).getByText('Limited')).toBeTruthy();
    });
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Overview' }));
    expect(await within(drawer).findByText('10 Mbit/s down, 2 Mbit/s up')).toBeTruthy();

    // Removing it deletes the section and keeps the include.
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Remove Limit' }));
    await applyReviewed();
    expect(limits()).toEqual([]);
    expect(router.configs.firewall!.netui_limits).toBeTruthy();
  });

  it('refuses a speed that is not a number', async () => {
    const drawer = await openClient('laptop');
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Settings' }));
    fireEvent.input(await within(drawer).findByLabelText('Download (Mbit/s)'), { target: { value: 'fast' } });
    expect(within(drawer).getByRole('alert').textContent).toMatch(/Mbit\/s/);
    expect((within(drawer).getByRole('button', { name: 'Apply Limit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
