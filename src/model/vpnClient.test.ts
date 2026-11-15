import { describe, expect, it } from 'vitest';
import { wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import { fakeKey } from '../../test/fakeReads/vpn';
import type { UciConfig, WgInstances } from '../api/types';
import type { UciOp } from '../api/uci';
import { normalizeVpn } from './vpn';
import {
  clientDraft,
  createClientOps,
  deleteClientOps,
  editClientOps,
  normalizeVpnClient,
  parseWgConf,
  validateClient,
  type ClientDraft,
  type WgConf,
} from './vpnClient';

const PRIV = fakeKey('CLIENT-PRIVATE');
const SERVER = fakeKey('PROVIDER-PUBLIC');
const PSK = fakeKey('PSK');

// The shape providers hand out (this one mirrors the bench test server's).
const CONF = `[Interface]
# Device: router
PrivateKey = ${PRIV}
Address = 10.66.0.2/32, fd00:66::2/128
DNS = 10.66.0.1

[Peer]
PublicKey = ${SERVER}
PresharedKey = ${PSK}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.net:51820
PersistentKeepalive = 25
`;

const conf = () => parseWgConf(CONF) as WgConf;

function wrx() {
  const f = wrxFixtures('plain');
  return { network: f.uci.network(), firewall: f.uci.firewall() };
}

function staged(ctx: { network: UciConfig; firewall: UciConfig }, ops: UciOp[]) {
  const out = stageOn(new FakeRouter(ctx), ops);
  return { network: out.network!, firewall: out.firewall! };
}

const ALL: ClientDraft = { enabled: true, mode: 'all', devices: [], killSwitch: false };

describe('parseWgConf', () => {
  it('reads a provider file', () => {
    expect(conf()).toEqual({
      privateKey: PRIV,
      addresses: ['10.66.0.2/32', 'fd00:66::2/128'],
      dns: ['10.66.0.1'],
      mtu: undefined,
      publicKey: SERVER,
      presharedKey: PSK,
      endpointHost: 'vpn.example.net',
      endpointPort: '51820',
      keepalive: '25',
      ipv6: true,
    });
    const v6 = parseWgConf(CONF.replace('vpn.example.net:51820', '[2001:db8::1]:443')) as WgConf;
    expect([v6.endpointHost, v6.endpointPort]).toEqual(['2001:db8::1', '443']);
  });

  it('says what is wrong with other files', () => {
    const err = (t: string) => (parseWgConf(t) as { error: string }).error;
    expect(err('hello')).toMatch(/Not a WireGuard/);
    expect(err(CONF.replace('0.0.0.0/0, ::/0', '10.0.0.0/8'))).toMatch(/does not send all traffic/);
    expect(err(`${CONF}\n[Peer]\nPublicKey = ${SERVER}\nEndpoint = b:1\nAllowedIPs = 0.0.0.0/0\n`)).toMatch(
      /more than one/,
    );
    expect(err(CONF.replace(PRIV, 'short'))).toMatch(/PrivateKey/);
    expect(err(CONF.replace('vpn.example.net:51820', 'vpn.example.net'))).toMatch(/Endpoint/);
  });
});

describe('VPN client config', () => {
  it('sends every device through the tunnel, with the provider DNS', () => {
    const c = wrx();
    const out = staged(c, createClientOps(conf(), ALL, c));
    expect(out.network.vpnclient).toMatchObject({
      proto: 'wireguard',
      private_key: PRIV,
      addresses: ['10.66.0.2/32', 'fd00:66::2/128'],
      dns: ['10.66.0.1'],
      netui_dns: ['10.66.0.1'],
    });
    expect(out.network.netui_vpnclient_peer).toMatchObject({
      '.type': 'wireguard_vpnclient',
      endpoint_host: 'vpn.example.net',
      allowed_ips: ['0.0.0.0/0', '::/0'],
      route_allowed_ips: '1',
      preshared_key: PSK,
    });
    expect(out.firewall.netui_vpnclient_zone).toMatchObject({
      name: 'vpnclient',
      masq: '1',
      mtu_fix: '1',
      input: 'REJECT',
    });
    expect(out.firewall.netui_vpnclient_lan).toMatchObject({ src: 'lan', dest: 'vpnclient' });
    expect(out.firewall.netui_vpnclient_kill).toBeUndefined();

    const v = normalizeVpnClient(out.network, out.firewall, undefined, undefined, 0)!;
    expect(v).toMatchObject({
      enabled: true,
      mode: 'all',
      devices: [],
      killSwitch: false,
      endpoint: 'vpn.example.net:51820',
      address: '10.66.0.2',
    });
    // Not a server, nor an "other" interface.
    expect(normalizeVpn(out.network, out.firewall, undefined, undefined, 0)).toEqual({ servers: [], others: [] });
  });

  it('routes chosen devices by policy, with a kill switch by MAC', () => {
    const c = wrx();
    const d: ClientDraft = {
      enabled: true,
      mode: 'some',
      devices: [
        { ip: '192.168.1.201', mac: '02:42:c0:a8:01:c9' },
        { ip: '192.168.1.150', mac: 'aa:bb:cc:00:00:01' },
      ],
      killSwitch: true,
    };
    const out = staged(c, createClientOps(conf(), d, c));
    expect(out.network.vpnclient!.dns).toBeUndefined();
    expect(out.network.netui_vpnclient_peer!.route_allowed_ips).toBe('0');
    expect(out.network.netui_vpnclient_route).toMatchObject({
      interface: 'vpnclient',
      target: '0.0.0.0/0',
      table: '51',
    });
    expect(out.network.netui_vpnclient_dev0).toMatchObject({ '.type': 'rule', src: '192.168.1.201/32', lookup: '51' });
    expect(out.network.netui_vpnclient_dev1).toMatchObject({ src: '192.168.1.150/32' });
    expect(out.firewall.netui_vpnclient_kill).toMatchObject({
      src: 'lan',
      dest: 'wan',
      proto: 'all',
      target: 'REJECT',
      src_mac: ['02:42:c0:a8:01:c9', 'aa:bb:cc:00:00:01'],
    });
    const v = normalizeVpnClient(out.network, out.firewall, undefined, undefined, 0)!;
    expect(v).toMatchObject({ mode: 'some', devices: ['192.168.1.201', '192.168.1.150'], killSwitch: true });
    expect(validateClient({ ...d, devices: [] })).toMatch(/at least one/);
  });

  it('switches modes in place, restarting the tunnel, and writes nothing when unchanged', () => {
    const c = wrx();
    let s = staged(c, createClientOps(conf(), ALL, c));
    let v = normalizeVpnClient(s.network, s.firewall, undefined, undefined, 0)!;
    expect(
      editClientOps(
        v,
        clientDraft(v, () => undefined),
        s,
      ),
    ).toEqual([]);

    const some: ClientDraft = { enabled: true, mode: 'some', devices: [{ ip: '192.168.1.201' }], killSwitch: true };
    const ops = editClientOps(v, some, s);
    s = staged(s, ops);
    expect(s.network.netui_vpnclient_peer!.route_allowed_ips).toBe('0');
    expect(s.network.vpnclient!.dns).toBeUndefined();
    // The mtu nudge that makes netifd set the interface up again.
    expect(s.network.vpnclient!.mtu).toBe('1420');
    // No MAC known: matched by address.
    expect(s.firewall.netui_vpnclient_kill).toMatchObject({ src_ip: ['192.168.1.201'] });

    v = normalizeVpnClient(s.network, s.firewall, undefined, undefined, 0)!;
    s = staged(s, editClientOps(v, { ...ALL, killSwitch: true }, s));
    expect(s.network.netui_vpnclient_route).toBeUndefined();
    expect(s.network.netui_vpnclient_dev0).toBeUndefined();
    expect(s.network.vpnclient!.dns).toEqual(['10.66.0.1']);
    expect(s.firewall.netui_vpnclient_kill!.src_ip).toBeUndefined();
  });

  it('turns off with the kill switch off too, and removes everything it made', () => {
    const c = wrx();
    let s = staged(c, createClientOps(conf(), { ...ALL, killSwitch: true }, c));
    const v = normalizeVpnClient(s.network, s.firewall, undefined, undefined, 0)!;
    s = staged(s, editClientOps(v, { ...clientDraft(v, () => undefined), enabled: false }, s));
    expect(s.network.vpnclient!.disabled).toBe('1');
    expect(s.firewall.netui_vpnclient_kill!.enabled).toBe('0');
    const off = normalizeVpnClient(s.network, s.firewall, undefined, undefined, 0)!;
    expect(off).toMatchObject({ enabled: false, killSwitch: true });
    // Back on: the kill switch comes back with it.
    const on = staged(s, editClientOps(off, { ...clientDraft(off, () => undefined), enabled: true }, s));
    expect(on.firewall.netui_vpnclient_kill!.enabled).toBeUndefined();
    expect(on.network.vpnclient!.disabled).toBeUndefined();

    const gone = staged(s, deleteClientOps(s));
    expect(gone.network).toEqual(c.network);
    expect(gone.firewall).toEqual(c.firewall);
  });

  it('reads the live handshake', () => {
    const c = wrx();
    const s = staged(c, createClientOps(conf(), ALL, c));
    const wg = {
      vpnclient: {
        name: 'vpnclient',
        public_key: fakeKey('PUB'),
        listen_port: 40000,
        fwmark: 'off',
        peers: [
          {
            public_key: SERVER,
            endpoint: '192.0.2.10:51820',
            latest_handshake: '1000',
            transfer_rx: '540',
            transfer_tx: '628',
            persistent_keepalive: '25',
            allowed_ips: ['0.0.0.0/0'],
          },
        ],
      },
    } as unknown as WgInstances;
    expect(normalizeVpnClient(s.network, s.firewall, undefined, wg, 1010)!.live).toMatchObject({
      connected: true,
      rx: 540,
      tx: 628,
    });
  });
});
