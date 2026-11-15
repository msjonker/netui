import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter } from '../../test/fakeRouter';
import { renderApp } from '../../test/renderApp';
import synthetic from '../../test/fixtures/ubus/dl-wrx36/log.read.synthetic.json';
import type { LogRead } from '../api/types';
import { PAGES, searchItems, type SearchItem } from './Search';

vi.mock('../api/ubus', async (orig) => (await import('../../test/fakeRouter')).fakeUbusModule(await orig()));

const extra: LogRead = synthetic;

beforeEach(() => {
  localStorage.clear();
  resetRouter();
});

describe('searchItems', () => {
  const items: SearchItem[] = [
    { group: 'Clients', label: 'laptop', href: '/clients/02:4e:55:00:01:10', keywords: ['02:4e:55:00:01:10', '024e55000110', '10.231.1.10'] },
    { group: 'Clients', label: 'my-laptop', href: '/clients/aa', keywords: [] },
    { group: 'WiFi', label: 'Home', href: '/settings/wifi', keywords: ['wifi'] },
    ...PAGES,
  ];

  it('lists pages for an empty query', () => {
    expect(searchItems(items, '  ')).toEqual(PAGES);
  });

  it('ranks label prefixes first and matches MACs in any form and IPs', () => {
    expect(searchItems(items, 'lap').map((i) => i.label)).toEqual(['laptop', 'my-laptop']);
    expect(searchItems(items, '024E55').map((i) => i.label)).toEqual(['laptop']);
    expect(searchItems(items, '10.231.1.10').map((i) => i.label)).toEqual(['laptop']);
    expect(searchItems(items, 'wifi').map((i) => `${i.group}:${i.label}`)).toEqual(['WiFi:Home', 'Pages:WiFi']);
    expect(searchItems(items, 'firewall rules').map((i) => i.href)).toEqual(['/settings/security']);
  });
});

// Pages without the dashboard's throughput chart: uPlot needs Path2D,
// which jsdom lacks, once two samples have been taken.
describe('global search', () => {
  it('opens with Ctrl+K, finds a client by name and navigates on Enter', async () => {
    renderApp('#/logs');
    await screen.findByRole('heading', { name: 'System Log' });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const box = await screen.findByRole('combobox', { name: 'Search netui' });
    fireEvent.input(box, { target: { value: 'laptop' } });
    await screen.findByRole('option', { name: /laptop/ });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(location.hash).toBe('#/clients/02:4e:55:00:01:10'));
    expect(screen.queryByRole('combobox', { name: 'Search netui' })).toBeNull();
  });

  it('moves through results with the arrow keys and closes on Escape', async () => {
    renderApp('#/clients');
    fireEvent.click(await screen.findByRole('button', { name: 'Search' }));
    const box = await screen.findByRole('combobox', { name: 'Search netui' });
    fireEvent.input(box, { target: { value: 'settings' } });
    const options = await screen.findAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'Enter' });
    // Settings pages, alphabetical: Diagnostics, then Firewall & Security.
    await waitFor(() => expect(location.hash).toBe('#/settings/security'));

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Search netui' }), { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Search netui' })).toBeNull();
  });
});

describe('notifications', () => {
  it('starts with nothing unread on first use', async () => {
    renderApp('#/clients');
    await waitFor(() => expect(localStorage.getItem('netui.notifications.seen')).not.toBeNull());
    expect(screen.queryByTestId('notification-count')).toBeNull();
  });

  it('counts important events since last opened, and clears the count on open', async () => {
    const seen = extra.log.find((e) => e.id === 1050)!;
    localStorage.setItem('netui.notifications.seen', JSON.stringify({ id: seen.id, time: seen.time }));
    renderApp('#/clients');

    const badge = await screen.findByTestId('notification-count');
    // After 1050: IPv6 up, ssh bad password, LuCI failed + accepted, internet
    // and IPv6 down, password and pubkey ssh logins.
    expect(badge.textContent).toBe('8');

    fireEvent.click(screen.getByRole('button', { name: 'Notifications (8 new)' }));
    const pop = await screen.findByRole('dialog', { name: 'Notifications' });
    await within(pop).findByText('Internet connection lost');
    expect(within(pop).getAllByLabelText('Unread')).toHaveLength(8);
    expect(screen.queryByTestId('notification-count')).toBeNull();
    expect(JSON.parse(localStorage.getItem('netui.notifications.seen')!).id).toBe(1064);

    fireEvent.click(within(pop).getByRole('link', { name: 'View all events' }));
    await waitFor(() => expect(location.hash).toBe('#/logs'));
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
  });

  it('flags a device never seen before', async () => {
    // Known before: only the wired PC. The phone joins in the synthetic log.
    localStorage.setItem('netui.notifications.seen', JSON.stringify({ id: 1038, time: 1760313265756 }));
    localStorage.setItem('netui.notifications.knownMacs', JSON.stringify({ '00:00:5e:00:53:01': 0 }));
    renderApp('#/clients');
    fireEvent.click(await screen.findByRole('button', { name: /Notifications \(\d+ new\)/ }));
    const pop = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(await within(pop).findByText('New device')).toBeTruthy();
    expect(within(pop).getByText(/connected to/).textContent).toContain('3a:7c:12:9e:44:01');
  });
});

describe('theme', () => {
  it('switches to dark and back from the account menu', async () => {
    resetRouter();
    renderApp('#/');
    fireEvent.click(await screen.findByLabelText('Account'));
    const theme = screen.getByRole('tablist', { name: 'Theme' });
    expect(within(theme).getByRole('tab', { name: 'System' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(theme).getByRole('tab', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('netui.theme')).toBe('dark');
    fireEvent.click(within(theme).getByRole('tab', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('netui.theme')).toBeNull();
  });
});
