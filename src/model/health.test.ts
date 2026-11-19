import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet, UciSection } from '../api/types';
import wrxFirewall from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import wrxWireless from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.json';
import wrxSystem from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.system.json';
import wrxUpnp from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.upnpd.json';
import wrxSqm from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.sqm.json';
import { allFindings, runChecks, summary, type HealthInput } from './health';

const values = (f: unknown): UciConfig => structuredClone((f as UciGet).values) as UciConfig;
const section = (name: string, type: string, v: Record<string, string | string[]>): UciSection => ({
  '.anonymous': false,
  '.index': 99,
  '.name': name,
  '.type': type,
  ...v,
});

function input(patch: Partial<HealthInput> = {}): HealthInput {
  const wireless = values(wrxWireless);
  // The fixture's keys are redacted; give them a good one.
  for (const s of Object.values(wireless)) if (s['.type'] === 'wifi-iface') s.key = 'correct horse battery';
  return {
    firewall: values(wrxFirewall),
    wireless,
    system: values(wrxSystem),
    upnpd: values(wrxUpnp),
    sqm: values(wrxSqm),
    rootPassword: true,
    protocol: 'https:',
    ...patch,
  };
}

const ids = (i: HealthInput) => allFindings(runChecks(i)).map((f) => f.id);
const find = (i: HealthInput, id: string) => allFindings(runChecks(i)).find((f) => f.id === id);

describe('runChecks', () => {
  it('finds nothing on the bench gateway as configured', () => {
    expect(ids(input())).toEqual([]);
    const s = summary(runChecks(input()));
    expect(s).toMatchObject({ risk: 0, warn: 0, info: 0 });
    expect(s.passed).toBe(runChecks(input()).length);
  });

  it('flags a missing root password and plain HTTP', () => {
    expect(ids(input({ rootPassword: false, protocol: 'http:' }))).toEqual(['root-password', 'http']);
    // Unknown (viewer login): no finding.
    expect(ids(input({ rootPassword: undefined }))).toEqual([]);
  });

  it('flags an open internet zone and fixes it with REJECT', () => {
    const fw = values(wrxFirewall);
    fw.cfg03dc81!.input = 'ACCEPT';
    fw.cfg03dc81!.forward = 'ACCEPT';
    const i = input({ firewall: fw });
    expect(ids(i)).toEqual(['wan-input:wan', 'wan-forward:wan']);
    expect(find(i, 'wan-input:wan')!.fix!.ops).toEqual([{ op: 'set', config: 'firewall', section: 'cfg03dc81', values: { input: 'REJECT' } }]);
  });

  it('flags input rules that open ssh or the web interface to the internet, not WireGuard', () => {
    const fw = values(wrxFirewall);
    fw.ssh = section('ssh', 'rule', { name: 'Allow-SSH', src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT' });
    fw.web = section('web', 'rule', { name: 'Web', src: 'wan', proto: 'tcp', dest_port: '8000-8100', target: 'ACCEPT', enabled: '0' });
    fw.all = section('all', 'rule', { name: 'Everything', src: 'wan', proto: 'tcp', target: 'ACCEPT' });
    fw.wg = section('wg', 'rule', { name: 'WireGuard', src: 'wan', proto: 'udp', dest_port: '51820', target: 'ACCEPT' });
    const i = input({ firewall: fw });
    expect(ids(i)).toEqual(['wan-rule:ssh', 'wan-rule:all']);
    expect(find(i, 'wan-rule:ssh')!.title).toBe('The internet can reach ssh on the router');
    expect(find(i, 'wan-rule:ssh')!.fix!.ops).toEqual([{ op: 'set', config: 'firewall', section: 'ssh', values: { enabled: '0' } }]);
  });

  it('checks WiFi: open, weak encryption, short or common keys, WPS', () => {
    const w = input().wireless!;
    w.default_radio0!.encryption = 'psk-mixed+tkip+ccmp';
    w.default_radio1!.encryption = 'psk-mixed+tkip+ccmp';
    w.default_radio1!.wps_pushbutton = '1';
    w.guest = section('guest', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'Cafe', encryption: 'none', network: 'lan' });
    w.iot = section('iot', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'Things', encryption: 'psk2', key: '12345678' });
    w.short = section('short', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'Short', encryption: 'sae', key: 'abc12345x' });
    w.off = section('off', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'Off', encryption: 'none', disabled: '1' });
    w.mesh = section('mesh', 'wifi-iface', { device: 'radio0', mode: 'mesh', mesh_id: 'm', encryption: 'none' });
    const i = input({ wireless: w });
    expect(ids(i).sort()).toEqual(['wifi-key:Short', 'wifi-key:Things', 'wifi-open:Cafe', 'wifi-weak:netui-test', 'wps:netui-test'].sort());
    expect(find(i, 'wifi-key:Things')!.severity).toBe('risk');
    expect(find(i, 'wifi-weak:netui-test')!.fix!.ops).toEqual([
      { op: 'set', config: 'wireless', section: 'default_radio0', values: { encryption: 'psk2+ccmp' } },
      { op: 'set', config: 'wireless', section: 'default_radio1', values: { encryption: 'psk2+ccmp' } },
    ]);
    expect(find(i, 'wps:netui-test')!.fix!.ops).toEqual([{ op: 'unset', config: 'wireless', section: 'default_radio1', options: ['wps_pushbutton'] }]);
  });

  it('skips networks on a radio that is off', () => {
    const w = input().wireless!;
    w.radio1!.disabled = '1';
    w.open = section('open', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'OpenWrt', encryption: 'none' });
    expect(ids(input({ wireless: w }))).toEqual([]);
  });

  it('checks that a guest zone cannot reach the LAN or the router', () => {
    const fw = values(wrxFirewall);
    fw.gz = section('gz', 'zone', { name: 'guest', network: ['guest'], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' });
    fw.gf = section('gf', 'forwarding', { src: 'guest', dest: 'lan' });
    fw.gw = section('gw', 'forwarding', { src: 'guest', dest: 'wan' });
    const i = input({ firewall: fw });
    expect(ids(i)).toEqual(['guest-zone:guest>lan', 'guest-router:guest']);
    expect(find(i, 'guest-zone:guest>lan')!.fix!.ops).toEqual([{ op: 'delete', config: 'firewall', section: 'gf' }]);
    // Blocking router access keeps DHCP and DNS.
    expect(find(i, 'guest-router:guest')!.fix!.ops.map((o) => o.op)).toEqual(['set', 'add', 'add']);
  });

  it('flags UPnP without secure mode', () => {
    const u = values(wrxUpnp);
    const s = Object.values(u).find((x) => x['.type'] === 'upnpd')!;
    s.enabled = '1';
    s.secure_mode = '0';
    const i = input({ upnpd: u });
    expect(ids(i)).toEqual(['upnp-secure']);
    expect(find(i, 'upnp-secure')!.fix!.ops).toEqual([{ op: 'set', config: 'upnpd', section: s['.name'], values: { secure_mode: '1' } }]);
  });

  it('flags hardware offloading only when something it would bypass is on', () => {
    const fw = values(wrxFirewall);
    Object.assign(fw.cfg01e63d!, { flow_offloading: '1', flow_offloading_hw: '1' });
    expect(ids(input({ firewall: fw, sqm: undefined }))).toEqual([]);
    fw.l = section('l', 'netui_limit', { mac: '00:11:22:33:44:55', download: '5' });
    const i = input({ firewall: fw, sqm: undefined });
    expect(ids(i)).toEqual(['hw-offload']);
    expect(find(i, 'hw-offload')!.title).toBe('Hardware offloading bypasses speed limits');
  });

  it('flags a clock without time servers', () => {
    const sys = values(wrxSystem);
    const ntp = Object.values(sys).find((x) => x['.type'] === 'timeserver')!;
    ntp.enabled = '0';
    const i = input({ system: sys });
    expect(ids(i)).toEqual(['ntp']);
    expect(find(i, 'ntp')!.fix!.ops).toEqual([{ op: 'unset', config: 'system', section: ntp['.name'], options: ['enabled'] }]);
  });

  it('notes a DMZ', () => {
    const fw = values(wrxFirewall);
    fw.d = section('d', 'redirect', { name: 'netui: DMZ', target: 'DNAT', src: 'wan', dest: 'lan', src_dport: '1-65535', dest_ip: '192.168.1.50' });
    expect(find(input({ firewall: fw }), 'dmz')).toMatchObject({ severity: 'info', title: '192.168.1.50 is exposed to the internet (DMZ)' });
  });
});
