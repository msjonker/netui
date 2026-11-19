import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet } from '../api/types';
import type { UciOp } from '../api/uci';
import wdrPasswords from '../../test/fixtures/ubus/tl-wdr4300-v1/uci.get.wireless.passwords.json';
import wrxWireless from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.json';
import { deleteWlanOps, normalizeWifi, validateWlan, wlanDraft, wlanOps } from './wifi';
import { networkVids, passwordDevices, passwordOps, readPasswords, validatePasswords } from './wifiPasswords';

// The Lab AP (24.10.8) with two passwords besides the main one: "Smart plugs"
// on the IoT network (vid 10 -> netui_iot), and one LuCI-style password for
// a single device on both bands (an `iface` list).
const wdr = (wdrPasswords as UciGet).values as UciConfig;
const wrx = (wrxWireless as UciGet).values as UciConfig;

const added = (ops: UciOp[], type: string) => ops.filter((o): o is Extract<UciOp, { op: 'add' }> => o.op === 'add' && o.type === type);

describe('readPasswords', () => {
  it('reads labels, networks from wifi-vlan, and device limits', () => {
    expect(readPasswords(wdr, 'netui_default_radio0')).toEqual([
      { label: 'Smart plugs', key: 'iotpass123', network: 'netui_iot', mac: '00:00:00:00:00:00' },
      { label: '', key: 'lanpass123', network: '', mac: 'aa:bb:cc:00:11:22' },
    ]);
    expect(readPasswords(wdr, 'netui_default_radio1')).toEqual([{ label: '', key: 'lanpass123', network: '', mac: 'aa:bb:cc:00:11:22' }]);
    expect(passwordDevices(readPasswords(wdr, 'netui_default_radio0')[0]!)).toEqual([]);
    expect(passwordDevices(readPasswords(wdr, 'netui_default_radio0')[1]!)).toEqual(['aa:bb:cc:00:11:22']);
  });

  it('names a vid without a wifi-vlan as unknown', () => {
    const cfg = { ...wdr, tv: { ...wdr.tv!, vid: '11' } };
    expect(readPasswords(cfg, 'netui_default_radio0')[0]!.network).toBe('vlan:10');
  });

  it('puts them on the WiFi, marks bands that differ as mixed, and lists their sections', () => {
    const w = normalizeWifi(wdr).wlans.find((x) => x.ssid === 'netui-test')!;
    expect(w.passwords.map((p) => p.label)).toEqual(['Smart plugs', '']);
    expect(w.mixed).toBe(true);
    // `tl` covers both bands of this WiFi: removed with it.
    expect(w.passwordSections.sort()).toEqual(['tl', 'ts', 'tv']);
    expect(deleteWlanOps(w).map((o) => o.op === 'delete' && o.section)).toEqual([
      'netui_default_radio0',
      'netui_default_radio1',
      ...w.passwordSections,
    ]);
  });

  it('has none on a router without wifi-station sections', () => {
    expect(normalizeWifi(wrx).wlans.every((w) => w.passwords.length === 0 && w.passwordSections.length === 0)).toBe(true);
  });
});

describe('passwordOps', () => {
  const smart = { label: 'Smart plugs', key: 'iotpass123', network: 'netui_iot', mac: '00:00:00:00:00:00' };

  it('writes one station per band with a single iface, and a VLAN per network', () => {
    const ops = passwordOps(wrx, ['default_radio0', 'default_radio1'], [], [{ label: 'Smart plugs', key: 'iotpass123', network: 'iot' }], 'lan', {
      iot: 10,
    });
    expect(added(ops, 'wifi-vlan').map((o) => o.values)).toEqual([
      { iface: 'default_radio0', name: 'v10', network: 'iot', vid: '10' },
      { iface: 'default_radio1', name: 'v10', network: 'iot', vid: '10' },
    ]);
    expect(added(ops, 'wifi-station').map((o) => o.values)).toEqual([
      { iface: 'default_radio0', key: 'iotpass123', mac: '00:00:00:00:00:00', vid: '10', label: 'Smart plugs' },
      { iface: 'default_radio1', key: 'iotpass123', mac: '00:00:00:00:00:00', vid: '10', label: 'Smart plugs' },
    ]);
  });

  it('leaves out vid and VLAN for the WiFi own network, and numbers networks without a VLAN ID from 100', () => {
    const ops = passwordOps(
      wrx,
      ['default_radio0'],
      [],
      [
        { label: 'Guests', key: 'guestpass1', network: 'lan' },
        { label: 'Lab', key: 'labpass123', network: 'lab' },
      ],
      'lan',
    );
    expect(added(ops, 'wifi-station').map((o) => o.values.vid)).toEqual([undefined, '100']);
    expect(added(ops, 'wifi-vlan').map((o) => o.values)).toEqual([{ iface: 'default_radio0', name: 'v100', network: 'lab', vid: '100' }]);
  });

  it('changes nothing when the passwords are what the router has', () => {
    const own = readPasswords(wdr, 'netui_default_radio0');
    expect(passwordOps(wdr, ['netui_default_radio0'], [], [smart, own[1]!], 'lan')).toEqual([
      // `tl` covered both bands as a list: this band's copy gets a single iface.
      { op: 'set', config: 'wireless', section: 'tl', values: { iface: 'netui_default_radio0' } },
    ]);
  });

  it('edits in place, removes what is gone, and removes the sections of dropped bands', () => {
    const ops = passwordOps(wdr, ['netui_default_radio0'], ['netui_default_radio1'], [{ ...smart, key: 'newpass123' }], 'lan');
    // A dropped band takes its sections along; tl belongs to radio0 (first in its list) and is no longer wanted.
    expect(ops).toContainEqual({ op: 'set', config: 'wireless', section: 'ts', values: { key: 'newpass123' } });
    expect(ops).toContainEqual({ op: 'delete', config: 'wireless', section: 'tl' });
    expect(ops.filter((o) => o.op === 'add')).toEqual([]);
    expect(ops.some((o) => o.op === 'delete' && o.section === 'tv')).toBe(false);
  });

  it('removes the VLAN when no password uses its network any more', () => {
    const ops = passwordOps(wdr, ['netui_default_radio0'], [], [{ ...smart, network: '' }], 'lan');
    expect(ops).toContainEqual({ op: 'delete', config: 'wireless', section: 'tv' });
    expect(ops).toContainEqual({ op: 'unset', config: 'wireless', section: 'ts', options: ['vid'] });
  });

  it('keeps the vid of a network no wifi-vlan names', () => {
    const ops = passwordOps(wrx, ['default_radio0'], [], [{ label: 'Old', key: 'oldpass123', network: 'vlan:7' }], 'lan');
    expect(added(ops, 'wifi-station')[0]!.values.vid).toBe('7');
    expect(added(ops, 'wifi-vlan')).toEqual([]);
  });
});

describe('wlanOps with passwords', () => {
  const wlan = () => normalizeWifi(wrx).wlans.find((w) => w.ssid === 'netui-test')!;

  it('names a new band so its passwords can refer to it', () => {
    const w = wlan();
    const cfg: UciConfig = { ...wrx, radio2: { '.name': 'radio2', '.type': 'wifi-device', '.anonymous': false, '.index': 9, band: '6g' } };
    const d = { ...wlanDraft(w), radios: [...w.members.map((m) => m.radio), 'radio2'], passwords: [{ label: 'Kids', key: 'kidspass1', network: '' }] };
    const ops = wlanOps(d, w, cfg);
    const iface = added(ops, 'wifi-iface')[0]!;
    expect(iface.name).toBe('wifinet0');
    expect(added(ops, 'wifi-station').map((o) => o.values.iface)).toEqual([...w.members.map((m) => m.section), 'wifinet0']);
  });

  it('adds new bands anonymously and writes no password sections when there are none', () => {
    const w = wlan();
    const cfg: UciConfig = { ...wrx, radio2: { '.name': 'radio2', '.type': 'wifi-device', '.anonymous': false, '.index': 9, band: '6g' } };
    const ops = wlanOps({ ...wlanDraft(w), radios: [...w.members.map((m) => m.radio), 'radio2'] }, w, cfg);
    expect(added(ops, 'wifi-iface')[0]!.name).toBeUndefined();
    expect(ops.some((o) => o.op === 'add' && o.type !== 'wifi-iface')).toBe(false);
  });

  it('drops the sections of a band the WiFi leaves', () => {
    const w = normalizeWifi(wdr).wlans.find((x) => x.ssid === 'netui-test')!;
    const radio = w.members.find((m) => m.section === 'netui_default_radio0')!.radio;
    const ops = wlanOps({ ...wlanDraft(w), radios: [radio] }, w, wdr);
    expect(ops).toContainEqual({ op: 'delete', config: 'wireless', section: 'netui_default_radio1' });
  });

  it('turns the WiFi network into "same as WiFi" in the draft', () => {
    const w = normalizeWifi(wdr).wlans.find((x) => x.ssid === 'netui-test')!;
    expect(wlanDraft({ ...w, network: ['netui_iot'] }).passwords[0]!.network).toBe('');
  });
});

describe('validatePasswords', () => {
  const ctx = { security: 'psk2', key: 'mainpass1', network: 'lan', vlanOk: true };
  const p = { label: 'Kids', key: 'kidspass1', network: '' };

  it('accepts distinct WPA2 passwords with names', () => {
    expect(validatePasswords([p, { ...p, label: 'Plugs', key: 'plugpass1', network: 'iot' }], ctx)).toBeNull();
  });

  it('needs WPA2, a name, a valid and distinct password', () => {
    expect(validatePasswords([p], { ...ctx, security: 'sae-mixed' })).toMatch(/WPA2/);
    expect(validatePasswords([{ ...p, label: ' ' }], ctx)).toMatch(/name/);
    expect(validatePasswords([{ ...p, key: 'short' }], ctx)).toMatch(/8 to 63/);
    expect(validatePasswords([{ ...p, key: 'mainpass1' }], ctx)).toMatch(/different/);
    expect(validatePasswords([p, { ...p, label: 'Two' }], ctx)).toMatch(/different/);
  });

  it('refuses another network where the hardware cannot do it', () => {
    expect(validatePasswords([{ ...p, network: 'iot' }], { ...ctx, vlanOk: false })).toMatch(/hardware/);
    expect(validatePasswords([{ ...p, network: 'lan' }], { ...ctx, vlanOk: false })).toBeNull();
  });

  it('is part of validateWlan', () => {
    const w = normalizeWifi(wrx).wlans[0]!;
    const d = { ...wlanDraft(w), security: 'psk2' as const, key: 'mainpass1', passwords: [{ ...p, network: 'iot' }] };
    expect(validateWlan(d, [], { vlanOk: false })).toMatch(/hardware/);
    expect(validateWlan(d, [], { vlanOk: true })).toBeNull();
  });
});

describe('networkVids', () => {
  it('reads the VLAN ID from the device name', () => {
    expect(networkVids([{ id: 'lan', device: 'br-lan.1' }, { id: 'iot', device: 'br-lan.10' }, { id: 'wan', device: 'wan' }, { id: 'x' }])).toEqual({
      lan: 1,
      iot: 10,
    });
  });
});
