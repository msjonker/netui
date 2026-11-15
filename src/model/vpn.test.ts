import { describe, expect, it } from 'vitest';
import { fixtures, wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import { SYNTHETIC_WG_INSTANCES, fakeKey, recorded } from '../../test/fakeReads/vpn';
import type { UciConfig, UciGet } from '../api/types';
import type { UciOp } from '../api/uci';
import ddnsRecording from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.ddns.json';
import wgPopulated from '../../test/fixtures/ubus/dl-wrx36/plain/luci.wireguard.getWgInstances.populated.json';
import type { WgInstances } from '../api/types';
import { attachedSubnets, localSubnets } from './network';
import { dmzOps } from './firewall';
import {
  addPeerOps,
  clientAllowedIps,
  clientConfigText,
  confFileName,
  createServerOps,
  defaultEndpoint,
  deleteServerOps,
  editServerOps,
  fwSection,
  isEndpointHost,
  newServerDraft,
  nextPeerAddress,
  normalizeVpn,
  removePeerOps,
  restartOps,
  setPeerEnabledOps,
  suggestSubnet,
  takenSubnets,
  validateNewServer,
  validatePeer,
  validateServerEdit,
  type ServerDraft,
} from './vpn';

const ddnsGet: UciGet = ddnsRecording;

function wrx() {
  const f = wrxFixtures('plain');
  const network = f.uci.network();
  const firewall = f.uci.firewall();
  const dump = f.ifaceDump();
  const taken = takenSubnets(attachedSubnets(localSubnets(network, firewall, dump), dump), network);
  return { f, network, firewall, dump, taken };
}

const PRIV = fakeKey('SERVER-PRIVATE');

const draft = (over: Partial<ServerDraft> = {}): ServerDraft => ({
  name: 'wg0',
  port: '51820',
  cidr: '10.6.0.1/24',
  dns: '',
  access: 'full',
  endpoint: 'vpn.example.net',
  ...over,
});

/** Apply ops to a fake router seeded with these configs and return the result. */
function staged(network: UciConfig, firewall: UciConfig, ops: UciOp[]): { network: UciConfig; firewall: UciConfig } {
  const out = stageOn(new FakeRouter({ network, firewall }), ops);
  return { network: out.network!, firewall: out.firewall! };
}

function withServer(over: Partial<ServerDraft> = {}) {
  const c = wrx();
  const out = staged(c.network, c.firewall, createServerOps(draft(over), PRIV, c));
  return { ...c, network: out.network, firewall: out.firewall };
}

describe('recorded luci.wireguard shapes', () => {
  it('match the types (fake keys of real length)', () => {
    expect(recorded.keyPair.keys.priv).toHaveLength(44);
    expect(recorded.psk.psk).toHaveLength(44);
    expect(recorded.instances).toEqual({});
  });
});

describe('suggestSubnet', () => {
  it('picks 10.6.0.1/24 next to the DL-WRX36 LAN', () => {
    expect(suggestSubnet(wrx().taken)).toBe('10.6.0.1/24');
  });

  it('skips subnets in use, including other WireGuard interfaces', () => {
    const { network, firewall, taken } = withServer();
    const again = takenSubnets(attachedSubnets(localSubnets(network, firewall, undefined), undefined), network);
    expect(again.map((t) => `${t.network} ${t.address}/${t.prefix}`)).toContain('wg0 10.6.0.0/24');
    expect(suggestSubnet(again)).toBe('10.7.0.1/24');
    expect(taken).not.toContainEqual(expect.objectContaining({ network: 'wg0' }));
  });

  it('avoids the dev container LAN and falls back to 172.16 when 10/8 is taken', () => {
    const net = fixtures.uci.network();
    const fw = fixtures.uci.firewall();
    const dump = fixtures.ifaceDump();
    const taken = takenSubnets(attachedSubnets(localSubnets(net, fw, dump), dump), net);
    const s = suggestSubnet(taken);
    expect(taken.some((t) => t.address.startsWith(s.split('.').slice(0, 2).join('.')) && t.prefix <= 16)).toBe(false);
    expect(suggestSubnet([{ address: '10.0.0.0', prefix: 8 }])).toBe('172.16.100.1/24');
  });
});

describe('newServerDraft / validateNewServer', () => {
  it('defaults to wg0 on 51820 with the WAN address as endpoint (no DDNS enabled)', () => {
    const { network, taken, dump } = wrx();
    const d = newServerDraft({ network, taken, ddns: ddnsGet.values, dump });
    // The DL-WRX36 WAN is unplugged and its DDNS services are not enabled.
    expect(d).toEqual({ name: 'wg0', port: '51820', cidr: '10.6.0.1/24', dns: '', access: 'full', endpoint: '' });
  });

  it('prefers an enabled DDNS hostname', () => {
    const ddns = structuredClone(ddnsGet.values);
    ddns.myddns_ipv4!.enabled = '1';
    expect(defaultEndpoint(ddns, undefined)).toBe('yourhost.example.com');
  });

  it('uses the uplink address without DDNS', () => {
    const dump = fixtures.ifaceDump();
    const wan = dump.interface.find((i) => i['ipv4-address']?.length && i.route?.some((r) => r.target === '0.0.0.0'));
    expect(defaultEndpoint(undefined, dump)).toBe(wan?.['ipv4-address']?.[0]?.address ?? '');
  });

  it('accepts the defaults and rejects clashes', () => {
    const c = wrx();
    expect(validateNewServer(draft(), c)).toEqual({});
    expect(validateNewServer(draft({ name: 'lan' }), c).name).toMatch(/already used/);
    expect(validateNewServer(draft({ name: 'Wg-0' }), c).name).toBeDefined();
    expect(validateNewServer(draft({ cidr: '192.168.1.200/24' }), c).cidr).toMatch(/Overlaps lan/);
    expect(validateNewServer(draft({ cidr: '10.6.0.0/24' }), c).cidr).toMatch(/network or broadcast/);
    expect(validateNewServer(draft({ cidr: '10.6.0.1' }), c).cidr).toBeDefined();
    expect(validateNewServer(draft({ port: '70000' }), c).port).toBeDefined();
    expect(validateNewServer(draft({ endpoint: '' }), c).endpoint).toBeDefined();
    expect(validateNewServer(draft({ endpoint: 'host:51820' }), c).endpoint).toBeDefined();
    expect(validateNewServer(draft({ dns: '1.1.1.1, nope' }), c).dns).toBeDefined();
  });

  it('rejects a port another server or a UDP port forward uses', () => {
    const s = withServer();
    expect(validateNewServer(draft({ name: 'wg1', cidr: '10.7.0.1/24' }), s).port).toMatch(/WireGuard/);
    const fw = structuredClone(s.firewall);
    fw.fwd = { '.anonymous': false, '.index': 99, '.name': 'fwd', '.type': 'redirect', name: 'Game', src_dport: '51000-52000', proto: 'udp' };
    expect(validateNewServer(draft({ name: 'wg1', port: '51821', cidr: '10.7.0.1/24' }), { ...s, firewall: fw }).port).toMatch(
      /Game/,
    );
  });

  it('accepts hostnames and addresses as endpoints', () => {
    expect(isEndpointHost('vpn.example.net')).toBe(true);
    expect(isEndpointHost('203.0.113.4')).toBe(true);
    expect(isEndpointHost('2001:db8::1')).toBe(true);
    expect(isEndpointHost('300.1.1.1')).toBe(false);
    expect(isEndpointHost('bad host')).toBe(false);
  });
});

describe('createServerOps', () => {
  it('creates the interface, zone, forwardings and the wan port rule', () => {
    const { network, firewall } = withServer();
    expect(network.wg0).toMatchObject({
      '.type': 'interface',
      proto: 'wireguard',
      private_key: PRIV,
      listen_port: '51820',
      addresses: ['10.6.0.1/24'],
      netui_endpoint: 'vpn.example.net',
    });
    expect(network.wg0!.netui_dns).toBeUndefined();
    expect(firewall[fwSection.zone('wg0')]).toMatchObject({
      '.type': 'zone',
      name: 'vpn',
      network: ['wg0'],
      input: 'ACCEPT',
      forward: 'REJECT',
    });
    expect(firewall[fwSection.zone('wg0')]!.masq).toBeUndefined();
    expect(firewall[fwSection.wan('wg0')]).toMatchObject({ '.type': 'forwarding', src: 'vpn', dest: 'wan' });
    expect(firewall[fwSection.lan('wg0')]).toMatchObject({ '.type': 'forwarding', src: 'vpn', dest: 'lan' });
    expect(firewall[fwSection.port('wg0')]).toMatchObject({
      '.type': 'rule',
      src: 'wan',
      proto: 'udp',
      dest_port: '51820',
      target: 'ACCEPT',
    });
    expect(firewall[fwSection.dns('wg0')]).toBeUndefined();
  });

  it('internet only: no lan forwarding, input closed except DNS', () => {
    const { firewall } = withServer({ access: 'internet', dns: '1.1.1.1 9.9.9.9' });
    expect(firewall[fwSection.zone('wg0')]).toMatchObject({ input: 'REJECT' });
    expect(firewall[fwSection.lan('wg0')]).toBeUndefined();
    expect(firewall[fwSection.wan('wg0')]).toMatchObject({ dest: 'wan' });
    expect(firewall[fwSection.dns('wg0')]).toMatchObject({ src: 'vpn', dest_port: '53', proto: ['tcp', 'udp'], target: 'ACCEPT' });
  });

  it('names the zone after the interface when "vpn" is taken', () => {
    const { network, firewall } = withServer();
    const ops = createServerOps(draft({ name: 'wg1', port: '51821', cidr: '10.7.0.1/24' }), PRIV, { network, firewall });
    const out = staged(network, firewall, ops);
    expect(out.firewall[fwSection.zone('wg1')]).toMatchObject({ name: 'wg1', network: ['wg1'] });
    expect(out.firewall[fwSection.wan('wg1')]).toMatchObject({ src: 'wg1' });
  });

  it('reads back as a server', () => {
    const { network, firewall } = withServer();
    const m = normalizeVpn(network, firewall, undefined, undefined, 0);
    expect(m.others).toEqual([]);
    expect(m.servers).toEqual([
      expect.objectContaining({
        iface: 'wg0',
        listenPort: 51820,
        address: '10.6.0.1',
        prefix: 24,
        dns: ['10.6.0.1'],
        endpoint: 'vpn.example.net',
        access: 'full',
        zone: 'vpn',
        managed: true,
        peers: [],
        up: false,
      }),
    ]);
    expect(normalizeVpn(withServer({ access: 'internet' }).network, withServer({ access: 'internet' }).firewall, undefined, undefined, 0).servers[0]!.access).toBe('internet');
  });
});

describe('editServerOps', () => {
  it('moves the port rule with the listen port and switches access', () => {
    const s = withServer();
    const server = normalizeVpn(s.network, s.firewall, undefined, undefined, 0).servers[0]!;
    expect(validateServerEdit({ port: '51820', dns: '', access: 'full', endpoint: 'vpn.example.net' }, server, s)).toEqual({});
    const ops = editServerOps(server, { port: '443', dns: '1.1.1.1', access: 'internet', endpoint: '198.51.100.9' }, s);
    const out = staged(s.network, s.firewall, ops);
    expect(out.network.wg0).toMatchObject({ listen_port: '443', netui_dns: ['1.1.1.1'], netui_endpoint: '198.51.100.9' });
    expect(out.firewall[fwSection.port('wg0')]).toMatchObject({ dest_port: '443' });
    expect(out.firewall[fwSection.zone('wg0')]).toMatchObject({ input: 'REJECT' });
    expect(out.firewall[fwSection.lan('wg0')]).toBeUndefined();
    expect(out.firewall[fwSection.dns('wg0')]).toBeDefined();

    const back = normalizeVpn(out.network, out.firewall, undefined, undefined, 0).servers[0]!;
    expect(back.access).toBe('internet');
    const again = staged(out.network, out.firewall, editServerOps(back, { port: '443', dns: '', access: 'full', endpoint: '198.51.100.9' }, out));
    expect(again.firewall[fwSection.lan('wg0')]).toMatchObject({ dest: 'lan' });
    expect(again.firewall[fwSection.dns('wg0')]).toBeUndefined();
    expect(again.network.wg0!.netui_dns).toBeUndefined();
  });

  it('changes nothing when nothing changed', () => {
    const s = withServer();
    const server = normalizeVpn(s.network, s.firewall, undefined, undefined, 0).servers[0]!;
    expect(editServerOps(server, { port: '51820', dns: '', access: 'full', endpoint: 'vpn.example.net' }, s)).toEqual([]);
  });
});

describe('a server next to a DMZ', () => {
  it('keeps the DMZ off its port, and gives the port back when removed', () => {
    const c = wrx();
    const fw = staged(c.network, c.firewall, dmzOps(c.firewall, { destIp: '192.168.1.50', destZone: 'lan' })).firewall;
    const ports = (cfg: UciConfig) => Object.values(cfg).filter((x) => x.name === 'netui: DMZ').map((x) => x.src_dport);
    expect(ports(fw)).toEqual(['1-67', '69-65535']);
    const s = staged(c.network, fw, createServerOps(draft(), PRIV, { network: c.network, firewall: fw }));
    expect(ports(s.firewall)).toEqual(['1-67', '69-51819', '51821-65535']);
    const out = staged(s.network, s.firewall, deleteServerOps({ iface: 'wg0' }, s));
    expect(ports(out.firewall)).toEqual(['1-67', '69-65535']);
  });
});

describe('deleteServerOps', () => {
  it('removes everything netui created and nothing else', () => {
    const before = wrx();
    let s = withServer({ access: 'internet' });
    s = { ...s, ...staged(s.network, s.firewall, addPeerOps('wg0', peer(), s.network)) };
    const server = normalizeVpn(s.network, s.firewall, undefined, undefined, 0).servers[0]!;
    expect(server.peers).toHaveLength(1);
    const out = staged(s.network, s.firewall, deleteServerOps(server, s));
    // The restart nudge on wg0 goes with it; everything else is as it was.
    expect(out.network).toEqual(before.network);
    expect(Object.keys(out.firewall).sort()).toEqual(Object.keys(before.firewall).sort());
    expect(out.firewall).toEqual(expect.objectContaining(before.firewall));
  });

  it('leaves firewall sections it did not create alone', () => {
    const s = withServer();
    const fw = structuredClone(s.firewall);
    fw.mine = { '.anonymous': false, '.index': 50, '.name': 'mine', '.type': 'rule', name: 'Mine', src: 'vpn', target: 'ACCEPT' };
    const ops = deleteServerOps({ iface: 'wg0' }, { network: s.network, firewall: fw });
    expect(ops.filter((o) => o.op === 'delete' && o.config === 'firewall').map((o) => 'section' in o && o.section).sort()).toEqual(
      [fwSection.lan('wg0'), fwSection.port('wg0'), fwSection.wan('wg0'), fwSection.zone('wg0')].sort(),
    );
  });
});

const peer = (over = {}) => ({
  name: 'Phone',
  publicKey: fakeKey('PHONE-PUBLIC'),
  presharedKey: fakeKey('PHONE-PSK'),
  address: '10.6.0.2',
  ...over,
});

describe('peers', () => {
  it('adds a peer with a /32 and nudges the interface to reload', () => {
    const s = withServer();
    const ops = addPeerOps('wg0', peer({ keepalive: '25' }), s.network);
    const out = staged(s.network, s.firewall, ops);
    const p = Object.values(out.network).find((x) => x['.type'] === 'wireguard_wg0')!;
    expect(p).toMatchObject({
      description: 'Phone',
      public_key: fakeKey('PHONE-PUBLIC'),
      preshared_key: fakeKey('PHONE-PSK'),
      allowed_ips: ['10.6.0.2/32'],
      route_allowed_ips: '1',
      persistent_keepalive: '25',
    });
    expect(p.private_key).toBeUndefined();
    expect(out.network.wg0!.mtu).toBe('1420');
  });

  it('alternates the reload nudge and respects a custom MTU', () => {
    const net = withServer().network;
    expect(restartOps('wg0', net)).toEqual([{ op: 'set', config: 'network', section: 'wg0', values: { mtu: '1420' } }]);
    net.wg0!.mtu = '1420';
    expect(restartOps('wg0', net)).toEqual([{ op: 'unset', config: 'network', section: 'wg0', options: ['mtu'] }]);
    net.wg0!.mtu = '1380';
    expect(restartOps('wg0', net)).toEqual([{ op: 'set', config: 'network', section: 'wg0', values: { fwmark: '0x0' } }]);
    net.wg0!.fwmark = '0x0';
    expect(restartOps('wg0', net)).toEqual([{ op: 'unset', config: 'network', section: 'wg0', options: ['fwmark'] }]);
    net.wg0!.fwmark = '0x10';
    expect(restartOps('wg0', net)).toEqual([]);
  });

  it('allocates the next free address and disables/removes peers', () => {
    let s = withServer();
    let server = normalizeVpn(s.network, s.firewall, undefined, undefined, 0).servers[0]!;
    expect(nextPeerAddress(server)).toBe('10.6.0.2');
    // One router per staging: a fresh fake router would reuse anonymous section ids.
    s = {
      ...s,
      ...staged(s.network, s.firewall, [
        ...addPeerOps('wg0', peer(), s.network),
        ...addPeerOps('wg0', peer({ name: 'Laptop', address: '10.6.0.3' }), s.network),
      ]),
    };
    server = normalizeVpn(s.network, s.firewall, undefined, undefined, 0).servers[0]!;
    expect(server.peers.map((p) => [p.name, p.address, p.enabled])).toEqual([
      ['Phone', '10.6.0.2', true],
      ['Laptop', '10.6.0.3', true],
    ]);
    expect(nextPeerAddress(server)).toBe('10.6.0.4');

    const phone = server.peers[0]!.section;
    let out = staged(s.network, s.firewall, setPeerEnabledOps('wg0', phone, false, s.network));
    expect(out.network[phone]!.disabled).toBe('1');
    out = staged(out.network, out.firewall, setPeerEnabledOps('wg0', phone, true, out.network));
    expect(out.network[phone]!.disabled).toBeUndefined();

    out = staged(s.network, s.firewall, removePeerOps('wg0', phone, s.network));
    const after = normalizeVpn(out.network, out.firewall, undefined, undefined, 0).servers[0]!;
    expect(after.peers.map((p) => p.name)).toEqual(['Laptop']);
    // A freed address is reused.
    expect(nextPeerAddress(after)).toBe('10.6.0.2');
  });

  it('returns null when the subnet is full', () => {
    expect(nextPeerAddress({ address: '10.6.0.1', prefix: 30, peers: [{ allowedIps: ['10.6.0.2/32'] } as never] })).toBeNull();
  });

  it('validates names and keepalive', () => {
    expect(validatePeer({ name: 'Phone', keepalive: '' })).toEqual({});
    expect(validatePeer({ name: ' ', keepalive: '25' }).name).toBeDefined();
    expect(validatePeer({ name: 'x', keepalive: '0' }).keepalive).toBeDefined();
  });
});

describe('getWgInstances recorded on the DL-WRX36 (server made by netui, one client, never connected)', () => {
  // Plain assignment: tsc checks the recording against the type.
  const recordedInstances: WgInstances = wgPopulated;
  it('reads the server and its never-connected peer', () => {
    const s = withServer();
    const net = staged(s.network, s.firewall, addPeerOps('wg0', peer({ name: 'Phone', publicKey: 'REDACTED' }), s.network)).network;
    const dump = { interface: [{ interface: 'wg0', up: true, proto: 'wireguard' }] };
    const server = normalizeVpn(net, s.firewall, dump, recordedInstances, 1700000060).servers[0]!;
    expect(server.listenPort).toBe(51820);
    expect(server.peers[0]!.live?.connected).toBe(false);
    // rpcd reports allowed_ips as [] here even though the peer has one: addresses must come from UCI.
    expect(server.peers[0]!.address).toBe('10.6.0.2');
  });
});

describe('getWgInstances normalisation (synthetic sample: no connected peer has been recorded)', () => {
  it('maps live peers by public key', () => {
    const s = withServer();
    const net = staged(s.network, s.firewall, [
      ...addPeerOps('wg0', peer({ publicKey: fakeKey('SYNTHETIC-PHONE-PUBLIC') }), s.network),
      ...addPeerOps('wg0', peer({ name: 'Laptop', publicKey: fakeKey('SYNTHETIC-LAPTOP-PUBLIC'), address: '10.6.0.3' }), s.network),
    ]).network;
    const dump = { interface: [{ interface: 'wg0', up: true, proto: 'wireguard' }] };
    const m = normalizeVpn(net, s.firewall, dump, SYNTHETIC_WG_INSTANCES, 1700000060);
    const server = m.servers[0]!;
    expect(server.up).toBe(true);
    expect(server.publicKey).toBe(fakeKey('SYNTHETIC-SERVER-PUBLIC'));
    expect(server.peers[0]!.live).toEqual({
      handshake: 1700000000,
      endpoint: '203.0.113.7:53211',
      rx: 1048576,
      tx: 5242880,
      connected: true,
    });
    expect(server.peers[1]!.live).toEqual({ handshake: undefined, endpoint: undefined, rx: 0, tx: 0, connected: false });
    // Three minutes without a handshake: no longer connected.
    expect(normalizeVpn(net, s.firewall, dump, SYNTHETIC_WG_INSTANCES, 1700000000 + 180).servers[0]!.peers[0]!.live!.connected).toBe(false);
  });

  it('lists WireGuard interfaces without a listen port as others', () => {
    const net: UciConfig = {
      vpnc: { '.anonymous': false, '.index': 0, '.name': 'vpnc', '.type': 'interface', proto: 'wireguard', private_key: 'x' },
    };
    expect(normalizeVpn(net, undefined, undefined, undefined, 0)).toEqual({ servers: [], others: ['vpnc'] });
  });
});

describe('client configuration', () => {
  const base = {
    privateKey: fakeKey('CLIENT-PRIVATE'),
    address: '10.6.0.2',
    dns: ['10.6.0.1'],
    serverPublicKey: fakeKey('SERVER-PUBLIC'),
    presharedKey: fakeKey('PSK'),
    endpoint: 'vpn.example.net',
    port: 51820,
  };

  it('full tunnel', () => {
    const allowedIps = clientAllowedIps('full', { address: '10.6.0.1', prefix: 24, access: 'full' }, []);
    expect(clientConfigText({ ...base, allowedIps, keepalive: '25' })).toBe(
      [
        '[Interface]',
        `PrivateKey = ${fakeKey('CLIENT-PRIVATE')}`,
        'Address = 10.6.0.2/32',
        'DNS = 10.6.0.1',
        '',
        '[Peer]',
        `PublicKey = ${fakeKey('SERVER-PUBLIC')}`,
        `PresharedKey = ${fakeKey('PSK')}`,
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'Endpoint = vpn.example.net:51820',
        'PersistentKeepalive = 25',
        '',
      ].join('\n'),
    );
  });

  it('split tunnel to the local subnets', () => {
    const { network, firewall, dump } = wrx();
    const local = localSubnets(network, firewall, dump);
    const allowedIps = clientAllowedIps('split', { address: '10.6.0.1', prefix: 24, access: 'full' }, local);
    expect(allowedIps).toEqual(['10.6.0.0/24', '192.168.1.0/24']);
    expect(clientAllowedIps('split', { address: '10.6.0.1', prefix: 24, access: 'internet' }, local)).toEqual(['10.6.0.0/24']);
    const text = clientConfigText({ ...base, endpoint: '2001:db8::1', allowedIps });
    expect(text).toContain('AllowedIPs = 10.6.0.0/24, 192.168.1.0/24\n');
    expect(text).toContain('Endpoint = [2001:db8::1]:51820\n');
    expect(text).not.toContain('PersistentKeepalive');
  });

  it('makes a tunnel-safe file name', () => {
    expect(confFileName("Mark's iPhone 15 Pro Max")).toBe('Mark-s-iPhone-1.conf');
    expect(confFileName('***')).toBe('wireguard.conf');
  });
});
