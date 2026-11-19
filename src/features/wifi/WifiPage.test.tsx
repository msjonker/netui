import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { fastDeps, renderApp } from '../../../test/renderApp';
import { applyReviewed, review } from '../../../test/applyFlow';
import { pick, type } from '../../../test/dom';
import { wireless } from '../../../test/wireless';
import type { UciConfig, UciGet, UciSection } from '../../api/types';
import wrxWireless from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.json';
import wrxSchedule from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wifi_schedule.json';
import wdrFresh from '../../../test/fixtures/ubus/tl-wdr4300-v1/uci.get.wireless.fresh.json';
import tlWireless from '../../../test/fixtures/ubus/tl-wr1043nd-v2/uci.get.wireless.bss_transition.json';
import tlInfo from '../../../test/fixtures/ubus/tl-wr1043nd-v2/iwinfo.info.phy0-ap0.bss_transition.json';
import tlInfoUp from '../../../test/fixtures/ubus/tl-wr1043nd-v2/iwinfo.info.phy0-ap0.json';
import tlHostapd from '../../../test/fixtures/ubus/tl-wr1043nd-v2/hostapd.phy0-ap0.get_status.json';
import { seedPackages } from '../../../test/fakeReads/packages';
import { RpcError } from '../../api/ubus';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));
// Expose the QR payload; the real component draws it as an SVG path.
vi.mock('../../components/QrCode', () => ({
  QrCode: ({ value, label }: { value: string; label: string }) => <svg role="img" aria-label={label} data-value={value} />,
}));

const wrxGet: UciGet = wrxWireless;
const scheduleGet: UciGet = wrxSchedule;
/** The DL-WRX36: radio0 = 5 GHz, radio1 = 2.4 GHz, "netui-test" WPA2 on both. */
const wrx = (): UciConfig => structuredClone(wrxGet.values);
const liveWrx = () =>
  router.overrides.push((c) => (c.object === 'iwinfo' && c.method === 'devices' ? { devices: ['phy0-ap0', 'phy1-ap0'] } : undefined));
const section = (name: string, type: string, values: Record<string, string | string[]>): UciSection => ({
  '.anonymous': false,
  '.index': 99,
  '.name': name,
  '.type': type,
  ...values,
});

const ifaces = () => Object.values(router.configs.wireless!).filter((s) => s['.type'] === 'wifi-iface');

async function open(text: string, deps = fastDeps()) {
  renderApp('#/settings/wifi', deps);
  fireEvent.click(await screen.findByText(text));
  return screen.findByRole('complementary');
}

beforeEach(() => {
  resetRouter({ wireless: wireless() });
});

describe('WiFi', () => {
  it('shows one row per SSID with its bands, and leaves client-mode ifaces out', async () => {
    renderApp('#/settings/wifi');
    const home = (await screen.findByText('Home')).closest('tr')!;
    expect(home.textContent).toContain('2.4 GHz');
    expect(home.textContent).toContain('5 GHz');
    expect(home.textContent).toContain('WPA2/WPA3');
    expect(screen.getAllByRole('row').find((r) => r.textContent!.startsWith('Guest'))!.textContent).toContain('Disabled');
    expect(screen.queryByText('Upstream')).toBeNull();
  });

  it('changes the password on every band of a WiFi, as a disruptive apply', async () => {
    const deps = fastDeps();
    const sleep = vi.spyOn(deps, 'sleep');
    const drawer = await open('Home', deps);
    type(drawer, 'Password', 'correct horse');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    // The review must not echo the passphrase.
    expect((await review()).textContent).not.toContain('correct horse');
    await applyReviewed();
    expect(router.configs.wireless!.home2!.key).toBe('correct horse');
    expect(router.configs.wireless!.home5!.key).toBe('correct horse');
    expect(sleep).toHaveBeenCalledWith(4_000);
  });

  it('drops a band by deleting its iface', async () => {
    const drawer = await open('Home');
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /5 GHz/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.wireless!.home5).toBeUndefined();
    expect(router.configs.wireless!.home2).toMatchObject({ ssid: 'Home', network: 'lan' });
  });

  it('creates a WiFi on one band', async () => {
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    fireEvent.click(screen.getByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create New WiFi' });
    type(drawer, 'Name (SSID)', 'IoT');
    type(drawer, 'Password', 'things-only');
    pick(drawer, 'Security', 'psk2');
    const bands = within(drawer).getAllByRole('checkbox') as HTMLInputElement[];
    for (const b of bands) if (b.checked) fireEvent.click(b);
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /2\.4 GHz/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add WiFi' }));

    await applyReviewed();
    expect(ifaces()).toContainEqual(
      expect.objectContaining({ device: 'radio0', mode: 'ap', ssid: 'IoT', encryption: 'psk2', key: 'things-only' }),
    );
    expect(ifaces().filter((s) => s.ssid === 'IoT')).toHaveLength(1);
  });

  it('turns the radios on for a new WiFi on a fresh 24.10 install, keeping the open placeholder off', async () => {
    // Recorded on a TL-WDR4300 v1 right after flashing 24.10.8.
    resetRouter({ wireless: structuredClone((wdrFresh as UciGet).values) });
    renderApp('#/settings/wifi');
    const row = (await screen.findByText('OpenWrt')).closest('tr')!;
    expect(row.textContent).toContain('Radio off');

    fireEvent.click(screen.getByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create New WiFi' });
    const bands = within(drawer).getAllByRole('checkbox', { name: /GHz/ }) as HTMLInputElement[];
    expect(bands.map((b) => b.checked)).toEqual([true, true]);
    expect(within(drawer).getByRole('status').textContent).toBe(
      'Applying turns on the 2.4 GHz and 5 GHz radios, which are off. The open "OpenWrt" network from the fresh install stays off.',
    );
    type(drawer, 'Name (SSID)', 'Home');
    type(drawer, 'Password', 'longenough');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add WiFi' }));

    await applyReviewed();
    const cfg = router.configs.wireless!;
    expect([cfg.radio0!.disabled, cfg.radio1!.disabled]).toEqual([undefined, undefined]);
    expect([cfg.default_radio0!.disabled, cfg.default_radio1!.disabled]).toEqual(['1', '1']);
    expect(ifaces().filter((s) => s.ssid === 'Home' && !s.disabled).map((s) => s.device)).toEqual(['radio0', 'radio1']);
  });

  it('shows a WiFi hostapd rejected as not running, and turns off the BSS transition the basic WiFi package lacks', async () => {
    // TL-WR1043ND v2 (25.12.6, basic WiFi package): hostapd has no object for
    // the interface, while iwinfo still reports its SSID.
    resetRouter({ wireless: structuredClone((tlWireless as UciGet).values) });
    seedPackages(router, '', { mesh: false });
    // hostapd starts the network once the config has no bss_transition.
    const up = () => router.configs.wireless!.wifinet0!.bss_transition === undefined;
    router.overrides.push((c) => {
      if (c.object === 'iwinfo' && c.method === 'devices') return { devices: ['phy0-ap0'] };
      if (c.object === 'iwinfo' && c.method === 'info') return structuredClone(up() ? tlInfoUp : tlInfo);
      if (c.object === 'hostapd.phy0-ap0') return up() ? structuredClone(tlHostapd) : new RpcError(-32000, 'Object not found');
      return undefined;
    });
    renderApp('#/settings/wifi');
    const row = (await screen.findByText('netui-test')).closest('tr')!;
    await waitFor(() => expect(row.textContent).toContain('Not running'));
    expect(row.textContent).not.toContain('Broadcasting');
    const banner = await screen.findByText(/"netui-test" has BSS transition \(802\.11v\) on/);
    expect(banner.textContent).toContain('so no WiFi on the 2.4 GHz radio can start.');

    fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));
    await applyReviewed();
    expect(router.configs.wireless!.wifinet0).not.toHaveProperty('bss_transition');
    expect(router.configs.wireless!.wifinet0).toMatchObject({ ieee80211k: '1', ssid: 'netui-test' });
    await waitFor(() => expect(screen.getByText('netui-test').closest('tr')!.textContent).toContain('Broadcasting'));
    await waitFor(() => expect(screen.queryByText(/can start/)).toBeNull());
  });

  it('does not offer BSS transition with the basic WiFi package', async () => {
    seedPackages(router, '', { mesh: false });
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    fireEvent.click(screen.getByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create New WiFi' });
    const bss = (await within(drawer).findByRole('switch', { name: 'BSS transition' })) as HTMLInputElement;
    await waitFor(() => expect(bss.disabled).toBe(true));
    expect(bss.checked).toBe(false);
    type(drawer, 'Name (SSID)', 'IoT');
    type(drawer, 'Password', 'things-only');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add WiFi' }));
    await applyReviewed();
    const iot = ifaces().filter((s) => s.ssid === 'IoT');
    expect(iot.length).toBeGreaterThan(0);
    for (const s of iot) expect(s).not.toHaveProperty('bss_transition');
  });

  it('refuses a duplicate SSID and a short password', async () => {
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    fireEvent.click(screen.getByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create New WiFi' });
    type(drawer, 'Name (SSID)', 'Home');
    expect((await within(drawer).findByRole('alert')).textContent).toContain('already exists');
    type(drawer, 'Name (SSID)', 'Other');
    type(drawer, 'Password', 'short');
    expect((await within(drawer).findByRole('alert')).textContent).toContain('8 to 63');
  });

  it('sets a radio channel', async () => {
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    // The radios table: the row that starts with the band.
    fireEvent.click(screen.getAllByRole('row').find((r) => r.textContent!.startsWith('2.4 GHz'))!);
    const drawer = await screen.findByRole('complementary', { name: '2.4 GHz radio' });
    await within(drawer).findByRole('option', { name: '11 (2462 MHz)' });
    pick(drawer, 'Channel', '11');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.wireless!.radio0).toMatchObject({ channel: '11', htmode: 'HT20', country: 'US' });
  });

  it('switches to WPA3 with PMF required by OpenWrt, and writes PMF for WPA2', async () => {
    let drawer = await open('Home');
    pick(drawer, 'Security', 'sae');
    const pmf = within(drawer).getByLabelText('Protected management frames (PMF)') as HTMLSelectElement;
    expect(pmf.disabled).toBe(true);
    expect(pmf.value).toBe('required');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.wireless!.home2).toMatchObject({ encryption: 'sae', key: 'hunter22' });
    expect(router.configs.wireless!.home5!.encryption).toBe('sae');
    expect(router.configs.wireless!.home2!.ieee80211w).toBeUndefined();

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Done' })).getByRole('button', { name: 'OK' }));
    // The drawer closes once the change is confirmed; open it again.
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    fireEvent.click(screen.getByRole('cell', { name: 'Home' }));
    drawer = await screen.findByRole('complementary', { name: 'Home' });
    pick(drawer, 'Security', 'psk2');
    pick(drawer, 'Protected management frames (PMF)', 'required');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.wireless!.home5).toMatchObject({ encryption: 'psk2', ieee80211w: '2' });
  });

  it('turns on fast roaming and client isolation on every band', async () => {
    resetRouter({ wireless: wrx() });
    const drawer = await open('netui-test');
    fireEvent.click(within(drawer).getByRole('switch', { name: 'Fast roaming (802.11r)' }));
    fireEvent.click(within(drawer).getByRole('switch', { name: 'Client device isolation' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    for (const s of ['default_radio0', 'default_radio1']) {
      expect(router.configs.wireless![s]).toMatchObject({ ieee80211r: '1', ft_over_ds: '0', ft_psk_generate_local: '1', isolate: '1' });
    }
  });

  it('makes a guest WiFi on an isolated network', async () => {
    router.configs.network!.guest = section('guest', 'interface', { proto: 'static', device: 'br-guest', ipaddr: '192.168.50.1/24' });
    router.configs.firewall!.guestzone = section('guestzone', 'zone', { name: 'guest', network: ['guest'], input: 'REJECT', forward: 'REJECT' });
    const drawer = await open('Home');
    fireEvent.click(within(drawer).getByRole('switch', { name: 'Guest network' }));
    expect((within(drawer).getByLabelText('Network') as HTMLSelectElement).value).toBe('guest');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    // home2 stores network as an option, home5 as a list: each keeps its form.
    expect(router.configs.wireless!.home2).toMatchObject({ network: 'guest', isolate: '1' });
    expect(router.configs.wireless!.home5).toMatchObject({ network: ['guest'], isolate: '1' });
    await waitFor(() => expect(screen.getAllByRole('row').find((r) => r.textContent!.startsWith('Home'))!.textContent).toContain('Guest'));
  });

  it('shares a WiFi as a QR code with the name and password', async () => {
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    fireEvent.click(screen.getByRole('button', { name: 'Share Home' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share "Home"' });
    expect(within(dialog).getByRole('img', { name: 'QR code to join Home' }).getAttribute('data-value')).toBe(
      'WIFI:T:WPA;S:Home;P:hunter22;;',
    );
    expect(dialog.textContent).toContain('hunter22');
    expect(within(dialog).getByRole('button', { name: 'Copy password' })).toBeTruthy();
  });

  it('lists the regulatory channels from iwinfo, marking DFS', async () => {
    resetRouter({ wireless: wrx() });
    renderApp('#/settings/wifi');
    await screen.findByText('netui-test');
    fireEvent.click(screen.getAllByRole('row').find((r) => r.textContent!.startsWith('5 GHz'))!);
    const drawer = await screen.findByRole('complementary', { name: '5 GHz radio' });
    await within(drawer).findByRole('option', { name: '100 (5500 MHz) · DFS' });
    const values = within(drawer).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('177');
    expect(values).not.toContain('13');
    expect(within(drawer).getByRole('option', { name: 'United States (US)' })).toBeTruthy();
    pick(drawer, 'Channel', '149');
    pick(drawer, 'Transmit power', 'medium');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.wireless!.radio0).toMatchObject({ channel: '149', txpower: '24', htmode: 'HE80', disabled: '0' });
    expect(router.configs.wireless!.radio1!.channel).toBe('1');
  });

  it('shows live state and channel utilisation when iwinfo reports no SSID', async () => {
    resetRouter({ wireless: wrx() });
    liveWrx();
    renderApp('#/settings/wifi');
    const row = (await screen.findByText('netui-test')).closest('tr')!;
    await within(row).findByText('Broadcasting');
    const radio5 = () => screen.getAllByRole('row').find((r) => r.textContent!.startsWith('5 GHz'))!;
    const radio2 = () => screen.getAllByRole('row').find((r) => r.textContent!.startsWith('2.4 GHz'))!;
    await waitFor(() => expect(radio5().textContent).toContain('7%'));
    await waitFor(() => expect(radio2().textContent).toContain('32%'));
    expect(radio5().textContent).toContain('-110 dBm');
  });

  it("counts an access point's stations under its WiFi, not under a router radio with the same ifname", async () => {
    resetRouter({ wireless: wrx() });
    liveWrx();
    const sta = (mac: string) => ({ mac, signal: -50, noise: -95, inactive: 0, rx: { rate: 866700, packets: 1 }, tx: { rate: 866700, packets: 1 } });
    // The AP's 5 GHz WiFi is phy1-ap0, which on the router is the 2.4 GHz one.
    router.overrides.push((c) => {
      if (c.object === 'netui.devices' && c.method === 'list') return { devices: [{ mac: '02:00:00:00:00:aa', name: 'Office AP', online: true, ip: '192.168.1.2' }] };
      if (c.object !== 'netui.devices' || c.method !== 'call') return undefined;
      const a = c.args as { object: string; method: string };
      const data =
        a.object === 'iwinfo' && a.method === 'devices'
          ? { devices: ['phy1-ap0'] }
          : a.object === 'iwinfo' && a.method === 'info'
            ? { phy: 'phy1', ssid: 'netui-test', mode: 'Master', channel: 36, frequency: 5180 }
            : a.object === 'iwinfo' && a.method === 'assoclist'
              ? { results: [sta('AA:BB:CC:00:00:01'), sta('AA:BB:CC:00:00:02')] }
              : undefined;
      return data && { status: 0, data };
    });
    renderApp('#/settings/wifi');
    const wlan = (await screen.findByText('netui-test')).closest('tr')!;
    await waitFor(() => expect(within(wlan).getAllByRole('cell')[5]!.textContent).toBe('2'));
    const radio2 = screen.getAllByRole('row').find((r) => r.textContent!.startsWith('2.4 GHz'))!;
    expect(within(radio2).getAllByRole('cell')[7]!.textContent).toBe('0');
  });

  it('adds a WiFi schedule entry and rebuilds the timers after applying', async () => {
    resetRouter({ wireless: wireless(), wifi_schedule: structuredClone(scheduleGet.values) });
    renderApp('#/settings/wifi');
    const card = (await screen.findByText('WiFi Schedule')).closest('section')!;
    expect(within(card).getByText('Businesshours').closest('tr')!.textContent).toContain('Weekdays');
    fireEvent.click(within(card).getByRole('button', { name: /Add/ }));
    const drawer = await screen.findByRole('complementary', { name: 'New WiFi Schedule' });
    type(drawer, 'Name', 'Night');
    fireEvent.click(within(drawer).getByRole('checkbox', { name: 'Saturday' }));
    type(drawer, 'WiFi on at', '06:30');
    fireEvent.click(within(drawer).getByRole('switch', { name: 'Turn off even with devices connected' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add Schedule' }));
    await applyReviewed();
    expect(router.configs.wifi_schedule!.Night).toMatchObject({
      '.type': 'entry',
      enabled: '1',
      daysofweek: 'Monday Tuesday Wednesday Thursday Friday Saturday',
      starttime: '06:30',
      stoptime: '23:00',
      forcewifidown: '1',
    });
    await waitFor(() =>
      expect(router.calls.filter((c) => c.object === 'file').map((c) => c.args)).toEqual([
        { command: '/usr/bin/wifi_schedule.sh', params: ['cron'] },
      ]),
    );
  });

  it('offers WiFi schedules and client steering to install when their packages are missing', async () => {
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    for (const title of ['WiFi Schedule', 'Client steering']) {
      const c = (await screen.findByRole('heading', { name: new RegExp(`^${title}\\s*Not installed`) })).closest('section') as HTMLElement;
      expect(within(c).getByRole('button', { name: 'Install' })).toBeTruthy();
    }
  });
});

describe('read-only users', () => {
  it('read configs without passwords, never through uci, and cannot share a WiFi password', async () => {
    resetRouter({ wireless: wireless() });
    renderApp('#/settings/wifi', fastDeps(), { readOnly: true });
    const home = (await screen.findByText('Home')).closest('tr')!;
    expect(router.calls.some((c) => c.object === 'uci')).toBe(false);
    expect(router.calls.some((c) => c.object === 'netui.config' && c.args.config === 'wireless')).toBe(true);
    fireEvent.click(within(home).getByRole('button', { name: /Share/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Only an admin/);
    expect(dialog.textContent).not.toContain('hunter22');
    expect(within(dialog).queryByRole('img')).toBeNull();
  });
});
