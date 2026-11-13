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

  it('hides the schedule card without the wifischedule package', async () => {
    renderApp('#/settings/wifi');
    await screen.findByText('Home');
    expect(screen.queryByText('WiFi Schedule')).toBeNull();
  });
});
