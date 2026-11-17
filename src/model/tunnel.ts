// Cloudflare Tunnel: websites and apps on the home network published under the
// user's own domain, with no open port (it works behind carrier-grade NAT).
// The router runs cloudflared with a tunnel's token ("remotely managed"):
// which hostname leads to which device is set in the provider's dashboard, not
// here. Tunnels run from a config.yml are shown, and can be switched off and
// on, but not set up from netui.
//
// The settings are the package's own UCI section, cloudflared.config:
//   enabled  '1' runs it; the init script checks it
//   token    the tunnel's token (a credential: viewers cannot read this package)
// Its reload trigger starts or stops cloudflared once an apply is confirmed.
// Live state comes from netui.services tunnel (api/tunnel.ts).

import type { TunnelStatus } from '../api/types';
import type { UciOp } from '../api/uci';

export type TunnelState = 'not-installed' | 'not-set-up' | 'off' | 'connecting' | 'connected' | 'failed';

export interface Tunnel {
  state: TunnelState;
  enabled: boolean;
  /** Runs from a config file set up outside netui. */
  configFile: boolean;
  tunnelId?: string;
  connections: number;
  locations: string[];
  /** What went wrong, in a sentence. */
  problem?: string;
  /** cloudflared's own words for it. */
  detail?: string;
}

/** A sentence for cloudflared's last error. */
export function tunnelProblem(error: string): string {
  if (/failed to get tunnel|unauthori[sz]ed|invalid tunnel secret|tunnel not found/i.test(error)) {
    return 'The tunnel service did not accept the token. The tunnel may have been deleted or given a new token: copy it again from the tunnel’s page.';
  }
  if (/no such host|lookup|dial|timeout|timed out|unreachable|connection refused|network is/i.test(error)) {
    return 'Cannot reach the tunnel service. Check that the router is online.';
  }
  return error;
}

export function normalizeTunnel(r: TunnelStatus | undefined): Tunnel | undefined {
  if (!r) return undefined;
  const base = {
    enabled: !!r.enabled,
    configFile: !!r.config_file,
    tunnelId: r.tunnel ?? undefined,
    connections: r.connections ?? 0,
    locations: r.locations ?? [],
  };
  if (!r.installed) return { ...base, state: 'not-installed' };
  if (!r.token && !r.config_file) return { ...base, state: 'not-set-up' };
  if (!r.enabled) return { ...base, state: 'off' };
  const error = r.error ?? undefined;
  if (r.running && base.connections > 0) return { ...base, state: 'connected' };
  if (r.running && !error) return { ...base, state: 'connecting' };
  return {
    ...base,
    state: 'failed',
    problem: error ? tunnelProblem(error) : 'cloudflared is not running. Its messages are in the System Log.',
    detail: error,
  };
}

// ---------------------------------------------------------------------------
// Token

/**
 * A tunnel's token is base64 JSON: { a: account, t: tunnel ID, s: secret }.
 * The dashboard shows it inside an install command (`cloudflared service
 * install <token>`, `... tunnel run --token <token>`): take it from whatever
 * was pasted.
 */
export function parseTunnelToken(input: string): { token: string; tunnelId: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: 'Paste the install command or the token.' };
  const token = /eyJ[A-Za-z0-9+/_-]{20,}={0,2}/.exec(text)?.[0];
  const notToken = {
    error: 'This is not a tunnel token. Copy the install command shown when you create the tunnel and choose its connector.',
  };
  if (!token) return notToken;
  try {
    const raw = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ok = (x: unknown) => typeof x === 'string' && x.length > 0;
    if (!ok(v.a) || !ok(v.s) || !ok(v.t)) return notToken;
    return { token, tunnelId: v.t as string };
  } catch {
    return notToken;
  }
}

// ---------------------------------------------------------------------------
// Changes

const SECTION = 'config';

/**
 * Turn the tunnel on or off, with a new token when given. A missing section
 * (removed by hand) is added with the package's log file, which the status
 * reads errors from.
 */
export function tunnelOps(r: TunnelStatus, enabled: boolean, token?: string): UciOp[] {
  const values = { enabled: enabled ? '1' : '0', ...(token ? { token } : {}) };
  if (!r.section) {
    return [
      {
        op: 'add',
        config: 'cloudflared',
        type: 'cloudflared',
        name: SECTION,
        values: { ...values, logfile: '/var/log/cloudflared.log' },
      },
    ];
  }
  return [{ op: 'set', config: 'cloudflared', section: SECTION, values }];
}

/** Stop running the tunnel and forget its token. The tunnel stays in the account. */
export function removeTunnelOps(r: TunnelStatus): UciOp[] {
  if (!r.section) return [];
  return [
    { op: 'set', config: 'cloudflared', section: SECTION, values: { enabled: '0' } },
    ...(r.token ? [{ op: 'unset', config: 'cloudflared', section: SECTION, options: ['token'] } as UciOp] : []),
  ];
}
