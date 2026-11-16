import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { wireless } from '../../../test/wireless';
import { compactRate } from './DashboardPage';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  localStorage.clear();
  resetRouter({ wireless: wireless() });
});

describe('compactRate', () => {
  it('fits a bit rate in a port tile', () => {
    expect(compactRate(null)).toBe('—');
    expect(compactRate(10)).toBe('0');
    expect(compactRate(105_000)).toBe('840K');
    expect(compactRate(1_500_000)).toBe('12M');
    expect(compactRate(150_000)).toBe('1.2M');
    expect(compactRate(125_000_000)).toBe('1G');
  });
});

describe('Dashboard', () => {
  it('shows gateway health, ports, radios and recent events', async () => {
    renderApp('#/');
    const health = await screen.findByLabelText('Gateway health');
    expect(within(health).getByText('CPU load')).toBeTruthy();
    expect(within(health).getByText(/^OpenWrt /)).toBeTruthy();

    const radios = await screen.findByRole('list', { name: 'Radios' });
    expect(within(radios).getByText('2.4 GHz')).toBeTruthy();
    expect(within(radios).getByText(/Ch 6 · 20 MHz/)).toBeTruthy();

    const recent = await screen.findByRole('list', { name: 'Recent events' });
    // Newest first: the synthetic log ends with ssh logins and the WAN dropping.
    expect(within(recent).getAllByRole('listitem').length).toBeLessThanOrEqual(6);
    expect(within(recent).getByText('Internet connection lost')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'System Log' })).toHaveLength(2);
  });

  it('counts the clients connected now, as the Clients page does, not a known device that is away', async () => {
    // A named host with no lease and no association: known, but not here.
    router.configs.dhcp!.away = { '.anonymous': false, '.index': 99, '.name': 'away', '.type': 'host', name: 'tablet', mac: ['02:00:00:00:00:99'] };
    renderApp('#/');
    const total = () => Number((screen.getByText('Total').parentElement!.textContent ?? '').replace(/\D/g, ''));
    await waitFor(() => expect(total()).toBeGreaterThan(0));
    const dashboard = total();
    location.hash = '#/clients';
    const subtitle = await screen.findByText(/online · \d+ known/);
    const [, online, known] = /(\d+) online · (\d+) known/.exec(subtitle.textContent!)!;
    expect(Number(known)).toBeGreaterThan(Number(online));
    expect(dashboard).toBe(Number(online));
  });
});
