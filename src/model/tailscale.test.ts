import { describe, expect, it } from 'vitest';
import { wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import rec from '../../test/fixtures/ubus/dl-wrx36/plain/tailscale.status.json';
import type { TailscaleStatus, UciConfig } from '../api/types';
import type { UciOp } from '../api/uci';
import { normalizeTailscale, removeTailscaleOps, tailscaleFirewallOps } from './tailscale';

const status = (s: object, extra: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
  installed: true,
  status: structuredClone(s) as TailscaleStatus['status'],
  prefs: structuredClone(rec.prefs),
  ...extra,
});

describe('normalizeTailscale (recorded, never signed in)', () => {
  it('needs a sign-in, then has a sign-in link', () => {
    expect(normalizeTailscale(status(rec.needsLogin))).toMatchObject({
      state: 'needs-login',
      authUrl: undefined,
      peers: [],
      routes: [],
      exitNode: false,
      health: [],
    });
    expect(normalizeTailscale(status(rec.authUrl, { loggingIn: true }))).toMatchObject({
      state: 'needs-login',
      authUrl: rec.authUrl.AuthURL,
      loggingIn: true,
    });
  });

  it('tells a missing package from a stopped daemon', () => {
    expect(normalizeTailscale({ installed: false })?.state).toBe('not-installed');
    expect(
      normalizeTailscale({ installed: true, status: null, error: 'failed to connect to local tailscaled' })?.state,
    ).toBe('daemon-down');
  });

  it('reads a running node, its peers and what it advertises', () => {
    // The recorded shape with the fields a signed-in daemon fills in.
    const running = {
      ...rec.needsLogin,
      BackendState: 'Running',
      Self: { ...rec.needsLogin.Self, TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
      CurrentTailnet: { Name: 'example.com' },
      Peer: {
        a: { HostName: 'phone', TailscaleIPs: ['100.64.0.2'], OS: 'iOS', Online: false },
        b: { HostName: 'laptop', TailscaleIPs: ['100.64.0.3'], OS: 'macOS', Online: true },
      },
    };
    const ts = normalizeTailscale(
      status(running, { prefs: { AdvertiseRoutes: ['192.168.1.0/24', '0.0.0.0/0', '::/0'] } }),
    )!;
    expect(ts).toMatchObject({
      state: 'running',
      ip: '100.101.102.103',
      tailnet: 'example.com',
      routes: ['192.168.1.0/24'],
      exitNode: true,
    });
    expect(ts.peers.map((p) => [p.name, p.online])).toEqual([
      ['laptop', true],
      ['phone', false],
    ]);
  });
});

describe('Tailscale firewall', () => {
  const wrx = () => {
    const f = wrxFixtures('plain');
    return { network: f.uci.network(), firewall: f.uci.firewall() };
  };
  const staged = (ctx: { network: UciConfig; firewall: UciConfig }, ops: UciOp[]) => {
    const out = stageOn(new FakeRouter(ctx), ops);
    return { network: out.network!, firewall: out.firewall! };
  };

  it('adds the interface and zone, then forwardings as access is granted and withdrawn', () => {
    const c = wrx();
    let s = staged(c, tailscaleFirewallOps({ share: false, exitNode: false }, c));
    expect(s.network.tailscale).toMatchObject({ proto: 'none', device: 'tailscale0' });
    expect(s.firewall.netui_tailscale_zone).toMatchObject({
      name: 'tailscale',
      input: 'ACCEPT',
      forward: 'REJECT',
      masq: '1',
    });
    expect(s.firewall.netui_tailscale_out).toMatchObject({ src: 'lan', dest: 'tailscale' });
    expect(s.firewall.netui_tailscale_lan).toBeUndefined();

    s = staged(s, tailscaleFirewallOps({ share: true, exitNode: true }, s));
    expect(s.firewall.netui_tailscale_lan).toMatchObject({ src: 'tailscale', dest: 'lan' });
    expect(s.firewall.netui_tailscale_wan).toMatchObject({ src: 'tailscale', dest: 'wan' });
    expect(tailscaleFirewallOps({ share: true, exitNode: true }, s)).toEqual([]);

    s = staged(s, tailscaleFirewallOps({ share: true, exitNode: false }, s));
    expect(s.firewall.netui_tailscale_wan).toBeUndefined();

    const gone = staged(s, removeTailscaleOps(s));
    expect(gone).toEqual(c);
  });
});
