import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { fastDeps, renderApp } from '../../../test/renderApp';
import { pick } from '../../../test/dom';
import { applyReviewed, review } from '../../../test/applyFlow';
import { recorded, seedDevices } from '../../../test/fakeReads/devices';
import { apFixtures, wrxFixtures } from '../../../test/fixtures';
import { FakeRouter, stageOn } from '../../../test/fakeRouter';
import { apSyncOps, gatewayVlans, readApLayout } from '../../model/apPorts';
import { normalizeSwitch } from '../../model/ports';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

async function openPort(name: string, deps = fastDeps()) {
  renderApp('#/settings/ports', deps);
  fireEvent.click(await screen.findByRole('button', { name: `Port ${name}` }));
  return screen.findByRole('complementary');
}

const vlanPorts = (vid: string) =>
  Object.values(router.configs.network!).find((s) => s['.type'] === 'bridge-vlan' && s.vlan === vid)?.ports;

describe('Ports on a VLAN-filtering bridge', () => {
  beforeEach(() => {
    resetRouter({}, 'vlan');
  });

  it('shows each port with its native network and tagged VLANs', async () => {
    renderApp('#/settings/ports');
    const row = (name: string) => screen.getAllByRole('row').find((r) => r.querySelector('td')?.textContent?.trim().startsWith(name))!;
    await screen.findByRole('button', { name: 'Port eth4' });
    expect(row('eth4').textContent).toContain('IOT (20)');
    expect(row('eth2').textContent).toMatch(/LAN \(1\)IOT \(20\)/);
    expect(row('eth1').textContent).toContain('Internet');
  });

  it('tags every other network on a port with Allow All, as a disruptive apply', async () => {
    const deps = fastDeps();
    const sleep = vi.spyOn(deps, 'sleep');
    const drawer = await openPort('eth0', deps);
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Allow All' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    expect((await review()).textContent).toContain('VLAN 20 on br-lan');
    await applyReviewed();
    expect(vlanPorts('20')).toEqual(['eth2:t', 'eth3', 'eth4', 'eth0:t']);
    expect(vlanPorts('1')).toEqual(['eth0:u*', 'eth2:u*', 'eth3:u*']);
    expect(sleep).toHaveBeenCalledWith(4_000);
  });

  it('keeps an extra untagged membership until it is removed', async () => {
    const drawer = await openPort('eth3');
    expect(within(drawer).getByRole('status').textContent).toMatch(/untagged/);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(vlanPorts('20')).toEqual(['eth2:t', 'eth4']);
  });

  it('moves a port to another native network', async () => {
    const drawer = await openPort('eth4');
    pick(drawer, 'Untagged traffic', '1');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(vlanPorts('1')).toEqual(['eth0:u*', 'eth2:u*', 'eth3:u*', 'eth4:u*']);
    expect(vlanPorts('20')).toEqual(['eth2:t', 'eth3']);
  });

  it('does not offer to edit the WAN port', async () => {
    const drawer = await openPort('eth1');
    expect(within(drawer).queryByRole('button', { name: 'Apply Changes' })).toBeNull();
    expect(within(drawer).queryByLabelText('Untagged traffic')).toBeNull();
  });
});

describe('Ports on a plain bridge', () => {
  beforeEach(() => {
    resetRouter({}, 'plain');
  });

  it('takes a port out of the bridge without turning on VLAN filtering', async () => {
    const drawer = await openPort('eth4');
    expect(within(drawer).getByText(/only one network on this bridge/)).toBeTruthy();
    pick(drawer, 'Untagged traffic', '');
    expect(within(drawer).getByText(/taken out of br-lan/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    const bridge = Object.values(router.configs.network!).find((s) => s['.type'] === 'device' && s.name === 'br-lan');
    expect(bridge!.ports).toEqual(['eth0', 'eth2', 'eth3']);
    expect(Object.values(router.configs.network!).some((s) => s['.type'] === 'bridge-vlan')).toBe(false);
  });
});

describe('Ports of an access point', () => {
  const plugin = (method: string) =>
    router.calls.filter((c) => c.object === 'netui.devices' && c.method === method).map((c) => c.args);
  const relayed = (object: string, method: string) =>
    plugin('call').filter((a) => a.object === object && a.method === method).map((a) => a.args as Record<string, unknown>);

  /** The gateway with an IoT network on VLAN 10, and its mesh on. */
  const vlanGateway = () => {
    const f = wrxFixtures('vlan');
    const wireless = f.uci.wireless();
    wireless.netui_mesh = { '.anonymous': false, '.type': 'wifi-iface', '.name': 'netui_mesh', '.index': 99, device: 'radio0', mode: 'mesh', network: 'lan' };
    resetRouter({ network: f.uci.network(), firewall: f.uci.firewall(), dhcp: f.uci.dhcp(), wireless });
  };

  /** The access point as the first sync leaves it. */
  const synced = () => {
    const ap = apFixtures('ax3600');
    const gw = gatewayVlans(normalizeSwitch(router.configs.network!, undefined, undefined, undefined));
    const layout = readApLayout(ap.uci.network(), ap.deviceStatus(), ap.ports());
    return stageOn(new FakeRouter({ network: ap.uci.network() }), apSyncOps(layout, gw, ap.uci.network())).network!;
  };

  const openAp = async () => {
    renderApp('#/settings/ports');
    fireEvent.click(await screen.findByRole('tab', { name: 'Office AP' }));
    return screen.findByRole('table', { name: 'Ports' });
  };

  it('picks the access point from the device row; every port on LAN while the gateway has no other network', async () => {
    seedDevices(router, { managed: [recorded.device] });
    const table = await openAp();
    // As recorded with a cable in lan1.
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBe(5));
    expect(within(table).getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/\s+/g, ''))).toEqual([
      'lan11GbpsLANNone',
      'lan2NolinkLANNone',
      'lan3NolinkLANNone',
      'wanNolinkLANNone',
    ]);
    expect(screen.getByText(/Every port is on LAN/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Port lan2' }));
    const drawer = await screen.findByRole('complementary', { name: 'lan2' });
    expect(within(drawer).queryByRole('button', { name: 'Apply Changes' })).toBeNull();
  });

  it('carries the gateway VLANs to an access point on the mesh, and fixes the mesh', async () => {
    vlanGateway();
    seedDevices(router, { managed: [recorded.device] });
    await openAp();

    fireEvent.click(await screen.findByRole('button', { name: /Carry them now/ }));
    await waitFor(() => expect(relayed('uci', 'apply')).toEqual([{ rollback: true, timeout: 60 }]), { timeout: 5000 });
    expect(relayed('uci', 'add')).toEqual([
      expect.objectContaining({ config: 'network', type: 'bridge-vlan', values: expect.objectContaining({ vlan: '1' }) }),
      expect.objectContaining({ config: 'network', type: 'bridge-vlan', values: { device: 'br-lan', vlan: '10', ports: ['lan1:t', 'lan2:t', 'lan3:t', 'wan:t'] } }),
      { config: 'network', type: 'interface', name: 'netui_iot', values: { proto: 'none', device: 'br-lan.10' } },
    ]);
    await waitFor(() => expect(relayed('uci', 'confirm').length).toBe(1), { timeout: 5000 });
    // Then the plugin copies the WiFi, IoT's included.
    await waitFor(() => expect(plugin('sync')).toEqual([{ mac: recorded.device.mac }]));

    // The gateway's mesh predates its IoT network.
    const mesh = await screen.findByText(/The wireless mesh does not carry IOT \(10\)/);
    fireEvent.click(within(mesh.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Fix' }));
    await applyReviewed();
    expect(router.configs.wireless!.netui_mesh!.network_vlan).toEqual(['10:t']);
    // A WiFi change: every access point follows.
    await waitFor(() => expect(plugin('sync')).toEqual([{ mac: recorded.device.mac }, {}]), { timeout: 8000 });
  }, 20_000);

  it('moves a port of an access point onto IoT, reviewed and confirmed like on the gateway', async () => {
    vlanGateway();
    seedDevices(router, { managed: [recorded.device], apNetwork: synced() });
    const table = await openAp();
    expect(screen.queryByRole('button', { name: /Carry them now/ })).toBeNull();
    await waitFor(() => expect(within(table).getByText('lan3').closest('tr')!.textContent).toContain('IOT (10)'));

    fireEvent.click(screen.getByRole('button', { name: 'Port lan3' }));
    const drawer = await screen.findByRole('complementary', { name: 'lan3' });
    pick(drawer, 'Untagged traffic', '10');
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Block All' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Review changes' });
    expect(dialog.textContent).toContain('VLAN 10 on br-lan');
    expect(dialog.textContent).toContain('Office AP applies these');
    // Staged on the access point, not on the gateway.
    expect(router.calls.some((c) => c.object === 'uci' && c.method === 'set')).toBe(false);
    expect(relayed('uci', 'set').map((a) => (a.values as { ports?: string[] }).ports)).toEqual([
      ['lan1:u*', 'lan2:u*', 'wan:u*'],
      ['lan1:t', 'lan2:t', 'lan3:u*', 'wan:t'],
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Changes' }));
    await waitFor(() => expect(relayed('uci', 'apply')).toEqual([{ rollback: true, timeout: 30 }]));
    await waitFor(() => expect(relayed('uci', 'confirm').length).toBe(1), { timeout: 8000 });
    expect(await screen.findByRole('dialog', { name: 'Done' })).toBeTruthy();
  }, 20_000);

  it('keeps the uplink a trunk', async () => {
    vlanGateway();
    // Wired to the gateway through lan1 this time.
    seedDevices(router, { managed: [recorded.device], apNetwork: synced(), agentPorts: { ...apFixtures('ax3600').ports(), uplink: 'lan1' } });
    const table = await openAp();
    await waitFor(() => expect(within(table).getByText('lan1').closest('tr')!.textContent).toContain('To this router'));
    fireEvent.click(screen.getByRole('button', { name: 'Port lan1' }));
    const drawer = await screen.findByRole('complementary', { name: 'lan1' });
    expect(drawer.textContent).toMatch(/connects to this router/);
    expect(within(drawer).queryByRole('button', { name: 'Apply Changes' })).toBeNull();
  });
});

