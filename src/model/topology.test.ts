import { describe, expect, it } from 'vitest';
import type { AssocStation, DhcpLeases, HostHints, IwinfoInfo } from '../api/types';
import wrxLeases from '../../test/fixtures/ubus/dl-wrx36/plain/luci-rpc.getDHCPLeases.json';
import wrxHints from '../../test/fixtures/ubus/dl-wrx36/plain/luci-rpc.getHostHints.json';
import wrxInfo0 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy0-ap0.json';
import wrxInfo1 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy1-ap0.json';
import { fixtures, wrxFixtures } from '../../test/fixtures';
import { mergeClients } from './clients';
import { findUplink, localSubnets, normalizeSystem, routerMacs } from './network';
import { normalizeSwitch } from './ports';
import { buildTopology, channelWidth, isPresent } from './topology';
import { normalizeWifi } from './wifi';

const leases: DhcpLeases = wrxLeases;
const hints: HostHints = wrxHints;
const info0: IwinfoInfo = wrxInfo0;
const info1: IwinfoInfo = wrxInfo1;

const PHONE = '3a:7c:12:9e:44:01';

// Shape taken from iwinfo assoclist; see test/fixtures/ubus/README.md.
const station: AssocStation = {
  mac: PHONE.toUpperCase(),
  signal: -61,
  noise: -105,
  inactive: 100,
  connected_time: 300,
  rx: { rate: 400000, packets: 10, bytes: 2000 },
  tx: { rate: 600000, packets: 5, bytes: 1000 },
};

function wrxTopology(stations: AssocStation[] = []) {
  const wrx = wrxFixtures('plain');
  const network = wrx.uci.network();
  const firewall = wrx.uci.firewall();
  const devices = wrx.deviceStatus();
  const subnets = localSubnets(network, firewall, wrx.ifaceDump());
  const wifi = normalizeWifi(wrx.uci.wireless(), [
    { ifname: 'phy0-ap0', info: info0, stations },
    { ifname: 'phy1-ap0', info: info1, stations: [] },
  ]);
  const clients = mergeClients({ leases, hints, dhcp: wrx.uci.dhcp(), assoc: wifi.assoc, routerMacs: routerMacs(devices), subnets });
  return buildTopology({
    system: normalizeSystem(wrx.systemBoard(), wrx.systemInfo()),
    uplink: findUplink(wrx.ifaceDump()),
    sw: normalizeSwitch(network, firewall, devices, wrx.board()),
    wifi,
    clients,
  });
}

describe('buildTopology on the DL-WRX36', () => {
  it('lays out gateway, ports with WAN first, and both radios', () => {
    const t = wrxTopology();
    expect(t.gateway).toMatchObject({ model: 'Dynalink DL-WRX36' });
    // WAN unplugged: no default route.
    expect(t.internet.online).toBe(false);
    expect(t.ports.map((p) => p.label)).toEqual(['WAN', 'lan1', 'lan2', 'lan3', 'lan4']);
    expect(t.ports.find((p) => p.name === 'lan1')).toMatchObject({ carrier: true, speed: 1000, role: 'lan' });
    expect(t.radios).toEqual([
      expect.objectContaining({ section: 'radio0', band: '5 GHz', channel: '36', width: '80 MHz', ssids: ['netui-test'] }),
      expect.objectContaining({ section: 'radio1', band: '2.4 GHz', channel: '1', width: '20 MHz', ssids: ['netui-test'] }),
    ]);
  });

  it('puts the wired client under LAN and leaves the router itself out', () => {
    const t = wrxTopology();
    expect(t.wired).toEqual([
      {
        network: 'lan',
        label: 'LAN',
        clients: [{ mac: '00:00:5e:00:53:01', name: 'workstation', ip: '192.168.1.137', signal: undefined, ssid: undefined }],
      },
    ]);
  });

  it('hangs wireless clients off their radio with signal, even without an SSID from iwinfo', () => {
    const t = wrxTopology([station]);
    expect(t.radios[0]!.clients).toEqual([expect.objectContaining({ mac: PHONE, signal: -61 })]);
    expect(t.radios[1]!.clients).toEqual([]);
    expect(t.otherWireless).toEqual([]);
    expect(t.wired[0]!.clients.map((c) => c.mac)).not.toContain(PHONE);
  });
});

describe('buildTopology on the dev container', () => {
  it('works with no radios and an online uplink', () => {
    const devices = fixtures.deviceStatus();
    const network = fixtures.uci.network();
    const firewall = fixtures.uci.firewall();
    const subnets = localSubnets(network, firewall, fixtures.ifaceDump());
    const clients = mergeClients({
      leases: fixtures.leases(),
      hints: fixtures.hints(),
      dhcp: fixtures.uci.dhcp(),
      routerMacs: routerMacs(devices),
      subnets,
    });
    const t = buildTopology({
      system: normalizeSystem(fixtures.systemBoard(), fixtures.systemInfo()),
      uplink: findUplink(fixtures.ifaceDump()),
      sw: normalizeSwitch(network, firewall, devices, fixtures.board()),
      clients,
    });
    expect(t.internet.online).toBe(true);
    expect(t.radios).toEqual([]);
    expect(t.ports.length).toBeGreaterThan(0);
    expect(t.wired.flatMap((g) => g.clients.map((c) => c.name))).toContain('laptop');
    // Every present client is placed exactly once.
    expect(t.wired.flatMap((g) => g.clients)).toHaveLength(clients.filter(isPresent).length);
  });
});

describe('helpers', () => {
  it('reads the channel width from htmode', () => {
    expect(channelWidth('HE80')).toBe('80 MHz');
    expect(channelWidth('VHT160')).toBe('160 MHz');
    expect(channelWidth('HT40+')).toBe('40 MHz');
    expect(channelWidth('NOHT')).toBeUndefined();
    expect(channelWidth(undefined)).toBeUndefined();
  });

  it('does not count a bare reservation as present', () => {
    expect(isPresent({ mac: 'a', randomMac: false, ip: '10.0.0.5', reservation: { section: 's', ip: '10.0.0.5' } })).toBe(false);
    expect(isPresent({ mac: 'a', randomMac: false, ip: '10.0.0.5', leaseExpires: 100 })).toBe(true);
  });
});
