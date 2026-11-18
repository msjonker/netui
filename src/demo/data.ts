// The demo router's starting state: an imaginary home network on OpenWrt
// 25.12 with a LAN, a smart-home VLAN, a VPN server and one access point.
// Config shapes follow the recordings in test/fixtures/ubus/; everything
// identifying (names, addresses, keys) is invented. Addresses come from the
// documentation ranges (RFC 5737, RFC 3849, RFC 7042) or are private.

import type { AddonKey, UciConfig, UciSection, UciValue } from '../api/types';
import sqm from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.sqm.json';
import upnpd from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.upnpd.json';
import ddns from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.ddns.json';
import wifiSchedule from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wifi_schedule.json';
import doh from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.https-dns-proxy.json';
import cloudflared from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.cloudflared.json';
import usteer from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.usteer.json';
import adblock from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.adblock-fast.json';
import mwan3 from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.mwan3.json';
import opennds from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.opennds.json';

export const BOARD = {
  model: 'Example AX3000 Router',
  board_name: 'example,ax3000',
  kernel: '6.12.74',
  system: 'ARMv8 Processor rev 4',
  version: '25.12.6',
  revision: 'r33311-981c978eff',
  target: 'armsr/armv8',
};

export const AP_BOARD = { model: 'Example AX1800 Access Point', board_name: 'example,ax1800' };

/** The router's own MAC; LAN ports and radios count up from it. */
export const ROUTER_MAC = '02:5e:00:53:10:00';
export const AP_MAC = '02:5e:00:53:20:00';

/** The Dynamic DNS name, which VPN clients dial. */
export const DDNS_NAME = 'home-example.duckdns.org';

export const WAN = {
  address: '203.0.113.45',
  gateway: '203.0.113.1',
  dns: ['203.0.113.53', '203.0.113.54'],
  address6: '2001:db8:4a2:100::2',
  prefix6: '2001:db8:4a2:a00::',
};

// ---------------------------------------------------------------------------
// Clients

export type Band = '2g' | '5g';

export interface DemoClient {
  mac: string;
  name: string;
  /** Host part on its network; the network's /24 gives the rest. */
  host: number;
  net: 'lan' | 'iot';
  link: { wired: string } | { band: Band; signal: number; ap?: boolean };
  /** Typical download and upload, bit/s. */
  down: number;
  up: number;
  /** Reaches the internet at all (cameras upload, speakers stream). */
  apps: string[];
  /** Comes and goes: online for this many seconds of every 10 minutes. */
  cycle?: number;
}

const K = 1e3;
const M = 1e6;

export const CLIENTS: DemoClient[] = [
  { mac: '00:00:5e:00:53:11', name: 'desktop-pc', host: 101, net: 'lan', link: { wired: 'lan1' }, down: 12 * M, up: 1.5 * M, apps: ['HTTPS', 'QUIC', 'SSH'] },
  { mac: '00:00:5e:00:53:12', name: 'nas', host: 102, net: 'lan', link: { wired: 'lan2' }, down: 2 * M, up: 6 * M, apps: ['HTTPS', 'NTP'] },
  { mac: '00:00:5e:00:53:13', name: 'game-console', host: 103, net: 'lan', link: { wired: 'lan3' }, down: 18 * M, up: 0.8 * M, apps: ['HTTPS', 'QUIC'] },
  { mac: '00:00:5e:00:53:21', name: 'living-room-tv', host: 110, net: 'lan', link: { band: '5g', signal: -52 }, down: 22 * M, up: 0.4 * M, apps: ['HTTPS', 'QUIC'] },
  { mac: '3a:61:0c:5d:9e:21', name: 'sams-phone', host: 121, net: 'lan', link: { band: '5g', signal: -58 }, down: 3 * M, up: 0.6 * M, apps: ['HTTPS', 'QUIC', 'IMAPS'] },
  { mac: '5e:22:91:af:03:7c', name: 'alex-laptop', host: 122, net: 'lan', link: { band: '5g', signal: -61, ap: true }, down: 8 * M, up: 2 * M, apps: ['HTTPS', 'QUIC', 'SSH'] },
  { mac: '7a:10:4e:8b:c2:55', name: 'tablet', host: 123, net: 'lan', link: { band: '5g', signal: -66 }, down: 4 * M, up: 0.3 * M, apps: ['HTTPS', 'QUIC'], cycle: 420 },
  { mac: '9e:3b:57:01:da:40', name: 'office-phone', host: 124, net: 'lan', link: { band: '5g', signal: -55, ap: true }, down: 1.2 * M, up: 0.4 * M, apps: ['HTTPS'] },
  { mac: '00:00:5e:00:53:31', name: 'printer', host: 130, net: 'lan', link: { band: '2g', signal: -63 }, down: 2 * K, up: 1 * K, apps: ['HTTPS'] },
  { mac: '00:00:5e:00:53:41', name: 'thermostat', host: 101, net: 'iot', link: { band: '2g', signal: -60 }, down: 6 * K, up: 4 * K, apps: ['HTTPS', 'NTP'] },
  { mac: '00:00:5e:00:53:42', name: 'doorbell-camera', host: 102, net: 'iot', link: { band: '2g', signal: -67 }, down: 40 * K, up: 1.8 * M, apps: ['HTTPS', 'RTP'] },
  { mac: '00:00:5e:00:53:43', name: 'smart-plug', host: 103, net: 'iot', link: { band: '2g', signal: -71 }, down: 1 * K, up: 1 * K, apps: ['HTTPS'] },
  { mac: '00:00:5e:00:53:44', name: 'kitchen-speaker', host: 104, net: 'iot', link: { band: '2g', signal: -57 }, down: 320 * K, up: 12 * K, apps: ['HTTPS', 'QUIC'] },
];

/** The application names nlbwmon reports for the demo's traffic. */
export const APP_PORTS: Record<string, [string, number]> = {
  HTTPS: ['TCP', 443],
  QUIC: ['UDP', 443],
  SSH: ['TCP', 22],
  IMAPS: ['TCP', 993],
  NTP: ['UDP', 123],
  RTP: ['UDP', 5004],
};

// ---------------------------------------------------------------------------
// UCI

/** Build a config from `name: [type, options]`, anonymous when the name starts with "@". */
function config(sections: [string, string, Record<string, UciValue>][]): UciConfig {
  const out: UciConfig = {};
  sections.forEach(([name, type, values], i) => {
    const anonymous = name.startsWith('@');
    const id = anonymous ? `cfg${(0x10 + i).toString(16).padStart(2, '0')}${type.length.toString(16).padStart(4, '0')}` : name;
    out[id] = { '.anonymous': anonymous, '.index': i, '.name': id, '.type': type, ...values } as UciSection;
  });
  return out;
}

const fixture = (f: { values: unknown }) => structuredClone(f.values) as UciConfig;

const PSK = 'demo-password';

export const VPN_PEERS = [
  { name: "Sam's phone", key: 'u3Kc2T1lCH0nYwGm5Pq8b1VdW7xR4eJ6fA9sLzN0oQk=', address: '10.6.0.2' },
  { name: 'Travel laptop', key: 'Rk7XbP2vN8eQ1sT4mZ0cW6yL3hJ9dF5gU2aK7oV1iE8=', address: '10.6.0.3' },
];

function network(): UciConfig {
  return config([
    ['loopback', 'interface', { device: 'lo', proto: 'static', ipaddr: ['127.0.0.1/8'] }],
    ['globals', 'globals', { ula_prefix: 'fd5e:5300:1a2b::/48', packet_steering: '1' }],
    ['@device', 'device', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3', 'lan4'] }],
    ['@vlan1', 'bridge-vlan', { device: 'br-lan', vlan: '1', ports: ['lan1:u*', 'lan2:u*', 'lan3:u*', 'lan4:u*'] }],
    ['@vlan10', 'bridge-vlan', { device: 'br-lan', vlan: '10', ports: ['lan4:t'] }],
    ['lan', 'interface', { device: 'br-lan.1', proto: 'static', ipaddr: ['192.168.1.1/24'], ip6assign: '60' }],
    ['iot', 'interface', { device: 'br-lan.10', proto: 'static', ipaddr: ['192.168.10.1/24'] }],
    ['wan', 'interface', { device: 'wan', proto: 'dhcp' }],
    ['wan6', 'interface', { device: 'wan', proto: 'dhcpv6' }],
    [
      'wg0',
      'interface',
      {
        proto: 'wireguard',
        private_key: 'kM2pZr9dL0aWq4bN7cX1vT6yH3sF8gJ5eU0iO2lK9mA=',
        listen_port: '51820',
        addresses: ['10.6.0.1/24'],
        netui_endpoint: DDNS_NAME,
      },
    ],
    ...VPN_PEERS.map(
      (p): [string, string, Record<string, UciValue>] => [
        '@peer',
        'wireguard_wg0',
        {
          description: p.name,
          public_key: p.key,
          preshared_key: 'aP3xQ9wE2rT7yU1iO5pA8sD4fG6hJ0kL3zX7cV9bN2m=',
          allowed_ips: [`${p.address}/32`],
          route_allowed_ips: '1',
        },
      ],
    ),
  ]);
}

function wireless(): UciConfig {
  return config([
    ['radio0', 'wifi-device', { type: 'mac80211', path: 'platform/soc/18000000.wifi', band: '5g', channel: '36', htmode: 'HE80', country: 'US', cell_density: '0' }],
    ['radio1', 'wifi-device', { type: 'mac80211', path: 'platform/soc/18000000.wifi+1', band: '2g', channel: '6', htmode: 'HE20', country: 'US', cell_density: '0' }],
    ['default_radio0', 'wifi-iface', { device: 'radio0', network: 'lan', mode: 'ap', ssid: 'Home', encryption: 'sae-mixed', key: PSK, ieee80211r: '1', mobility_domain: '4f57', ft_over_ds: '0' }],
    ['default_radio1', 'wifi-iface', { device: 'radio1', network: 'lan', mode: 'ap', ssid: 'Home', encryption: 'sae-mixed', key: PSK, ieee80211r: '1', mobility_domain: '4f57', ft_over_ds: '0' }],
    ['wifinet2', 'wifi-iface', { device: 'radio1', network: 'iot', mode: 'ap', ssid: 'Home-Devices', encryption: 'psk2', key: 'devices-password' }],
  ]);
}

function firewall(): UciConfig {
  return config([
    ['@defaults', 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', syn_flood: '1', flow_offloading: '1' }],
    ['@zone', 'zone', { name: 'lan', network: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' }],
    ['@zone', 'zone', { name: 'wan', network: ['wan', 'wan6'], input: 'REJECT', output: 'ACCEPT', forward: 'DROP', masq: '1', mtu_fix: '1' }],
    ['@fwd', 'forwarding', { src: 'lan', dest: 'wan' }],
    ['@rule', 'rule', { name: 'Allow-DHCP-Renew', src: 'wan', proto: 'udp', dest_port: '68', target: 'ACCEPT', family: 'ipv4' }],
    ['@rule', 'rule', { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' }],
    ['@rule', 'rule', { name: 'Allow-IGMP', src: 'wan', proto: 'igmp', family: 'ipv4', target: 'ACCEPT' }],
    ['@rule', 'rule', { name: 'Allow-DHCPv6', src: 'wan', proto: 'udp', dest_port: '546', family: 'ipv6', target: 'ACCEPT' }],
    ['@rule', 'rule', { name: 'Allow-MLD', src: 'wan', proto: 'icmp', src_ip: 'fe80::/10', icmp_type: ['130/0', '131/0', '132/0', '143/0'], family: 'ipv6', target: 'ACCEPT' }],
    [
      '@rule',
      'rule',
      {
        name: 'Allow-ICMPv6-Input',
        src: 'wan',
        proto: 'icmp',
        icmp_type: ['echo-request', 'echo-reply', 'destination-unreachable', 'packet-too-big', 'time-exceeded', 'bad-header', 'unknown-header-type', 'router-solicitation', 'neighbour-solicitation', 'router-advertisement', 'neighbour-advertisement'],
        limit: '1000/sec',
        family: 'ipv6',
        target: 'ACCEPT',
      },
    ],
    ['@zone', 'zone', { name: 'iot', network: ['iot'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' }],
    ['@fwd', 'forwarding', { src: 'iot', dest: 'wan' }],
    ['@rule', 'rule', { name: 'Allow-iot-DHCP', src: 'iot', proto: 'udp', dest_port: '67-68', family: 'ipv4', target: 'ACCEPT' }],
    ['@rule', 'rule', { name: 'Allow-iot-DNS', src: 'iot', proto: ['tcp', 'udp'], dest_port: '53', target: 'ACCEPT' }],
    ['netui_wg0_zone', 'zone', { name: 'wg0', network: ['wg0'], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' }],
    ['netui_wg0_wan', 'forwarding', { src: 'wg0', dest: 'wan' }],
    ['netui_wg0_lan', 'forwarding', { src: 'wg0', dest: 'lan' }],
    ['netui_wg0_port', 'rule', { name: 'netui: VPN wg0', src: 'wan', proto: 'udp', dest_port: '51820', target: 'ACCEPT' }],
    ['@redirect', 'redirect', { name: 'Game server', target: 'DNAT', src: 'wan', dest: 'lan', proto: ['tcp', 'udp'], src_dport: '25565', dest_ip: '192.168.1.103' }],
    ['@redirect', 'redirect', { name: 'Photo library', target: 'DNAT', src: 'wan', dest: 'lan', proto: ['tcp'], src_dport: '8443', dest_ip: '192.168.1.102', dest_port: '443', enabled: '0' }],
  ]);
}

function dhcp(): UciConfig {
  return config([
    [
      '@dnsmasq',
      'dnsmasq',
      {
        domainneeded: '1',
        boguspriv: '1',
        localise_queries: '1',
        rebind_protection: '1',
        rebind_localhost: '1',
        local: '/lan/',
        domain: 'lan',
        expandhosts: '1',
        cachesize: '1000',
        authoritative: '1',
        readethers: '1',
        leasefile: '/tmp/dhcp.leases',
        resolvfile: '/tmp/resolv.conf.d/resolv.conf.auto',
        localservice: '1',
        nonwildcard: '1',
        ednspacket_max: '1232',
      },
    ],
    ['lan', 'dhcp', { interface: 'lan', start: '100', limit: '150', leasetime: '12h', dhcpv4: 'server', dhcpv6: 'server', ra: 'server', ra_slaac: '1', ra_flags: ['managed-config', 'other-config'] }],
    ['iot', 'dhcp', { interface: 'iot', start: '100', limit: '150', leasetime: '12h' }],
    ['wan', 'dhcp', { interface: 'wan', ignore: '1' }],
    ['odhcpd', 'odhcpd', { maindhcp: '0', leasefile: '/tmp/hosts/odhcpd', leasetrigger: '/usr/sbin/odhcpd-update', loglevel: '4' }],
    ['@host', 'host', { name: 'nas', mac: ['00:00:5E:00:53:12'], ip: '192.168.1.102' }],
    ['@host', 'host', { name: 'game-console', mac: ['00:00:5E:00:53:13'], ip: '192.168.1.103' }],
    // A name only, as netui's client settings write it: the tablet stays known while it is away.
    ['@host', 'host', { name: 'tablet', mac: ['7A:10:4E:8B:C2:55'] }],
  ]);
}

function system(): UciConfig {
  return config([
    ['@system', 'system', { hostname: 'home-router', timezone: 'CET-1CEST,M3.5.0,M10.5.0/3', zonename: 'Europe/Amsterdam', ttylogin: '0', log_size: '128', urandom_seed: '0', cronloglevel: '7' }],
    ['ntp', 'timeserver', { enabled: '1', enable_server: '0', server: ['0.openwrt.pool.ntp.org', '1.openwrt.pool.ntp.org', '2.openwrt.pool.ntp.org', '3.openwrt.pool.ntp.org'] }],
  ]);
}

function nlbwmon(): UciConfig {
  return config([
    [
      '@nlbwmon',
      'nlbwmon',
      {
        netlink_buffer_size: '524288',
        commit_interval: '24h',
        refresh_interval: '30s',
        database_directory: '/var/lib/nlbwmon',
        database_generations: '10',
        database_interval: '1',
        protocol_database: '/usr/share/nlbwmon/protocols',
        local_network: ['192.168.0.0/16', '172.16.0.0/12', '10.0.0.0/8', 'lan'],
      },
    ],
  ]);
}

/** The recorded queue, on the WAN port and switched on. */
function withSqm(): UciConfig {
  const c = fixture(sqm);
  const q = Object.values(c).find((s) => s['.type'] === 'queue')!;
  delete c[q['.name']];
  return { ...c, wan: { ...q, '.name': 'wan', enabled: '1', interface: 'wan', download: '850000', upload: '38000' } };
}

/** One working Dynamic DNS name instead of the factory examples. */
function withDdns(): UciConfig {
  const c = fixture(ddns);
  for (const s of Object.values(c)) if (s['.type'] === 'service') delete c[s['.name']];
  return {
    ...c,
    home: {
      '.anonymous': false,
      '.index': 9,
      '.name': 'home',
      '.type': 'service',
      enabled: '1',
      service_name: 'duckdns.org',
      lookup_host: DDNS_NAME,
      domain: DDNS_NAME,
      username: 'NA',
      password: 'demo-token',
      interface: 'wan',
      ip_source: 'network',
      ip_network: 'wan',
    },
  };
}

function withUpnp(): UciConfig {
  const c = fixture(upnpd);
  for (const s of Object.values(c)) if (s['.type'] === 'upnpd') s.enabled = '1';
  return c;
}

/** Ad blocking on with one list; only lists named after their projects are kept. */
function withAdblock(): UciConfig {
  const c = fixture(adblock);
  const keep = ['Hagezi - Pro', 'OISD - Big', 'StevenBlack - Unified hosts', '1Hosts - Lite', 'CERT Polska - Dangerous Websites'];
  for (const s of Object.values(c)) {
    if (s['.type'] === 'adblock-fast') s.enabled = '1';
    if (s['.type'] !== 'file_url') continue;
    if (!keep.includes(String(s.name))) delete c[s['.name']];
    else s.enabled = s.name === 'Hagezi - Pro' ? '1' : '0';
  }
  return c;
}

/** Every config the demo router has, installed or not; see INSTALLED. */
export function initialConfigs(): Record<string, UciConfig> {
  return {
    network: network(),
    wireless: wireless(),
    firewall: firewall(),
    dhcp: dhcp(),
    system: system(),
    nlbwmon: nlbwmon(),
    sqm: withSqm(),
    upnpd: withUpnp(),
    ddns: withDdns(),
    wifi_schedule: fixture(wifiSchedule),
    'https-dns-proxy': fixture(doh),
    usteer: fixture(usteer),
    'adblock-fast': withAdblock(),
    mwan3: fixture(mwan3),
    opennds: fixture(opennds),
    cloudflared: fixture(cloudflared),
  };
}

/** Which add-ons the demo router starts with. The rest can be installed from netui. */
export const INSTALLED: Record<AddonKey, boolean> = {
  adblock: true,
  portal: false,
  multiwan: false,
  usage: true,
  sqm: true,
  upnp: true,
  ddns: true,
  wireguard: true,
  schedule: true,
  steering: true,
  speedtest: true,
  firmware: true,
  wol: true,
  doh: false,
  tailscale: false,
  tunnel: false,
  mesh: false,
};

/** The UCI config each add-on brings. */
export const ADDON_CONFIG: Partial<Record<AddonKey, string>> = {
  adblock: 'adblock-fast',
  portal: 'opennds',
  multiwan: 'mwan3',
  usage: 'nlbwmon',
  sqm: 'sqm',
  upnp: 'upnpd',
  ddns: 'ddns',
  schedule: 'wifi_schedule',
  steering: 'usteer',
  doh: 'https-dns-proxy',
  tunnel: 'cloudflared',
};

/**
 * The access point's network config: as adoption leaves it (every port on a
 * plain br-lan), or as netui's sync leaves it once it carries the gateway's
 * IoT VLAN, with lan2 moved onto IoT.
 */
export function apNetwork(carried: boolean): UciConfig {
  return config([
    ['loopback', 'interface', { device: 'lo', proto: 'static', ipaddr: '127.0.0.1/8' }],
    ['@device', 'device', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'wan'], stp: '1', forward_delay: '4' }],
    ...(carried
      ? ([
          ['@vlan1', 'bridge-vlan', { device: 'br-lan', vlan: '1', ports: ['lan1:u*', 'wan:u*'] }],
          ['@vlan10', 'bridge-vlan', { device: 'br-lan', vlan: '10', ports: ['lan1:t', 'lan2:u*', 'wan:t'] }],
          ['lan', 'interface', { device: 'br-lan.1', proto: 'dhcp' }],
          ['netui_iot', 'interface', { device: 'br-lan.10', proto: 'none' }],
        ] as [string, string, Record<string, UciValue>][])
      : ([['lan', 'interface', { device: 'br-lan', proto: 'dhcp' }]] as [string, string, Record<string, UciValue>][])),
  ]);
}

/** netui.agent ports on the access point: two LAN ports and the uplink on wan. */
export const AP_PORTS = {
  network: { lan: { ports: ['lan1', 'lan2'], protocol: 'static' }, wan: { device: 'wan', protocol: 'dhcp' } },
  switch: null,
  switch_state: null,
  uplink: 'wan',
};

/** The access point's own wireless config (sync copies the gateway's SSIDs). */
export function apWireless(): UciConfig {
  return config([
    ['radio0', 'wifi-device', { type: 'mac80211', path: 'platform/soc/a000000.wifi', band: '2g', channel: '11', htmode: 'HE20', country: 'US', cell_density: '0' }],
    ['radio1', 'wifi-device', { type: 'mac80211', path: 'platform/soc/a800000.wifi', band: '5g', channel: '149', htmode: 'HE80', country: 'US', cell_density: '0' }],
    ['netui_lan_0', 'wifi-iface', { device: 'radio0', network: 'lan', mode: 'ap', ssid: 'Home', encryption: 'sae-mixed', key: PSK, ieee80211r: '1', mobility_domain: '4f57' }],
    ['netui_lan_1', 'wifi-iface', { device: 'radio1', network: 'lan', mode: 'ap', ssid: 'Home', encryption: 'sae-mixed', key: PSK, ieee80211r: '1', mobility_domain: '4f57' }],
  ]);
}
