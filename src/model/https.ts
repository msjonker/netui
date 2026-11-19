import type { UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';

// HTTPS for the router's web server (uhttpd serves netui and LuCI). Stock
// images with LuCI listen on 443 with a certificate the router made itself;
// the `https` add-on (luci-ssl) adds that where it is missing. "Always use
// HTTPS" is uhttpd's redirect_https: plain HTTP visits are sent to the
// encrypted address. netui only offers it from a page already open over
// HTTPS, so switching it on never touches the connection netui is using.

export interface HttpsState {
  section: string;
  /** uhttpd is set to listen for HTTPS, with a certificate and key. */
  configured: boolean;
  /** Port of the first HTTPS listener (443 when it is not given). */
  port: number;
  redirect: boolean;
}

export function httpsState(cfg: UciConfig | undefined): HttpsState | undefined {
  if (!cfg) return undefined;
  const s = cfg.main ?? sectionsOfType(cfg, 'uhttpd')[0];
  if (!s) return undefined;
  const listen = list(s.listen_https);
  const port = Number(/:(\d+)$/.exec(listen[0] ?? '')?.[1] ?? 443);
  return {
    section: s['.name'],
    configured: listen.length > 0 && !!str(s.cert) && !!str(s.key),
    port,
    redirect: bool(s.redirect_https, false),
  };
}

export function redirectOps(cfg: UciConfig, state: HttpsState, on: boolean): UciOp[] {
  return diffSection('uhttpd', state.section, cfg[state.section], { redirect_https: on ? '1' : '0' });
}

/** netui's address over HTTPS, for a page open over plain HTTP. */
export function secureUrl(loc: Pick<Location, 'hostname' | 'pathname' | 'hash'>, port: number): string {
  const host = loc.hostname.includes(':') && !loc.hostname.startsWith('[') ? `[${loc.hostname}]` : loc.hostname;
  return `https://${host}${port === 443 ? '' : `:${port}`}${loc.pathname}${loc.hash}`;
}
