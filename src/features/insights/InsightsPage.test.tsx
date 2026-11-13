import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { wireless } from '../../../test/wireless';
import { traffic } from '../../model/traffic';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  resetRouter({ wireless: wireless() });
  traffic.reset();
  // Both DL-WRX36 radios up (phy0 = 5 GHz, phy1 = 2.4 GHz).
  router.overrides.push((c) => (c.object === 'iwinfo' && c.method === 'devices' ? { devices: ['phy0-ap0', 'phy1-ap0'] } : undefined));
});

const scans = () => router.calls.filter((c) => c.object === 'iwinfo' && c.method === 'scan');

describe('Insights: WiFi environment', () => {
  it('scans each radio only when asked and lists the neighbours', async () => {
    renderApp('#/insights');
    const scan = await screen.findByRole('button', { name: 'Scan' });
    expect(await screen.findByText('Not scanned yet.', { exact: false })).toBeTruthy();
    // Utilisation from the survey shows without a scan.
    expect(await screen.findByText('7%')).toBeTruthy();
    expect(scans()).toEqual([]);

    fireEvent.click(scan);
    await vi.waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(100));
    expect(scans().map((c) => c.args)).toEqual([{ device: 'phy0-ap0' }, { device: 'phy1-ap0' }]);

    // 71 + 58 recorded networks plus the header row; hidden ones are labelled.
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(71 + 58 + 1);
    expect(within(table).getAllByText('Hidden')).toHaveLength(23 + 14);
    expect(screen.getByText(/Last scanned just now/)).toBeTruthy();
    // Channel 1 is crowded on 2.4 GHz.
    expect(screen.getByText(/Consider channel 11/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '2.4 GHz' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(58 + 1);
  });
});

describe('Insights: traffic', () => {
  it('shows connection counts from the connection table', async () => {
    renderApp('#/insights');
    fireEvent.click(await screen.findByRole('tab', { name: 'Traffic' }));
    expect(await screen.findByText('Active connections')).toBeTruthy();
    expect(router.calls.some((c) => c.object === 'luci' && c.method === 'getConntrackList')).toBe(true);
  });
});
