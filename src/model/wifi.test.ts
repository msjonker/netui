import { describe, expect, it } from 'vitest';
import type { IwinfoInfo, UciConfig, UciGet } from '../api/types';
import { wireless } from '../../test/wireless';
import { diffSection } from '../api/uci';
import wrxWireless from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.json';
import wrxInfo5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy0-ap0.json';
import wrxInfo2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy1-ap0.json';
import wrxFresh from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.fresh.json';
import tlWireless from '../../test/fixtures/ubus/tl-wr1043nd-v2/uci.get.wireless.bss_transition.json';
import tlInfo from '../../test/fixtures/ubus/tl-wr1043nd-v2/iwinfo.info.phy0-ap0.bss_transition.json';
import {
  bssTransitionBlock,
  bssTransitionOffOps,
  effectivePmf,
  ifaceSettings,
  isolatedNetworks,
  wifiQrPayload,
  frequencyBand,
  newWlanDraft,
  normalizeWifi,
  radiosToTurnOn,
  radioDraft,
  radioOps,
  securityOf,
  validateRadio,
  validateWlan,
  widthOptions,
  wlanDraft,
  wlanOps,
  wlanValues,
} from './wifi';

// The iwinfo info shape below is a stand-in until hwsim recordings exist in
// test/fixtures/ubus/dev-container/.

const info = (ssid: string, frequency: number, channel: number): IwinfoInfo => ({ phy: 'phy0', ssid, mode: 'Master', frequency, channel });

describe('normalizeWifi', () => {
  it('groups ap sections by SSID and skips other modes', () => {
    const { wlans } = normalizeWifi(wireless());
    expect(wlans.map((w) => [w.ssid, w.members.map((m) => m.bandLabel)])).toEqual([
      ['Home', ['2.4 GHz', '5 GHz']],
      ['Guest', ['2.4 GHz']],
    ]);
    expect(wlans[0]).toMatchObject({ security: 'sae-mixed', key: 'hunter22', network: ['lan'], enabled: true, hidden: false });
    expect(wlans[1]).toMatchObject({ security: 'none', enabled: false });
  });

  it('reads radios, including legacy hwmode', () => {
    const w = wireless();
    delete w.radio1!.band;
    w.radio1!.hwmode = '11a';
    const { radios } = normalizeWifi(w);
    expect(radios).toEqual([
      expect.objectContaining({ section: 'radio0', band: '2g', channel: '6', htmode: 'HT20', country: 'US', enabled: true }),
      expect.objectContaining({ section: 'radio1', band: '5g', channel: 'auto', txpower: 17 }),
    ]);
  });

  it('matches live devices to members by SSID and band', () => {
    const { wlans, radios, assoc } = normalizeWifi(wireless(), [
      { ifname: 'phy1-ap0', info: info('Home', 5180, 36), stations: [] },
      { ifname: 'phy0-ap0', info: info('Home', 2437, 6), stations: [{ mac: 'AA:BB:CC:00:00:01', signal: -50, noise: -95, inactive: 0, rx: { rate: 1000, packets: 1 }, tx: { rate: 1000, packets: 1 } }] },
    ]);
    expect(wlans[0]!.members.map((m) => m.ifname)).toEqual(['phy0-ap0', 'phy1-ap0']);
    expect(wlans[1]!.members[0]!.ifname).toBeUndefined();
    expect(radios[1]!.live).toEqual({ channel: 36, frequency: 5180, txpower: undefined });
    expect(assoc).toEqual([{ ifname: 'phy0-ap0', ssid: 'Home', band: '2.4 GHz', stations: [expect.objectContaining({ signal: -50 })] }]);
  });

  it('treats members of a disabled radio as not live', () => {
    const w = wireless();
    w.radio0!.disabled = '1';
    const { wlans } = normalizeWifi(w, [{ ifname: 'phy0-ap0', info: info('Home', 2437, 6) }]);
    expect(wlans[0]!.members[0]!.ifname).toBeUndefined();
  });
});

describe('wifi helpers', () => {
  it('maps frequency to band', () => {
    expect([2412, 5180, 5955, 60480, undefined].map(frequencyBand)).toEqual(['2g', '5g', '6g', '60g', undefined]);
  });

  it('reads security with cipher suffixes', () => {
    expect(['psk2+ccmp', 'sae', 'none', 'wpa2+ccmp', ''].map(securityOf)).toEqual(['psk2', 'sae', 'none', 'other', 'none']);
  });

  it('round-trips a group through draft and values with no changes', () => {
    const w = wireless();
    const [home] = normalizeWifi(w).wlans;
    for (const m of home!.members) {
      expect(diffSection('wireless', m.section, w[m.section], wlanValues(wlanDraft(home!), w[m.section]))).toEqual([]);
    }
  });

  it('keeps an encryption it cannot edit', () => {
    const w = wireless();
    w.home2!.encryption = 'wpa2+ccmp';
    const [home] = normalizeWifi(w).wlans;
    expect(wlanValues(wlanDraft(home!), w.home2).encryption).toBe('wpa2+ccmp');
  });

  it('drops the key for an open network', () => {
    const [home] = normalizeWifi(wireless()).wlans;
    const ops = diffSection('wireless', 'home2', wireless().home2, wlanValues({ ...wlanDraft(home!), security: 'none' }, wireless().home2));
    expect(ops).toEqual([
      { op: 'set', config: 'wireless', section: 'home2', values: { encryption: 'none' } },
      { op: 'unset', config: 'wireless', section: 'home2', options: ['key'] },
    ]);
  });

  it('validates drafts', () => {
    const { wlans } = normalizeWifi(wireless());
    const d = wlanDraft(wlans[0]!);
    expect(validateWlan(d, [])).toBeNull();
    expect(validateWlan({ ...d, key: 'short' }, [])).toMatch(/8 to 63/);
    expect(validateWlan(d, wlans.slice(0, 1))).toMatch(/already exists/);
    expect(validateWlan({ ...d, radios: [] }, [])).toMatch(/band/);
    expect(validateWlan({ ...d, ssid: 'x'.repeat(33) }, [])).toMatch(/32 bytes/);
    expect(validateWlan({ ...d, security: 'none', key: '' }, [])).toBeNull();
  });

  it('offers channel widths in the radio family', () => {
    expect(widthOptions('2g', 'HT20').map((o) => o.value)).toEqual(['HT20', 'HT40']);
    expect(widthOptions('5g', 'HE80').map((o) => o.value)).toEqual(['HE20', 'HE40', 'HE80', 'HE160']);
    expect(widthOptions('5g', undefined).map((o) => o.value)).toEqual(['VHT20', 'VHT40', 'VHT80', 'VHT160']);
  });
});

describe('wifi ops', () => {
  it('edits kept bands, deletes dropped ones and adds new ones', () => {
    const w = wireless();
    const [home, guest] = normalizeWifi(w).wlans;
    expect(wlanOps({ ...wlanDraft(home!), radios: ['radio1'] }, home, w)).toEqual([
      { op: 'delete', config: 'wireless', section: 'home2' },
    ]);
    expect(wlanOps({ ...wlanDraft(guest!), radios: ['radio0', 'radio1'] }, guest, w)).toEqual([
      {
        op: 'add',
        config: 'wireless',
        type: 'wifi-iface',
        values: { device: 'radio1', mode: 'ap', ssid: 'Guest', network: 'guest', encryption: 'none', disabled: '1' },
      },
    ]);
  });

  it('creates a new SSID on every chosen band', () => {
    const d = { ...newWlanDraft(['radio0'], 'lan'), ssid: 'IoT', hidden: true, security: 'psk2' as const, key: 'longenough', bssTransition: false };
    expect(wlanOps(d, undefined, wireless())).toEqual([
      {
        op: 'add',
        config: 'wireless',
        type: 'wifi-iface',
        values: { device: 'radio0', mode: 'ap', ssid: 'IoT', network: 'lan', encryption: 'psk2', key: 'longenough', hidden: '1' },
      },
    ]);
  });

  it('round-trips radios and writes only what changed', () => {
    const w = wireless();
    const [r0, r1] = normalizeWifi(w).radios;
    expect(radioOps(radioDraft(r0!), r0!, w)).toEqual([]);
    expect(radioOps(radioDraft(r1!), r1!, w)).toEqual([]);
    expect(radioOps({ ...radioDraft(r1!), channel: '149', txpower: '' }, r1!, w)).toEqual([
      { op: 'set', config: 'wireless', section: 'radio1', values: { channel: '149' } },
      { op: 'unset', config: 'wireless', section: 'radio1', options: ['txpower'] },
    ]);
    expect(validateRadio({ ...radioDraft(r0!), country: 'us' })).toMatch(/two-letter/);
  });
});

// ---------------------------------------------------------------------------
// The DL-WRX36's real config: radio0 = 5 GHz, radio1 = 2.4 GHz, "netui-test"
// WPA2 on both.

const wrxGet: UciGet = wrxWireless;
const wrx = (): UciConfig => structuredClone(wrxGet.values);
const live5: IwinfoInfo = wrxInfo5;
const live2: IwinfoInfo = wrxInfo2;
const wrxLive = [
  { ifname: 'phy0-ap0', info: live5 },
  { ifname: 'phy1-ap0', info: live2 },
];

describe('DL-WRX36 wireless', () => {
  it('pairs both bands into one WiFi and maps radios to their live interfaces', () => {
    const { wlans, radios } = normalizeWifi(wrx(), wrxLive);
    expect(wlans).toHaveLength(1);
    expect(wlans[0]).toMatchObject({
      ssid: 'netui-test',
      security: 'psk2',
      mixed: false,
      isolate: false,
      pmf: 'off',
      fastRoaming: false,
      bssTransition: false,
      maxClients: '',
    });
    expect(wlans[0]!.members.map((m) => [m.radio, m.bandLabel, m.ifname])).toEqual([
      ['radio0', '5 GHz', 'phy0-ap0'],
      ['radio1', '2.4 GHz', 'phy1-ap0'],
    ]);
    expect(radios.map((r) => [r.section, r.band, r.ifname, r.live?.noise])).toEqual([
      ['radio0', '5g', 'phy0-ap0', -110],
      ['radio1', '2g', 'phy1-ap0', -105],
    ]);
  });

  it('round-trips without writing anything', () => {
    const w = wrx();
    const [net] = normalizeWifi(w).wlans;
    expect(wlanOps(wlanDraft(net!), net, w)).toEqual([]);
    const [r0, r1] = normalizeWifi(w).radios;
    expect([...radioOps(radioDraft(r0!), r0!, w), ...radioOps(radioDraft(r1!), r1!, w)]).toEqual([]);
  });

  it('switches to WPA3 without touching PMF, which OpenWrt forces to required', () => {
    const w = wrx();
    const [net] = normalizeWifi(w).wlans;
    const d = { ...wlanDraft(net!), security: 'sae' as const };
    expect(wlanOps(d, net, w)).toEqual([
      { op: 'set', config: 'wireless', section: 'default_radio0', values: { encryption: 'sae' } },
      { op: 'set', config: 'wireless', section: 'default_radio1', values: { encryption: 'sae' } },
    ]);
    expect(effectivePmf('sae', d.pmf)).toBe('required');
  });

  it('writes PMF for WPA2', () => {
    const w = wrx();
    const [net] = normalizeWifi(w).wlans;
    const ops = wlanOps({ ...wlanDraft(net!), pmf: 'required' }, net, w);
    expect(ops).toContainEqual({ op: 'set', config: 'wireless', section: 'default_radio0', values: { ieee80211w: '2' } });
    w.default_radio0!.ieee80211w = '2';
    expect(diffSection('wireless', 'default_radio0', w.default_radio0, wlanValues({ ...wlanDraft(net!), pmf: 'off' }, w.default_radio0))).toEqual([
      { op: 'unset', config: 'wireless', section: 'default_radio0', options: ['ieee80211w'] },
    ]);
  });

  it('turns on fast roaming over the air with a locally generated PMK for WPA2', () => {
    const w = wrx();
    const [net] = normalizeWifi(w).wlans;
    const ops = wlanOps({ ...wlanDraft(net!), fastRoaming: true, mobilityDomain: 'beef' }, net, w);
    expect(ops[0]).toEqual({
      op: 'set',
      config: 'wireless',
      section: 'default_radio0',
      values: { ieee80211r: '1', ft_over_ds: '0', ft_psk_generate_local: '1', mobility_domain: 'beef' },
    });
    expect(ops).toHaveLength(2);
  });

  it('leaves PMK generation to OpenWrt for SAE, and drops it when switching to SAE', () => {
    const d = { ...newWlanDraft(['radio0'], 'lan'), ssid: 'x', key: 'longenough', fastRoaming: true };
    expect(wlanValues(d, undefined, true)).toMatchObject({ ieee80211r: '1', ft_over_ds: '0', ft_psk_generate_local: '' });
    const w = wrx();
    Object.assign(w.default_radio0!, { ieee80211r: '1', ft_over_ds: '1', ft_psk_generate_local: '1' });
    const [net] = normalizeWifi(w).wlans;
    const ops = diffSection('wireless', 'default_radio0', w.default_radio0, wlanValues({ ...wlanDraft(net!), security: 'sae' }, w.default_radio0));
    // FT over DS chosen elsewhere is kept; only the PSK-only option goes.
    expect(ops).toEqual([
      { op: 'set', config: 'wireless', section: 'default_radio0', values: { encryption: 'sae' } },
      { op: 'unset', config: 'wireless', section: 'default_radio0', options: ['ft_psk_generate_local'] },
    ]);
  });

  it('writes isolation, BSS transition with 802.11k, multicast enhancement and max clients', () => {
    const w = wrx();
    const [net] = normalizeWifi(w).wlans;
    const d = { ...wlanDraft(net!), isolate: true, bssTransition: true, multicastEnhance: true, maxClients: '32' };
    expect(wlanOps(d, net, w)[0]).toEqual({
      op: 'set',
      config: 'wireless',
      section: 'default_radio0',
      values: { isolate: '1', bss_transition: '1', ieee80211k: '1', multicast_to_unicast_all: '1', maxassoc: '32' },
    });
    Object.assign(w.default_radio0!, { isolate: '1', bss_transition: '1', ieee80211k: '1', multicast_to_unicast: '1', maxassoc: '32' });
    const off = { ...d, isolate: false, bssTransition: false, multicastEnhance: false, maxClients: '' };
    expect(diffSection('wireless', 'default_radio0', w.default_radio0, wlanValues(off, w.default_radio0))).toEqual([
      { op: 'unset', config: 'wireless', section: 'default_radio0', options: ['isolate', 'bss_transition', 'multicast_to_unicast', 'maxassoc'] },
    ]);
  });

  it('flags bands whose settings differ', () => {
    const w = wrx();
    w.default_radio1!.isolate = '1';
    expect(normalizeWifi(w).wlans[0]!.mixed).toBe(true);
    expect(ifaceSettings(w.default_radio1!).isolate).toBe(true);
  });

  it('copies the other band\'s options to a newly added band, except per-device ones', () => {
    const w = wrx();
    Object.assign(w.default_radio0!, { ieee80211r: '1', macfilter: 'deny', maclist: ['00:11:22:33:44:55'], ifname: 'wl5' });
    delete w.default_radio1;
    const [net] = normalizeWifi(w).wlans;
    const ops = wlanOps({ ...wlanDraft(net!), radios: ['radio0', 'radio1'] }, net, w);
    expect(ops).toEqual([
      {
        op: 'add',
        config: 'wireless',
        type: 'wifi-iface',
        values: {
          device: 'radio1',
          mode: 'ap',
          ssid: 'netui-test',
          network: 'lan',
          encryption: 'psk2',
          key: 'REDACTED',
          ieee80211r: '1',
          ft_over_ds: '0',
          ft_psk_generate_local: '1',
          macfilter: 'deny',
          maclist: ['00:11:22:33:44:55'],
        },
      },
    ]);
  });

  it('sets a new country on every radio', () => {
    const w = wrx();
    const [r0] = normalizeWifi(w).radios;
    expect(radioOps({ ...radioDraft(r0!), country: 'DE' }, r0!, w)).toEqual([
      { op: 'set', config: 'wireless', section: 'radio0', values: { country: 'DE' } },
      { op: 'set', config: 'wireless', section: 'radio1', values: { country: 'DE' } },
    ]);
    expect(validateRadio({ ...radioDraft(r0!), country: '00' })).toBeNull();
  });
});

describe('wifi security and validation', () => {
  it('reads Enhanced Open and computes effective PMF', () => {
    expect(securityOf('owe')).toBe('owe');
    expect(['sae', 'owe', 'sae-mixed', 'none'].map((s) => effectivePmf(s as never, 'off'))).toEqual(['required', 'required', 'optional', 'off']);
    expect(effectivePmf('psk2', 'optional')).toBe('optional');
  });

  it('drops the key for Enhanced Open', () => {
    const d = { ...newWlanDraft(['radio0'], 'lan'), ssid: 'Cafe', security: 'owe' as const, key: 'leftover' };
    expect(wlanValues(d).key).toBe('');
    expect(validateWlan(d, [])).toBeNull();
  });

  it('validates advanced options, 6 GHz security and guest networks', () => {
    const base = { ...newWlanDraft(['radio0'], 'lan'), ssid: 'x', key: 'longenough' };
    const radios = normalizeWifi(wireless()).radios.map((r) => (r.section === 'radio0' ? { ...r, band: '6g' as const } : r));
    expect(validateWlan(base, [], { radios })).toMatch(/6 GHz/);
    expect(validateWlan({ ...base, security: 'sae' }, [], { radios })).toBeNull();
    expect(validateWlan({ ...base, maxClients: '0' }, [])).toMatch(/1 to 2007/);
    expect(validateWlan({ ...base, maxClients: '50' }, [])).toBeNull();
    expect(validateWlan({ ...base, fastRoaming: true, mobilityDomain: 'xyz1' }, [])).toMatch(/hexadecimal/);
    expect(validateWlan({ ...base, guest: true }, [], { isolated: ['guest'] })).toMatch(/isolated network/);
    expect(validateWlan({ ...base, guest: true }, [], { isolated: [] })).toMatch(/Create an isolated network/);
    expect(validateWlan({ ...base, guest: true, network: 'guest' }, [], { isolated: ['guest'] })).toBeNull();
  });

  it('finds networks in a firewall zone of their own', () => {
    const fw: UciConfig = {
      a: { '.anonymous': true, '.index': 0, '.name': 'a', '.type': 'zone', name: 'lan', network: ['lan', 'iot'] },
      b: { '.anonymous': true, '.index': 1, '.name': 'b', '.type': 'zone', name: 'wan', network: ['wan', 'wan6'] },
      c: { '.anonymous': true, '.index': 2, '.name': 'c', '.type': 'zone', name: 'guest', network: ['guest'] },
    };
    expect(isolatedNetworks(['lan', 'iot', 'guest', 'nozone'], fw)).toEqual(['guest']);
    expect(isolatedNetworks(['lan'], undefined)).toEqual([]);
  });

  it('builds the WIFI: QR payload with escaping', () => {
    expect(wifiQrPayload({ ssid: 'My;Net', security: 'sae-mixed', key: 'a\\b:c,"d', hidden: false })).toBe(
      'WIFI:T:WPA;S:My\\;Net;P:a\\\\b\\:c\\,\\"d;;',
    );
    expect(wifiQrPayload({ ssid: 'Cafe', security: 'none', key: '', hidden: true })).toBe('WIFI:T:nopass;S:Cafe;H:true;;');
    expect(wifiQrPayload({ ssid: 'Cafe', security: 'owe', key: '', hidden: false })).toBe('WIFI:T:nopass;S:Cafe;;');
  });
});

// ---------------------------------------------------------------------------
// A fresh install. 25.12 (recorded on the DL-WRX36) disables each "OpenWrt"
// network and leaves its radio on; 24.10's mac80211.uc writes the same
// sections with `disabled` on the radio instead, leaving the open network on.

const freshGet: UciGet = wrxFresh;
const fresh2410 = (): UciConfig => {
  const w = structuredClone(freshGet.values);
  for (const s of Object.values(w)) {
    if (s['.type'] === 'wifi-device') s.disabled = '1';
    else delete s.disabled;
  }
  return w;
};
const radioOn = (radio: string) => ({ op: 'unset', config: 'wireless', section: radio, options: ['disabled'] });
const placeholderOff = (section: string) => ({ op: 'set', config: 'wireless', section, values: { disabled: '1' } });

describe('fresh install', () => {
  it('reads an enabled network on radios that are off as radio off', () => {
    const { wlans } = normalizeWifi(fresh2410());
    expect(wlans).toEqual([expect.objectContaining({ ssid: 'OpenWrt', enabled: true, radioOff: true })]);
    expect(normalizeWifi(structuredClone(freshGet.values)).wlans[0]).toMatchObject({ enabled: false, radioOff: false });
  });

  it('turns the radios on for a new WiFi and keeps the open placeholder off (24.10)', () => {
    const w = fresh2410();
    const d = { ...newWlanDraft(['radio0', 'radio1'], 'lan'), ssid: 'Home', key: 'longenough' };
    const ops = wlanOps(d, undefined, w);
    expect(ops.filter((o) => o.op !== 'add')).toEqual([
      radioOn('radio0'),
      placeholderOff('default_radio0'),
      radioOn('radio1'),
      placeholderOff('default_radio1'),
    ]);
    expect(ops.filter((o) => o.op === 'add')).toHaveLength(2);
  });

  it('adds nothing for radios that are already on (25.12)', () => {
    const d = { ...newWlanDraft(['radio0', 'radio1'], 'lan'), ssid: 'Home', key: 'longenough' };
    expect(wlanOps(d, undefined, structuredClone(freshGet.values)).every((o) => o.op === 'add')).toBe(true);
  });

  it('turns the radios on when the placeholder itself is renamed, without switching it off', () => {
    const w = fresh2410();
    const [placeholder] = normalizeWifi(w).wlans;
    const d = { ...wlanDraft(placeholder!), ssid: 'Home', security: 'sae-mixed' as const, key: 'longenough' };
    const ops = wlanOps(d, placeholder, w);
    expect(ops).toContainEqual(radioOn('radio0'));
    expect(ops).toContainEqual(radioOn('radio1'));
    expect(ops.filter((o) => o.op === 'set' && o.values.disabled)).toEqual([]);
  });

  it('turns an unchanged WiFi on its radios that are all off', () => {
    const w = fresh2410();
    const [placeholder] = normalizeWifi(w).wlans;
    expect(radiosToTurnOn(wlanDraft(placeholder!), placeholder, w)).toEqual(['radio0', 'radio1']);
    expect(radiosToTurnOn({ ...wlanDraft(placeholder!), enabled: false }, placeholder, w)).toEqual([]);
  });

  it('leaves a radio turned off on purpose when a WiFi live on another band is edited', () => {
    const w = wireless();
    w.radio0!.disabled = '1';
    const [home, guest] = normalizeWifi(w).wlans;
    expect(home!.radioOff).toBe(false);
    expect(wlanOps({ ...wlanDraft(home!), key: 'newpassword' }, home, w)).toEqual([
      { op: 'set', config: 'wireless', section: 'home2', values: { key: 'newpassword' } },
      { op: 'set', config: 'wireless', section: 'home5', values: { key: 'newpassword' } },
    ]);
    // Switching a WiFi on, or adding it to the radio, is asking for it there.
    expect(radiosToTurnOn({ ...wlanDraft(guest!), enabled: true }, guest, w)).toEqual(['radio0']);
    expect(radiosToTurnOn({ ...wlanDraft(guest!), enabled: true, radios: ['radio0', 'radio1'] }, guest, w)).toEqual(['radio0']);
  });

  it('keeps the open placeholder off when a radio is turned on by hand', () => {
    const w = fresh2410();
    const r = normalizeWifi(w).radios[0]!;
    expect(radioOps({ ...radioDraft(r), enabled: true }, r, w)).toEqual([radioOn('radio0'), placeholderOff('default_radio0')]);
  });
});

// ---------------------------------------------------------------------------
// A router with hostapd's basic build (TL-WR1043ND v2, 25.12.6) and a WiFi
// with BSS transition on: hostapd rejected the config and started nothing,
// yet iwinfo still reports the SSID (from hostapd's config file).

describe('basic WiFi package', () => {
  const tl = (): UciConfig => structuredClone((tlWireless as UciGet).values);
  const live = (running?: boolean) => [{ ifname: 'phy0-ap0', info: tlInfo as IwinfoInfo, running }];

  it('is not live when hostapd is not running it, whatever iwinfo says', () => {
    expect(normalizeWifi(tl(), live()).wlans[0]!.members[0]!.ifname).toBe('phy0-ap0');
    expect(normalizeWifi(tl(), live(true)).wlans[0]!.members[0]!.ifname).toBe('phy0-ap0');
    const { wlans, radios } = normalizeWifi(tl(), live(false));
    expect(wlans[0]!.members[0]!.ifname).toBeUndefined();
    expect(radios[0]!.live).toBeUndefined();
  });

  it('finds WiFi networks with BSS transition on and turns it off, keeping 802.11k', () => {
    const w = tl();
    expect(bssTransitionBlock(w)).toEqual({ ssids: ['netui-test'], radios: ['radio0'], others: [] });
    expect(bssTransitionOffOps(w)).toEqual([{ op: 'unset', config: 'wireless', section: 'wifinet0', options: ['bss_transition'] }]);
    w.wifinet0!.disabled = '1';
    expect(bssTransitionBlock(w)).toBeUndefined();
  });

  it('names the other networks on a radio it keeps from starting', () => {
    // As on the DL-WRX36 with the basic package: one network with the option
    // takes down every network on its radio.
    const w = wireless();
    w.home5!.bss_transition = '1';
    w.guest!.bss_transition = '1'; // disabled: blocks nothing
    w.iot = { ...w.guest!, '.name': 'iot', device: 'radio1', ssid: 'IoT', disabled: '0', bss_transition: '0' };
    expect(bssTransitionBlock(w)).toEqual({ ssids: ['Home'], radios: ['radio1'], others: ['IoT'] });
  });

  it('creates new networks without BSS transition', () => {
    const d = { ...newWlanDraft(['radio0'], 'lan', false), ssid: 'Home', key: 'longenough' };
    const [add] = wlanOps(d, undefined, tl());
    expect(add).toMatchObject({ op: 'add', values: { ssid: 'Home' } });
    expect(add!.op === 'add' && add!.values).not.toHaveProperty('bss_transition');
    expect(newWlanDraft(['radio0'], 'lan').bssTransition).toBe(true);
  });
});
