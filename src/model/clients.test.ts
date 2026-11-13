import { describe, expect, it } from 'vitest';
import { fixtures, vmFixtures } from '../../test/fixtures';
import vmLeases from '../../test/fixtures/ubus/vm/vlan/luci-rpc.getDHCPLeases.json';
import type { AssocStation } from '../api/types';
import {
  clientAddresses,
  clientKind,
  clientSettings,
  isOffline,
  withRadioInfo,
  clientSettingsOps,
  matchesFilter,
  mergeClients,
  validateClientSettings,
  type ClientSources,
} from './clients';
import { normalizeBlockRules } from './firewall';
import { localSubnets, routerMacs } from './network';

const subnets = [{ network: 'lan', address: '10.231.1.0', prefix: 24, gateway: '10.231.1.2' }];

function sources(extra: Partial<ClientSources> = {}): ClientSources {
  return {
    leases: fixtures.leases(),
    hints: fixtures.hints(),
    dhcp: fixtures.uci.dhcp(),
    blocks: normalizeBlockRules(fixtures.uci.firewall()),
    routerMacs: routerMacs(fixtures.deviceStatus()),
    subnets,
    ...extra,
  };
}

// Shape taken from iwinfo assoclist; see test/fixtures/ubus/README.md.
function station(mac: string, over: Partial<AssocStation> = {}): AssocStation {
  return {
    mac,
    signal: -52,
    noise: -95,
    inactive: 10,
    connected_time: 600,
    rx: { rate: 144400, packets: 10, bytes: 2000 },
    tx: { rate: 86700, packets: 5, bytes: 1000 },
    ...over,
  };
}

describe('mergeClients (recorded fixtures)', () => {
  const clients = mergeClients(sources());
  const byMac = new Map(clients.map((c) => [c.mac, c]));

  it('merges uppercase lease and hint MACs into one lowercase client', () => {
    const laptop = byMac.get('02:4e:55:00:01:10')!;
    expect(laptop).toMatchObject({
      name: 'laptop', // reservation name wins
      ip: '10.231.1.128', // the lease, not the reservation, is the current address
      leaseExpires: fixtures.leases().dhcp_leases.find((l) => l.hostname === 'laptop')!.expires,
      network: 'lan',
      reservation: { section: 'cfg05fe63', name: 'laptop', ip: '10.231.1.50' },
      randomMac: true,
    });
    expect(clients.filter((c) => c.mac === '02:4e:55:00:01:10')).toHaveLength(1);
  });

  it('names a lease without a hostname from the host part of the host hint', () => {
    expect(byMac.get('da:a1:19:00:01:11')).toMatchObject({
      name: 'netui-client-phone',
      ip: '10.231.1.192',
    });
  });

  it('attaches the block rule, disabled in the fixture', () => {
    expect(byMac.get('da:a1:19:00:01:11')!.block).toMatchObject({ enabled: false, managed: true });
  });

  it('excludes the router itself and hosts outside local subnets', () => {
    expect(byMac.has('02:4e:55:00:01:02')).toBe(false); // router LAN
    expect(byMac.has('02:4e:55:00:00:02')).toBe(false); // router WAN
    expect(byMac.has('ae:3d:8c:24:1e:4a')).toBe(false); // WAN gateway, 10.231.0.1
  });

  it('includes a neighbour on the LAN that has no lease', () => {
    const host = byMac.get('9a:3d:59:1b:de:92')!;
    expect(host.ip).toBe('10.231.1.1');
    expect(host.leaseExpires).toBeUndefined();
  });
});

describe('mergeClients (wireless)', () => {
  it('attaches the association with rates in Mbit/s', () => {
    const [c] = mergeClients({
      assoc: [{ ifname: 'phy0-ap0', ssid: 'home', band: '5 GHz', stations: [station('AA:BB:CC:00:00:01')] }],
    });
    expect(c).toMatchObject({
      mac: 'aa:bb:cc:00:00:01',
      wireless: { ifname: 'phy0-ap0', ssid: 'home', band: '5 GHz', signal: -52, rxRate: 144.4, txRate: 86.7 },
    });
    expect(matchesFilter(c!, 'wireless')).toBe(true);
    expect(matchesFilter(c!, 'wired')).toBe(false);
  });

  it('merges an associated station with its lease', () => {
    const clients = mergeClients({
      ...sources(),
      assoc: [{ ifname: 'phy1-ap0', stations: [station('da:a1:19:00:01:11')] }],
    });
    const phone = clients.find((c) => c.mac === 'da:a1:19:00:01:11')!;
    expect(phone.wireless?.ifname).toBe('phy1-ap0');
    expect(phone.ip).toBe('10.231.1.192');
  });

  it('ignores malformed MACs instead of merging them under a shared key', () => {
    const clients = mergeClients({
      leases: { dhcp_leases: [{ macaddr: 'garbage', ipaddr: '10.0.0.9', expires: 1 }], dhcp6_leases: [] },
    });
    expect(clients).toEqual([]);
  });
});

describe('matchesFilter', () => {
  it('puts enabled blocks under Blocked only', () => {
    const [c] = mergeClients({
      blocks: [{ section: 'x', macs: ['aa:bb:cc:00:00:02'], enabled: true, managed: true, name: '' }],
    });
    expect(matchesFilter(c!, 'blocked')).toBe(true);
    expect(matchesFilter(c!, 'wired')).toBe(false);
  });
});

describe('client settings', () => {
  const dhcp = fixtures.uci.dhcp();
  const clients = mergeClients(sources());
  const laptop = clients.find((c) => c.mac === '02:4e:55:00:01:10')!;
  const other = clients.find((c) => !c.reservation && c.ip)!;

  it('reads the recorded reservation', () => {
    expect(clientSettings(laptop)).toEqual({ alias: 'laptop', fixedIp: true, ip: '10.231.1.50' });
    expect(clientSettings(other)).toEqual({ alias: '', fixedIp: false, ip: other.ip });
  });

  it('produces no ops when unchanged', () => {
    expect(clientSettingsOps(clientSettings(laptop), laptop, dhcp)).toEqual([]);
    expect(clientSettingsOps(clientSettings(other), other, dhcp)).toEqual([]);
  });

  it('edits an existing reservation in place', () => {
    expect(clientSettingsOps({ alias: 'laptop', fixedIp: false, ip: '' }, laptop, dhcp)).toEqual([
      { op: 'unset', config: 'dhcp', section: 'cfg05fe63', options: ['ip'] },
    ]);
    expect(clientSettingsOps({ alias: '', fixedIp: false, ip: '' }, laptop, dhcp)).toEqual([
      { op: 'delete', config: 'dhcp', section: 'cfg05fe63' },
    ]);
  });

  it('adds a host section with the MAC as an uppercase list, as recorded', () => {
    expect(clientSettingsOps({ alias: 'tv', fixedIp: true, ip: '10.231.1.60' }, other, dhcp)).toEqual([
      { op: 'add', config: 'dhcp', type: 'host', values: { mac: [other.mac.toUpperCase()], name: 'tv', ip: '10.231.1.60' } },
    ]);
  });

  it('validates alias and address', () => {
    const v = (s: Partial<ReturnType<typeof clientSettings>>) =>
      validateClientSettings({ alias: '', fixedIp: true, ip: '10.231.1.60', ...s }, other, subnets, dhcp);
    expect(v({})).toBeNull();
    expect(v({ alias: 'living room' })).toMatch(/DNS name/);
    expect(v({ ip: '10.231.1' })).toMatch(/IPv4/);
    expect(v({ ip: '192.168.9.9' })).toMatch(/not in any local network/);
    expect(v({ ip: '10.231.1.2' })).toMatch(/router/);
    expect(v({ ip: '10.231.1.50' })).toMatch(/reserved for laptop/);
    expect(validateClientSettings({ alias: 'laptop', fixedIp: true, ip: '10.231.1.50' }, laptop, subnets, dhcp)).toBeNull();
  });

  it('keeps one client for a MAC leasing on two VLANs, with both addresses', () => {
    const vm = vmFixtures('vlan');
    const clients = mergeClients({
      leases: vmLeases,
      routerMacs: routerMacs(vm.deviceStatus()),
      subnets: localSubnets(vm.uci.network(), vm.uci.firewall(), vm.ifaceDump()),
    });
    expect(clients).toEqual([
      expect.objectContaining({
        mac: '52:54:00:23:02:00',
        name: 'vmclient',
        ip: '10.232.1.107',
        network: 'lan',
        otherAddresses: [{ ip: '10.232.20.107', network: 'iot' }],
      }),
    ]);
  });
});

describe('client details', () => {
  it('keeps inactivity and IPv6 hints, and adds channel and width from the serving radio', () => {
    const [c] = withRadioInfo(
      mergeClients({
        assoc: [{ ifname: 'phy0-ap0', ssid: 'home', band: '5 GHz', stations: [station('aa:bb:cc:00:00:01', { inactive: 1200 })] }],
        hints: { 'AA:BB:CC:00:00:01': { ipaddrs: [], ip6addrs: ['fd00::5'] } },
      }),
      [{ ifname: 'phy0-ap0', info: { channel: 36, htmode: 'HE80' } }],
    );
    expect(c!.wireless).toMatchObject({ inactive: 1200, channel: 36, htmode: 'HE80' });
    expect(c!.ip6).toEqual(['fd00::5']);
    expect(clientAddresses(c!)).toEqual(['fd00::5']);
  });

  it('files known clients without a lease, association or connections under Offline', () => {
    const clients = mergeClients(sources());
    // The dev host's bridge: a host hint on the LAN, no lease.
    const hinted = clients.find((c) => c.mac === '9a:3d:59:1b:de:92')!;
    const leased = clients.find((c) => c.mac === '02:4e:55:00:01:10')!;
    expect(isOffline(hinted)).toBe(true);
    expect(matchesFilter(hinted, 'offline')).toBe(true);
    expect(matchesFilter(hinted, 'wired')).toBe(false);
    expect(matchesFilter({ ...hinted, active: true }, 'wired')).toBe(true);
    expect(matchesFilter(leased, 'offline')).toBe(false);
    expect(clientAddresses(leased)).toEqual(['10.231.1.128']);
  });

  it('derives a device type from the name first, then from the OUI vendor', () => {
    const c = (name: string | undefined, mac = '02:00:00:00:00:01') => clientKind({ mac, name, randomMac: true });
    expect(c('Johns-iPhone')).toBe('phone');
    expect(c('DESKTOP-4KQ2M1L')).toBe('computer');
    expect(c('LGwebOSTV')).toBe('tv');
    expect(c('ESP_3A1F2B')).toBe('iot');
    expect(c('SonosZP')).toBe('speaker');
    expect(c(undefined, 'b8:27:eb:00:00:01')).toBe('computer'); // Raspberry Pi by OUI
    expect(c('unknown-thing')).toBeUndefined();
  });
});
