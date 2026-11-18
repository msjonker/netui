import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { recorded, seedDevices } from '../../../test/fakeReads/devices';
import { seedPackages } from '../../../test/fakeReads/packages';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { pick } from '../../../test/dom';
import { wrxFixtures } from '../../../test/fixtures';
import usteerJson from '../../../test/fixtures/ubus/bench-v2/gateway.uci.get.usteer.json';
import type { UciGet } from '../../api/types';
const usteerFixture: UciGet = usteerJson;
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
    const rows = within(radios).getAllByRole('row').map((r) => r.textContent);
    // As recorded: client WiFi and the mesh share the WiFi 6 radio, the spare radio is off.
    expect(rows).toContainEqual(expect.stringMatching(/^5 GHzWiFi \+ mesh3680 MHz/));
    expect(rows).toContainEqual(expect.stringMatching(/^2\.4 GHzWiFi120 MHz/));
    expect(rows).toContainEqual(expect.stringMatching(/^5 GHzOff/));
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
    await waitFor(() => expect(radios.textContent).toContain('WiFi + mesh'));
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

  it('offers the full WiFi package when the router has the basic one', async () => {
    resetRouter({ wireless: wrxFixtures('plain').uci.wireless() });
    seedPackages(router, '', { mesh: false });
    renderApp('#/settings/wifi');
    const card = (await screen.findByText('Wireless mesh')).closest('section, div.rounded-lg') as HTMLElement;
    expect((await within(card).findByText(/Mesh needs the full WiFi package/)).textContent).toMatch(/basic one/);
    fireEvent.click(within(card).getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Full WiFi package (mesh)?' });
    expect(dialog.textContent).toMatch(/WiFi restarts once/);
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

describe('per-access-point radio settings', () => {
  it('moves the 2.4 GHz radio to channel 6 on the access point, with rollback and confirm', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp(`#/devices/${recorded.device.mac}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit 2.4 GHz radio' }));
    const dialog = await screen.findByRole('dialog', { name: '2.4 GHz radio' });
    await within(dialog).findByLabelText('Channel');
    pick(dialog, 'Channel', '6');
    fireEvent.click(within(dialog).getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '2.4 GHz radio' })).toBeNull(), { timeout: 5000 });
    const relayed = calls('call').filter((c) => c.object === 'uci' && c.method !== 'get').map((c) => [c.method, c.args]);
    expect(relayed).toEqual([
      ['set', { config: 'wireless', section: 'radio2', values: { channel: '6' } }],
      ['apply', { rollback: true, timeout: 30 }],
      ['confirm', {}],
    ]);
  });

  it('locks channel and width on the radio that carries the mesh', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp(`#/devices/${recorded.device.mac}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit 5 GHz radio' }));
    const dialog = await screen.findByRole('dialog', { name: '5 GHz radio' });
    expect(await within(dialog).findByText(/follow the gateway/)).toBeTruthy();
    expect(((await within(dialog).findByLabelText('Channel')) as HTMLSelectElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText('Transmit power') as HTMLSelectElement).disabled).toBe(false);
  });
});

describe('client steering', () => {
  it('turns on the roaming assistant: usteer thresholds plus BSS transition and 802.11k, then copies it to the APs', async () => {
    resetRouter({ wireless: wrxFixtures('plain').uci.wireless(), usteer: structuredClone(usteerFixture.values) });
    seedDevices(router, { managed: [recorded.device] });
    seedPackages(router, '', { mesh: true });
    renderApp('#/settings/wifi');
    const card = (await screen.findByText('Client steering')).closest('section, div.rounded-lg') as HTMLElement;
    fireEvent.click(within(card).getByRole('switch', { name: 'Roaming assistant' }));
    pick(card, 'Minimum signal', '-75');
    fireEvent.click(within(card).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.usteer!.cfg01ef5d).toMatchObject({ roam_scan_snr: '-70', roam_trigger_snr: '-75', min_snr: '-75', band_steering_threshold: '5' });
    expect(router.configs.wireless!.default_radio0).toMatchObject({ bss_transition: '1', ieee80211k: '1' });
    await waitFor(() => expect(calls('sync')).toHaveLength(1));
  });

  it('leaves BSS transition off with the basic WiFi package, which cannot start a WiFi with it', async () => {
    resetRouter({ wireless: wrxFixtures('plain').uci.wireless(), usteer: structuredClone(usteerFixture.values) });
    seedPackages(router, '', { mesh: false });
    renderApp('#/settings/wifi');
    const card = (await screen.findByText('Client steering')).closest('section, div.rounded-lg') as HTMLElement;
    await within(card).findByText(/needs the full WiFi package/);
    fireEvent.click(within(card).getByRole('switch', { name: 'Roaming assistant' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.usteer!.cfg01ef5d).toMatchObject({ roam_trigger_snr: '-75' });
    expect(router.configs.wireless!.default_radio0!.bss_transition).toBeUndefined();
  });

  it('is hidden when usteer is not installed', async () => {
    resetRouter({ wireless: wrxFixtures('plain').uci.wireless() });
    renderApp('#/settings/wifi');
    await screen.findByText('Radios');
    expect(screen.queryByText('Client steering')).toBeNull();
  });
});

describe('access point ports', () => {
  const relayed = (object: string, method: string) =>
    calls('call').filter((a) => a.object === object && a.method === method).map((a) => a.args as Record<string, unknown>);

  /** The gateway with an IoT network on VLAN 10, and its mesh on. */
  const vlanGateway = () => {
    const f = wrxFixtures('vlan');
    const wireless = f.uci.wireless();
    wireless.netui_mesh = { '.anonymous': false, '.type': 'wifi-iface', '.name': 'netui_mesh', '.index': 99, device: 'radio0', mode: 'mesh', network: 'lan' };
    resetRouter({ network: f.uci.network(), firewall: f.uci.firewall(), dhcp: f.uci.dhcp(), wireless });
  };

  it('lists the ports as on LAN while the gateway has no other network', async () => {
    seedDevices(router, { managed: [recorded.device] });
    renderApp(`#/devices/${recorded.device.mac}`);
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });
    const table = await within(drawer).findByRole('table', { name: 'Ports' });
    // As recorded with a cable in lan1.
    expect(within(table).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual([
      'lan11 GbpsLANNone',
      'lan2No linkLANNone',
      'lan3No linkLANNone',
      'wanNo linkLANNone',
    ]);
    expect(within(drawer).getByText(/Every port is on LAN/)).toBeTruthy();
    expect(within(table).queryByRole('button', { name: /Edit port/ })).toBeNull();
  });

  it('carries the gateway VLANs to an access point on the mesh, and fixes the mesh', async () => {
    vlanGateway();
    seedDevices(router, { managed: [recorded.device] });
    renderApp(`#/devices/${recorded.device.mac}`);
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });
    await within(drawer).findByRole('table', { name: 'Ports' });

    fireEvent.click(await within(drawer).findByRole('button', { name: /Carry them now/ }));
    await waitFor(() => expect(relayed('uci', 'apply')).toEqual([{ rollback: true, timeout: 60 }]), { timeout: 5000 });
    expect(relayed('uci', 'add')).toEqual([
      expect.objectContaining({ config: 'network', type: 'bridge-vlan', values: expect.objectContaining({ vlan: '1' }) }),
      expect.objectContaining({ config: 'network', type: 'bridge-vlan', values: { device: 'br-lan', vlan: '10', ports: ['lan1:t', 'lan2:t', 'lan3:t', 'wan:t'] } }),
      { config: 'network', type: 'interface', name: 'netui_iot', values: { proto: 'none', device: 'br-lan.10' } },
    ]);
    await waitFor(() => expect(relayed('uci', 'confirm').length).toBe(1), { timeout: 5000 });
    // Then the plugin copies the WiFi, IoT's included.
    await waitFor(() => expect(calls('sync')).toEqual([{ mac: recorded.device.mac }]));

    // The gateway's mesh predates its IoT network.
    const mesh = await within(drawer).findByText(/The wireless mesh does not carry IOT \(10\)/);
    fireEvent.click(within(mesh.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Fix' }));
    await applyReviewed();
    expect(router.configs.wireless!.netui_mesh!.network_vlan).toEqual(['10:t']);
    // A WiFi change: every access point follows.
    await waitFor(() => expect(calls('sync')).toEqual([{ mac: recorded.device.mac }, {}]), { timeout: 8000 });
  }, 20_000);

  it('moves a port of an access point onto IoT', async () => {
    vlanGateway();
    // The access point as the first sync leaves it.
    const { apFixtures } = await import('../../../test/fixtures');
    const { FakeRouter, stageOn } = await import('../../../test/fakeRouter');
    const { apSyncOps, gatewayVlans, readApLayout } = await import('../../model/apPorts');
    const { normalizeSwitch } = await import('../../model/ports');
    const ap = apFixtures('ax3600');
    const gw = gatewayVlans(normalizeSwitch(router.configs.network!, undefined, undefined, undefined));
    const synced = stageOn(new FakeRouter({ network: ap.uci.network() }), apSyncOps(readApLayout(ap.uci.network(), ap.deviceStatus(), ap.ports()), gw, ap.uci.network())).network!;
    seedDevices(router, { managed: [recorded.device], apNetwork: synced });

    renderApp(`#/devices/${recorded.device.mac}`);
    const drawer = await screen.findByRole('complementary', { name: 'Office AP' });
    const table = await within(drawer).findByRole('table', { name: 'Ports' });
    expect(within(drawer).queryByRole('button', { name: /Carry them now/ })).toBeNull();
    const row = within(table).getByText('lan3').closest('tr')!;
    expect(row.textContent).toContain('All others');
    fireEvent.click(within(table).getByRole('button', { name: 'Edit port lan3' }));

    const dialog = await screen.findByRole('dialog', { name: 'Port lan3' });
    pick(dialog, 'Network', '10');
    pick(dialog, 'Also carries', 'none');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(relayed('uci', 'apply')).toEqual([{ rollback: true, timeout: 30 }]));
    const sets = relayed('uci', 'set').map((a) => (a.values as { ports?: string[] }).ports);
    expect(sets).toEqual([
      ['lan1:u*', 'lan2:u*', 'wan:u*'],
      ['lan1:t', 'lan2:t', 'lan3:u*', 'wan:t'],
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Port lan3' })).toBeNull(), { timeout: 5000 });
  });
});
