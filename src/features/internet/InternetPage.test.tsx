import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import type { InterfaceDump, UciConfig, UciGet } from '../../api/types';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { pick, type } from '../../../test/dom';
import { applyReviewed } from '../../../test/applyFlow';
import netJson from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.network.json';
import sqmJson from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.sqm.json';
import upnpdJson from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.upnpd.json';
import ddnsJson from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.ddns.json';
import dumpJson from '../../../test/fixtures/ubus/dl-wrx36/plain/network.interface.dump.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const rec: { network: UciGet; sqm: UciGet; upnpd: UciGet; ddns: UciGet; dump: InterfaceDump } = {
  network: netJson,
  sqm: sqmJson,
  upnpd: upnpdJson,
  ddns: ddnsJson,
  dump: dumpJson,
};
const copy = (g: UciGet): UciConfig => structuredClone(g.values);

/** The DL-WRX36 factory config: DHCP WAN on port "wan", cable unplugged. */
function dlwrx36() {
  const r = resetRouter({ network: copy(rec.network), sqm: copy(rec.sqm), upnpd: copy(rec.upnpd), ddns: copy(rec.ddns) });
  r.live.ifaceDump = () => structuredClone(rec.dump);
  return r;
}

const card = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section')!;

beforeEach(() => {
  dlwrx36();
});

describe('Internet', () => {
  it('switches the WAN from DHCP to a static address, as a disruptive apply', async () => {
    renderApp('#/settings/internet');
    fireEvent.click(within(await card('Primary (WAN1)')).getByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('complementary', { name: 'Primary (WAN1)' });
    pick(drawer, 'Connection type', 'static');
    type(drawer, 'IP address', '203.0.113.5');
    type(drawer, 'Prefix', '29');
    type(drawer, 'Gateway', '203.0.113.1');
    type(drawer, 'DNS servers', '1.1.1.1, 9.9.9.9');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.network!.wan).toMatchObject({
      proto: 'static',
      device: 'wan',
      ipaddr: ['203.0.113.5/29'],
      gateway: '203.0.113.1',
      dns: ['1.1.1.1', '9.9.9.9'],
    });
  });

  it('tags the WAN with a VLAN and keeps wan6 on the same device', async () => {
    renderApp('#/settings/internet');
    fireEvent.click(within(await card('Primary (WAN1)')).getByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('complementary', { name: 'Primary (WAN1)' });
    type(drawer, 'VLAN ID', '7');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.network!.wan!.device).toBe('wan.7');
    expect(router.configs.network!.wan6!.device).toBe('wan.7');
  });

  it('enables Smart Queues on the real WAN device', async () => {
    renderApp('#/settings/internet');
    const sqm = await card('Smart Queues');
    fireEvent.click(within(sqm).getByRole('switch', { name: 'Smart Queues' }));
    type(sqm, 'Download limit', '450');
    type(sqm, 'Upload limit', '40');
    fireEvent.click(within(sqm).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.sqm!.eth1).toMatchObject({
      enabled: '1',
      interface: 'wan',
      download: '450000',
      upload: '40000',
      qdisc: 'cake',
      script: 'piece_of_cake.qos',
    });
    // The stock sqm init script is disabled, so no reload trigger exists: netui enables and restarts it.
    await waitFor(() =>
      expect(router.calls.filter((c) => c.object === 'file').map((c) => c.args)).toEqual([
        { command: '/etc/init.d/sqm', params: ['enable'] },
        { command: '/etc/init.d/sqm', params: ['restart'] },
      ]),
    );
  });

  it('turns UPnP on', async () => {
    renderApp('#/settings/internet');
    const upnp = await card('UPnP');
    fireEvent.click(within(upnp).getByRole('switch', { name: 'UPnP' }));
    fireEvent.click(within(upnp).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.upnpd!.config!.enabled).toBe('1');
    expect(await within(upnp).findByText('No active port mappings.')).toBeTruthy();
  });

  it('removes an active UPnP mapping directly after confirmation', async () => {
    router.configs.upnpd!.config!.enabled = '1';
    const rule = { num: '1', proto: 'UDP', extport: 3074, intaddr: '10.231.1.50', intport: 3074, descr: 'Xbox', host_hint: 'xbox' };
    router.overrides.push((c) => (c.object === 'luci.upnp' && c.method === 'get_status' ? { rules: [rule] } : undefined));
    renderApp('#/settings/internet');
    const upnp = await card('UPnP');
    fireEvent.click(await within(upnp).findByRole('button', { name: 'Remove mapping UDP 3074' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Remove port mapping/ })).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(router.calls).toContainEqual({ object: 'luci.upnp', method: 'delete_rule', args: { token: '1' } }),
    );
    expect(router.writes()).toHaveLength(0);
  });

  it('shows the factory DDNS examples honestly and adds a service', async () => {
    renderApp('#/settings/internet');
    const ddns = await card('Dynamic DNS');
    expect(within(ddns).getByText('myddns_ipv4 (example)')).toBeTruthy();
    expect(within(ddns).getAllByText('Not configured')).toHaveLength(2);

    fireEvent.click(within(ddns).getByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create Dynamic DNS' });
    pick(drawer, 'Provider', 'duckdns.org');
    type(drawer, 'Hostname', 'home.duckdns.org');
    type(drawer, 'Password or token', 'tok3n');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    await applyReviewed();
    expect(router.configs.ddns!.home_duckdns_org).toMatchObject({
      '.type': 'service',
      enabled: '1',
      service_name: 'duckdns.org',
      lookup_host: 'home.duckdns.org',
      domain: 'home.duckdns.org',
      password: 'tok3n',
      interface: 'wan',
      ip_source: 'network',
      ip_network: 'wan',
    });
  });

  it('offers SQM, UPnP and DDNS as add-ons when those packages are missing', async () => {
    resetRouter();
    renderApp('#/settings/internet');
    await card('Primary (WAN1)');
    // Each its own card, marked as not installed, with Install.
    for (const title of ['Smart Queues', 'UPnP', 'Dynamic DNS']) {
      const c = (await screen.findByRole('heading', { name: new RegExp(`^${title}\\s*Not installed`) })).closest('section') as HTMLElement;
      expect(within(c).getByRole('button', { name: 'Install' })).toBeTruthy();
    }
    const adv = (await screen.findByRole('heading', { name: 'Advanced' })).closest('section') as HTMLElement;
    expect(within(adv).queryByRole('button', { name: 'Install' })).toBeNull();
  });
});
