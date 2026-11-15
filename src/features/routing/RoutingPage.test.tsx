import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor, fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { pick, type } from '../../../test/dom';
import { applyReviewed } from '../../../test/applyFlow';
import dohCfg from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.https-dns-proxy.json';
import dohDhcp from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.dhcp.doh-active.json';
import plainWrxDhcp from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.dhcp.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const ofType = (pkg: string, t: string) => Object.values(router.configs[pkg]!).filter((s) => s['.type'] === t);

beforeEach(() => {
  resetRouter();
});

describe('Routing', () => {
  it('shows the active routes from netifd', async () => {
    renderApp('#/settings/routing');
    const table = await screen.findByRole('table', { name: 'Active routes' });
    expect(table.textContent).toContain('0.0.0.0/0 (default)');
    expect(table.textContent).toContain('10.231.0.1');
    expect(table.textContent).toContain('10.231.1.0/24');
  });

  it('adds a static route', async () => {
    renderApp('#/settings/routing');
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary');
    type(drawer, 'Name', 'Lab');
    type(drawer, 'Destination network', '10.50.0.0/16');
    pick(drawer, 'Interface', 'lan');
    type(drawer, 'Next hop', '10.231.1.254');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));

    await applyReviewed();
    expect(ofType('network', 'route')).toEqual([
      expect.objectContaining({ name: 'Lab', interface: 'lan', target: '10.50.0.0/16', gateway: '10.231.1.254' }),
    ]);
    // Left open, the create form would now flag its own route as a duplicate.
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });

  it('flags a route with host bits set', async () => {
    renderApp('#/settings/routing');
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary');
    type(drawer, 'Destination network', '10.50.0.1/16');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    expect(within(drawer).getByRole('alert').textContent).toContain('10.50.0.0/16');
    expect(router.writes()).toEqual([]);
  });
});

describe('DNS', () => {
  it('adds a local DNS record', async () => {
    renderApp('#/settings/routing');
    fireEvent.click(await screen.findByRole('tab', { name: 'DNS' }));
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary');
    type(drawer, 'Host name', 'nas');
    type(drawer, 'IP address', '10.231.1.10');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));

    await applyReviewed();
    expect(ofType('dhcp', 'domain')).toEqual([expect.objectContaining({ name: 'nas', ip: '10.231.1.10' })]);
  });

  it('adds an alias', async () => {
    renderApp('#/settings/routing');
    fireEvent.click(await screen.findByRole('tab', { name: 'DNS' }));
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary');
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Alias (CNAME)' }));
    type(drawer, 'Host name', 'files');
    type(drawer, 'Points to', 'laptop');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));

    await applyReviewed();
    expect(ofType('dhcp', 'cname')).toEqual([expect.objectContaining({ cname: 'files', target: 'laptop' })]);
  });

  it('sets custom upstream servers and the local domain', async () => {
    renderApp('#/settings/routing');
    fireEvent.click(await screen.findByRole('tab', { name: 'DNS' }));
    await screen.findByText('DNS Settings');
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    type(document.body, 'DNS servers', '1.1.1.1, 9.9.9.9');
    type(document.body, 'Local domain', 'home.arpa');
    fireEvent.click(screen.getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.dhcp!.cfg01411c).toMatchObject({
      server: ['1.1.1.1', '9.9.9.9'],
      noresolv: '1',
      domain: 'home.arpa',
      local: '/home.arpa/',
    });
  });
});

describe('DNS over HTTPS', () => {
  const card = async () => {
    renderApp('#/settings/routing');
    fireEvent.click(await screen.findByRole('tab', { name: 'DNS' }));
    return (await screen.findByRole('heading', { name: /DNS over HTTPS/ })).closest('section')!;
  };
  const execs = () => router.calls.filter((c) => c.object === 'file').map((c) => (c.args.params as string[])[0]);

  it('explains the package when it is not installed', async () => {
    expect((await card()).textContent).toMatch(/https-dns-proxy package/);
  });

  it('switches off: cleans up dnsmasq through the apply, then stops the proxy', async () => {
    resetRouter({ 'https-dns-proxy': structuredClone(dohCfg.values), dhcp: structuredClone(dohDhcp.values) });
    const c = await card();
    await within(c).findByText('Active');
    fireEvent.click(within(c).getByRole('switch', { name: 'Encrypt DNS' }));
    fireEvent.click(within(c).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    await waitFor(() => expect(execs()).toEqual(['stop', 'disable']));
    const dnsmasq = ofType('dhcp', 'dnsmasq')[0]!;
    expect(dnsmasq.server).toBeUndefined();
    expect(dnsmasq.doh_server).toBeUndefined();
    // The proxy's own config is left alone (its reload would race the stop).
    expect(router.writes().some((w) => w.args.config === 'https-dns-proxy')).toBe(false);
  });

  it('switches on without an apply when there is nothing to write', async () => {
    resetRouter({ 'https-dns-proxy': structuredClone(dohCfg.values), dhcp: structuredClone(plainWrxDhcp.values) });
    const c = await card();
    await within(c).findByText('Off');
    fireEvent.click(within(c).getByRole('switch', { name: 'Encrypt DNS' }));
    fireEvent.click(within(c).getByRole('button', { name: 'Apply Changes' }));
    await waitFor(() => expect(execs()).toEqual(['enable', 'start']));
    expect(router.writes()).toHaveLength(0);
  });
});
