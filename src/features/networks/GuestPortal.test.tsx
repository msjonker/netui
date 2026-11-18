import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { pick, type } from '../../../test/dom';
import type { UciGet } from '../../api/types';
import recorded from '../../../test/fixtures/ubus/bench-v2/gateway.uci.get.opennds.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

async function card() {
  renderApp('#/settings/networks');
  return (await screen.findByRole('heading', { name: /^Guest portal/ })).closest('section') as HTMLElement;
}

describe('guest portal', () => {
  beforeEach(() => {
    resetRouter({ opennds: structuredClone((recorded as UciGet).values) });
    // The bench's test guest network: a bridge of its own at 192.168.3.1/24.
    router.configs.network!.guest = {
      '.anonymous': false,
      '.type': 'interface',
      '.name': 'guest',
      '.index': 50,
      proto: 'static',
      device: 'br-guest',
      ipaddr: ['192.168.3.1/24'],
    };
  });

  it('turns the portal on for the guest network, then lets a waiting guest in and signs them out', async () => {
    const c = await card();
    fireEvent.click(await within(c).findByRole('switch', { name: 'Show guests a sign-in page' }));
    expect((within(c).getByLabelText('Network') as HTMLSelectElement).value).toBe('guest');
    type(c, 'Portal name', 'Guest WiFi');
    pick(c, 'Session length', '240');
    type(c, 'Download limit (Mbit/s)', '25');
    fireEvent.click(within(c).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.opennds!.setup).toMatchObject({
      enabled: '1',
      gatewayinterface: 'br-guest',
      gatewayname: 'Guest WiFi',
      sessiontimeout: '240',
      downloadrate: '25000',
      uploadrate: '0',
    });
    expect(router.calls.some((x) => x.object === 'netui.services' && x.method === 'portal_apply')).toBe(true);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Done' })).getByRole('button', { name: 'OK' }));

    const guests = await screen.findByRole('table', { name: 'Guests' }, { timeout: 20_000 });
    expect(within(guests).getByText('At the portal')).toBeTruthy();
    fireEvent.click(within(guests).getByRole('button', { name: 'Let in' }));
    expect(await within(guests).findByText('Signed in')).toBeTruthy();
    expect(router.calls.find((x) => x.method === 'portal_auth')!.args).toEqual({ mac: '8c:de:f9:b6:f3:26' });
    fireEvent.click(within(guests).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('No guests yet.')).toBeTruthy();
  }, 30_000);

  it('warns against a portal on the LAN', async () => {
    const c = await card();
    fireEvent.click(await within(c).findByRole('switch', { name: 'Show guests a sign-in page' }));
    pick(c, 'Network', 'lan');
    expect(within(c).getByText(/Every device on the LAN/)).toBeTruthy();
  });
});

describe('without opennds', () => {
  it('offers the add-on', async () => {
    resetRouter();
    const c = await card();
    expect(c.textContent).toMatch(/sign-in page before they get internet/);
    expect(within(c).getByRole('heading').textContent).toMatch(/Not installed/);
    expect(within(c).getByRole('button', { name: 'Install' })).toBeTruthy();
  });
});
