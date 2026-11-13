import { describe, expect, it } from 'vitest';
import { fixtures, wrxFixtures } from '../../test/fixtures';
import {
  uplinkOnline,
  attachedSubnets,
  findUplink,
  localSubnets,
  networkLabel,
  normalizeNetworks,
  normalizePorts,
  normalizeSystem,
  parseLeasetime,
  parseSpeed,
  routerMacs,
  wanNetworks,
  writeAddress,
  moveDraft,
  networkDraft,
  networkOps,
  reservationsIn,
  validateNetwork,
} from './network';
import * as extras from './network';
import { FakeRouter, stageOn } from '../../test/fakeRouter';

describe('findUplink', () => {
  it('finds the interface with the default route', () => {
    expect(findUplink(fixtures.ifaceDump())).toEqual({
      name: 'wan',
      up: true,
      proto: 'static',
      device: 'eth1',
      address: '10.231.0.2',
      prefix: 24,
      gateway: '10.231.0.1',
      dns: ['1.1.1.1', '9.9.9.9'],
      uptime: expect.any(Number),
    });
  });

  it('falls back to "wan" when it is down with no route', () => {
    const dump = fixtures.ifaceDump();
    const wan = dump.interface.find((i) => i.interface === 'wan')!;
    wan.up = false;
    wan.route = [];
    expect(findUplink(dump)).toMatchObject({ name: 'wan', up: false, gateway: undefined });
  });
});

describe('wanNetworks', () => {
  it('reads the wan zone networks', () => {
    expect([...wanNetworks(fixtures.uci.firewall())]).toEqual(['wan', 'wan6']);
  });
});

describe('normalizeNetworks', () => {
  it('lists local networks with their DHCP pool and live state', () => {
    const nets = normalizeNetworks(
      fixtures.uci.network(),
      fixtures.uci.dhcp(),
      fixtures.uci.firewall(),
      fixtures.ifaceDump(),
    );
    expect(nets).toEqual([
      {
        id: 'lan',
        proto: 'static',
        device: 'br-lan',
        address: '10.231.1.2',
        prefix: 24,
        addressForm: 'cidr-list',
        extraAddresses: [],
        dhcp: { section: 'lan', enabled: true, start: 100, limit: 150, leasetime: '12h' },
        up: true,
        uptime: expect.any(Number),
      },
    ]);
  });

  it('reads the pre-25.x ipaddr + netmask form', () => {
    const network = fixtures.uci.network();
    network.lan!.ipaddr = '192.168.1.1';
    network.lan!.netmask = '255.255.255.0';
    const [lan] = normalizeNetworks(network, undefined, fixtures.uci.firewall(), undefined);
    expect(lan).toMatchObject({ address: '192.168.1.1', prefix: 24, addressForm: 'netmask' });
  });

  it('reads a single CIDR string', () => {
    const network = fixtures.uci.network();
    network.lan!.ipaddr = '192.168.1.1/16';
    const [lan] = normalizeNetworks(network, undefined, fixtures.uci.firewall(), undefined);
    expect(lan).toMatchObject({ address: '192.168.1.1', prefix: 16, addressForm: 'cidr' });
  });

  it('marks a pool with ignore=1 as disabled', () => {
    const dhcp = fixtures.uci.dhcp();
    dhcp.lan!.ignore = '1';
    const [lan] = normalizeNetworks(fixtures.uci.network(), dhcp, fixtures.uci.firewall(), undefined);
    expect(lan!.dhcp!.enabled).toBe(false);
  });
});

describe('localSubnets', () => {
  it('derives subnets from live addresses', () => {
    expect(localSubnets(fixtures.uci.network(), fixtures.uci.firewall(), fixtures.ifaceDump())).toEqual([
      { network: 'lan', address: '10.231.1.0', prefix: 24, gateway: '10.231.1.2' },
    ]);
  });
});

describe('writeAddress', () => {
  it('writes back in the form it was read', () => {
    expect(writeAddress({ addressForm: 'cidr-list', extraAddresses: ['10.0.0.1/8'] }, '192.168.5.1', 24)).toEqual({
      ipaddr: ['192.168.5.1/24', '10.0.0.1/8'],
    });
    expect(writeAddress({ addressForm: 'cidr', extraAddresses: [] }, '192.168.5.1', 24)).toEqual({
      ipaddr: '192.168.5.1/24',
    });
    expect(writeAddress({ addressForm: 'netmask', extraAddresses: [] }, '192.168.5.1', 23)).toEqual({
      ipaddr: '192.168.5.1',
      netmask: '255.255.254.0',
    });
  });
});

describe('ports', () => {
  it('lists ethernet ports with role and link speed', () => {
    const ports = normalizePorts(fixtures.deviceStatus(), findUplink(fixtures.ifaceDump()));
    expect(ports.map((p) => [p.name, p.role, p.carrier, p.speed, p.duplex])).toEqual([
      ['eth0', 'lan', true, 10000, 'full'],
      ['eth1', 'wan', true, 10000, 'full'],
    ]);
  });

  it('parses speed strings', () => {
    expect(parseSpeed('100H')).toEqual({ speed: 100, duplex: 'half' });
    expect(parseSpeed('-1')).toEqual({});
    expect(parseSpeed(undefined)).toEqual({});
  });

  it('collects router MACs in lowercase', () => {
    expect(routerMacs(fixtures.deviceStatus()).has('02:4e:55:00:01:02')).toBe(true);
  });
});

describe('normalizeSystem', () => {
  it('summarizes board and info', () => {
    const info = fixtures.systemInfo();
    const s = normalizeSystem(fixtures.systemBoard(), info);
    expect(s).toMatchObject({ hostname: 'netui-dev', version: '25.12.5', target: 'x86/64' });
    expect(s.memoryUsed).toBeCloseTo(1 - info.memory.available! / info.memory.total);
    expect(s.load1).toBeCloseTo(info.load[0] / 65536);
  });
});

describe('parseLeasetime', () => {
  it.each([
    ['12h', 43200],
    ['30m', 1800],
    ['2d', 172800],
    ['3600', 3600],
    ['infinite', null],
  ])('%s', (v, want) => expect(parseLeasetime(v)).toBe(want));
});

describe('network editing', () => {
  const load = () => {
    const network = fixtures.uci.network();
    const dhcp = fixtures.uci.dhcp();
    const [lan] = normalizeNetworks(network, dhcp, fixtures.uci.firewall(), undefined);
    return { network, dhcp, lan: lan! };
  };

  it('drafts the recorded lan', () => {
    expect(networkDraft(load().lan)).toEqual({
      address: '10.231.1.2',
      prefix: 24,
      dhcpEnabled: true,
      rangeStart: '10.231.1.100',
      rangeEnd: '10.231.1.249',
      leasetime: '12h',
    });
  });

  it('produces no ops when unchanged', () => {
    const { network, dhcp, lan } = load();
    expect(networkOps(networkDraft(lan), lan, network, dhcp)).toEqual([]);
  });

  it('moves the pool with the address and writes the CIDR list form', () => {
    const { network, dhcp, lan } = load();
    const d = moveDraft(networkDraft(lan), '192.168.50.1', 24);
    expect(d).toMatchObject({ rangeStart: '192.168.50.100', rangeEnd: '192.168.50.249' });
    expect(networkOps(d, lan, network, dhcp)).toEqual([
      { op: 'set', config: 'network', section: 'lan', values: { ipaddr: ['192.168.50.1/24'] } },
    ]);
  });

  it('writes start/limit from the range and ignore when disabling', () => {
    const { network, dhcp, lan } = load();
    const d = { ...networkDraft(lan), rangeStart: '10.231.1.10', rangeEnd: '10.231.1.19', leasetime: '1h' };
    expect(networkOps(d, lan, network, dhcp)).toEqual([
      { op: 'set', config: 'dhcp', section: 'lan', values: { start: '10', limit: '10', leasetime: '1h' } },
    ]);
    expect(networkOps({ ...networkDraft(lan), dhcpEnabled: false }, lan, network, dhcp)).toEqual([
      { op: 'set', config: 'dhcp', section: 'lan', values: { ignore: '1' } },
    ]);
  });

  it('validates address, overlap and range', () => {
    const { lan } = load();
    const d = networkDraft(lan);
    const guest = [{ network: 'guest', address: '10.231.2.0', prefix: 24, gateway: '10.231.2.1' }];
    expect(validateNetwork(d, guest)).toEqual({});
    expect(validateNetwork({ ...d, address: '10.231.1.0' }, [])).toHaveProperty('address');
    expect(validateNetwork({ ...d, address: '10.231.2.1' }, guest).address).toMatch(/Overlaps the guest/);
    expect(validateNetwork({ ...d, prefix: 16 }, guest).address).toMatch(/Overlaps/);
    expect(validateNetwork({ ...d, rangeStart: '10.231.9.1' }, []).rangeStart).toMatch(/inside/);
    expect(validateNetwork({ ...d, rangeEnd: '10.231.1.50' }, []).rangeEnd).toMatch(/before/);
    expect(validateNetwork({ ...d, leasetime: 'soon' }, []).leasetime).toBeDefined();
  });

  it('lists reservations inside a subnet', () => {
    const { dhcp } = load();
    expect(reservationsIn(dhcp, '10.231.1.0', 24)).toEqual([
      { section: 'cfg05fe63', name: 'laptop', ip: '10.231.1.50', macs: ['02:4E:55:00:01:10'] },
    ]);
    expect(reservationsIn(dhcp, '192.168.1.0', 24)).toEqual([]);
  });
});

describe('attachedSubnets', () => {
  it('adds live non-local interfaces such as the WAN after the local subnets', () => {
    const local = localSubnets(fixtures.uci.network(), fixtures.uci.firewall(), fixtures.ifaceDump());
    const all = attachedSubnets(local, fixtures.ifaceDump());
    expect(all.slice(0, local.length)).toEqual(local);
    expect(all).toContainEqual({ network: 'wan', address: '10.231.0.0', prefix: 24, gateway: '10.231.0.2' });
    expect(all.some((s) => s.address.startsWith('127.'))).toBe(false);
  });
});

describe('networkLabel', () => {
  it('upper-cases the usual abbreviations and capitalizes the rest', () => {
    expect(['lan', 'wan6', 'iot', 'guest', 'guest_wifi'].map(networkLabel)).toEqual(['LAN', 'WAN6', 'IOT', 'Guest', 'Guest wifi']);
  });
});

describe('network extras', () => {
  const { networkExtras, networkExtrasOps, validateExtras, bridgeOf } = extras;
  const setup = () => {
    const network = fixtures.uci.network();
    const dhcp = fixtures.uci.dhcp();
    const lan = normalizeNetworks(network, dhcp, fixtures.uci.firewall(), undefined).find((n) => n.id === 'lan')!;
    return { network, dhcp, lan };
  };

  it('reads the recorded LAN: auto DNS, IPv6 prefix delegation, bridge without snooping', () => {
    const { network, dhcp, lan } = setup();
    expect(networkExtras(lan, network, dhcp)).toEqual({
      dnsMode: 'auto',
      dns1: '',
      dns2: '',
      dnsRaw: [],
      domain: '',
      ipv6: 'pd',
      ip6assign: '60',
      ra: 'server',
      dhcpv6: 'server',
      slaac: true,
      igmp: false,
      bridge: 'br-lan',
    });
    expect(bridgeOf('br-lan.20', network)?.['.name']).toBe('cfg030f15');
  });

  it('sets DNS servers and domain while keeping foreign DHCP options', () => {
    const { network, dhcp, lan } = setup();
    dhcp.lan!.dhcp_option = ['tag:kids,6,1.1.1.3', '42,10.231.1.2'];
    const before = networkExtras(lan, network, dhcp);
    const x = { ...before, dnsMode: 'manual' as const, dns1: '1.1.1.1', dns2: '9.9.9.9', domain: 'home.arpa' };
    expect(validateExtras(x)).toEqual({});
    const out = stageOn(new FakeRouter({ network, dhcp }), networkExtrasOps(x, before, lan, network, dhcp, 'lan'));
    expect(out.dhcp!.lan!.dhcp_option).toEqual(['tag:kids,6,1.1.1.3', '42,10.231.1.2', '6,1.1.1.1,9.9.9.9', '15,home.arpa']);
    expect(out.network!.lan!.ip6assign).toBe('60');
  });

  it('leaves a custom option 6 alone unless the mode changes', () => {
    const { network, dhcp, lan } = setup();
    dhcp.lan!.dhcp_option = ['option:dns-server,10.0.0.53'];
    const before = networkExtras(lan, network, dhcp);
    expect(before).toMatchObject({ dnsMode: 'custom', dnsRaw: ['option:dns-server,10.0.0.53'] });
    expect(networkExtrasOps({ ...before, slaac: false }, before, lan, network, dhcp, 'lan')).toEqual([
      { op: 'set', config: 'dhcp', section: 'lan', values: { ra_slaac: '0' } },
    ]);
    expect(networkExtrasOps({ ...before, dnsMode: 'auto' }, before, lan, network, dhcp, 'lan')).toEqual([
      { op: 'unset', config: 'dhcp', section: 'lan', options: ['dhcp_option'] },
    ]);
  });

  it('turns IPv6 off and back on, and toggles IGMP snooping on the bridge', () => {
    const { network, dhcp, lan } = setup();
    const before = networkExtras(lan, network, dhcp);
    const off = stageOn(new FakeRouter({ network, dhcp }), networkExtrasOps({ ...before, ipv6: 'none', igmp: true }, before, lan, network, dhcp, 'lan'));
    expect(off.network!.lan).not.toHaveProperty('ip6assign');
    expect(off.dhcp!.lan).not.toHaveProperty('ra');
    expect(off.dhcp!.lan).not.toHaveProperty('dhcpv6');
    expect(off.network!.cfg030f15!.igmp_snooping).toBe('1');

    const none = { ...before, ipv6: 'none' as const, ra: '', dhcpv6: '' };
    expect(networkExtrasOps({ ...none, ipv6: 'pd', ip6assign: '64', ra: 'server', dhcpv6: 'server' }, none, lan, network, dhcp, 'lan')).toEqual([
      { op: 'set', config: 'network', section: 'lan', values: { ip6assign: '64' } },
    ]);
    expect(validateExtras({ ...before, ip6assign: '65' }).ip6assign).toBeTruthy();
    expect(validateExtras({ ...before, dnsMode: 'manual', dns1: '' }).dns1).toBeTruthy();
  });
});

describe('uplinkOnline', () => {
  const uplink = { name: 'wan', up: true, proto: 'static', device: 'wan.7', gateway: '203.0.113.1', dns: [] };
  it('needs a carrier when the device is known: static WANs stay up with no cable', () => {
    const devices = wrxFixtures('plain').deviceStatus();
    expect(uplinkOnline(uplink, { ...devices, 'wan.7': { ...devices.wan!, carrier: false } })).toBe(false);
    expect(uplinkOnline(uplink, { ...devices, 'wan.7': { ...devices.wan!, carrier: true } })).toBe(true);
  });
  it('trusts up + gateway when the device is not listed (e.g. pppoe-wan)', () => {
    expect(uplinkOnline({ ...uplink, device: 'pppoe-wan' }, {})).toBe(true);
    expect(uplinkOnline({ ...uplink, gateway: undefined }, {})).toBe(false);
  });
});

describe('normalizeNetworks with a VPN', () => {
  it('leaves WireGuard tunnels to the VPN page', () => {
    const f = wrxFixtures('plain');
    const net = f.uci.network();
    net.wg0 = { '.anonymous': false, '.index': 99, '.name': 'wg0', '.type': 'interface', proto: 'wireguard', addresses: ['10.6.0.1/24'] };
    const ids = normalizeNetworks(net, f.uci.dhcp(), f.uci.firewall(), f.ifaceDump()).map((n) => n.id);
    expect(ids).toContain('lan');
    expect(ids).not.toContain('wg0');
  });
});
