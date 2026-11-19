// Tailscale: remote access that needs no public address and no open port.
// The daemon's state comes from netui.tailscale (api/tailscale.ts); what the
// firewall lets through is ordinary UCI, staged through apply/rollback:
//
//   network.tailscale                 proto none, device tailscale0
//   firewall.netui_tailscale_zone     name tailscale, input ACCEPT (your own
//                                     devices may reach the router), forward
//                                     REJECT, masq + mtu_fix (LAN devices reach
//                                     tailnet peers as the router)
//   firewall.netui_tailscale_out      forwarding lan -> tailscale
//   firewall.netui_tailscale_lan      forwarding tailscale -> lan (sharing the
//                                     home network: subnet routes)
//   firewall.netui_tailscale_wan      forwarding tailscale -> wan (exit node)
//
// An exit node is advertised as the routes 0.0.0.0/0 and ::/0 (recorded
// `debug prefs` has no separate flag).

import type { TailscaleStatus, UciConfig, UciValue } from '../api/types';
import { list, sectionsOfType, str, type UciOp } from '../api/uci';
import { wanZoneName } from './network';

export type TailscaleState = 'not-installed' | 'daemon-down' | 'needs-login' | 'stopped' | 'starting' | 'running';

export interface TailscalePeer {
  name: string;
  ip?: string;
  os?: string;
  online: boolean;
}

export interface Tailscale {
  state: TailscaleState;
  authUrl?: string;
  /** A sign-in is waiting for the user. */
  loggingIn: boolean;
  ip?: string;
  /** The tailnet's name, e.g. an account's email or domain. */
  tailnet?: string;
  hostName?: string;
  peers: TailscalePeer[];
  /** Advertised subnets, without the exit node routes. */
  routes: string[];
  exitNode: boolean;
  health: string[];
}

const EXIT = ['0.0.0.0/0', '::/0'];

export function normalizeTailscale(r: TailscaleStatus | undefined): Tailscale | undefined {
  if (!r) return undefined;
  const s = r.status;
  const advertised = r.prefs?.AdvertiseRoutes ?? [];
  const base = {
    loggingIn: !!r.loggingIn,
    peers: [] as TailscalePeer[],
    routes: advertised.filter((x) => !EXIT.includes(x)),
    exitNode: advertised.includes('0.0.0.0/0'),
    health: [] as string[],
  };
  if (!r.installed) return { ...base, state: 'not-installed' };
  if (!s) return { ...base, state: 'daemon-down' };
  const backend = s.BackendState ?? '';
  const state: TailscaleState =
    backend === 'Running'
      ? 'running'
      : backend === 'Starting'
        ? 'starting'
        : backend === 'Stopped'
          ? 'stopped'
          : 'needs-login';
  return {
    ...base,
    state,
    // Only a web address: the link is clicked as is (no javascript: or the like).
    authUrl: typeof s.AuthURL === 'string' && /^https:\/\/[^\s"<>]+$/.test(s.AuthURL) ? s.AuthURL : undefined,
    ip: (s.Self?.TailscaleIPs ?? s.TailscaleIPs ?? [])[0],
    tailnet: s.CurrentTailnet?.Name || undefined,
    hostName: s.Self?.HostName,
    peers: Object.values(s.Peer ?? {})
      .map((p) => ({
        name: p.HostName || p.DNSName?.split('.')[0] || '?',
        ip: p.TailscaleIPs?.[0],
        os: p.OS || undefined,
        online: !!p.Online,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    // "Tailscale is stopped." just repeats the state.
    health: (s.Health ?? []).filter((h) => !/is stopped/i.test(h)),
  };
}

// ---------------------------------------------------------------------------
// Firewall

export const tsSection = {
  iface: 'tailscale',
  zone: 'netui_tailscale_zone',
  out: 'netui_tailscale_out',
  lan: 'netui_tailscale_lan',
  wan: 'netui_tailscale_wan',
};

export interface TailscaleAccess {
  /** Tailnet devices may reach the home network (subnet routes). */
  share: boolean;
  exitNode: boolean;
}

function lanZone(fw: UciConfig): string {
  const z = sectionsOfType(fw, 'zone').find((x) => list(x.network).includes('lan'));
  return (z && str(z.name)) ?? 'lan';
}

/** The zone exists (set up by netui). */
export const hasTailscaleZone = (network: UciConfig, fw: UciConfig) =>
  !!network[tsSection.iface] && !!fw[tsSection.zone];

/**
 * Sections for `access`: the interface and zone always, the forwardings that
 * sharing and the exit node need. Only what is missing or no longer wanted.
 */
export function tailscaleFirewallOps(
  access: TailscaleAccess,
  ctx: { network: UciConfig; firewall: UciConfig },
): UciOp[] {
  const { firewall } = ctx;
  const ops: UciOp[] = [];
  const add = (config: 'network' | 'firewall', name: string, type: string, values: Record<string, UciValue>) => {
    if (!ctx[config][name]) ops.push({ op: 'add', config, type, name, values });
  };
  add('network', tsSection.iface, 'interface', { proto: 'none', device: 'tailscale0' });
  add('firewall', tsSection.zone, 'zone', {
    name: 'tailscale',
    network: ['tailscale'],
    input: 'ACCEPT',
    output: 'ACCEPT',
    forward: 'REJECT',
    masq: '1',
    mtu_fix: '1',
  });
  add('firewall', tsSection.out, 'forwarding', { src: lanZone(firewall), dest: 'tailscale' });
  const want = (name: string, on: boolean, values: Record<string, UciValue>) => {
    if (on) add('firewall', name, 'forwarding', values);
    else if (firewall[name]) ops.push({ op: 'delete', config: 'firewall', section: name });
  };
  want(tsSection.lan, access.share, { src: 'tailscale', dest: lanZone(firewall) });
  want(tsSection.wan, access.exitNode, { src: 'tailscale', dest: wanZoneName(firewall) });
  return ops;
}

/** Everything netui added for Tailscale. */
export function removeTailscaleOps(ctx: { network: UciConfig; firewall: UciConfig }): UciOp[] {
  return [
    ...(ctx.network[tsSection.iface] ? [{ op: 'delete', config: 'network', section: tsSection.iface } as UciOp] : []),
    ...[tsSection.zone, tsSection.out, tsSection.lan, tsSection.wan]
      .filter((n) => ctx.firewall[n])
      .map((n): UciOp => ({ op: 'delete', config: 'firewall', section: n })),
  ];
}
