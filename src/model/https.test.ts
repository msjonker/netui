import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet } from '../api/types';
import wrxUhttpd from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.uhttpd.json';
import { httpsState, redirectOps, secureUrl } from './https';

const cfg = (): UciConfig => structuredClone((wrxUhttpd as UciGet).values);

describe('httpsState', () => {
  it('reads the stock setup: HTTPS on 443 with the router certificate, no redirect', () => {
    expect(httpsState(cfg())).toEqual({ section: 'main', configured: true, port: 443, redirect: false });
  });

  it('is not configured without a listener or certificate', () => {
    const c = cfg();
    delete c.main!.listen_https;
    expect(httpsState(c)?.configured).toBe(false);
    const d = cfg();
    delete d.main!.cert;
    expect(httpsState(d)?.configured).toBe(false);
    expect(httpsState(undefined)).toBeUndefined();
  });

  it('switches the redirect and builds the secure address', () => {
    const c = cfg();
    expect(redirectOps(c, httpsState(c)!, true)).toEqual([{ op: 'set', config: 'uhttpd', section: 'main', values: { redirect_https: '1' } }]);
    expect(redirectOps(c, httpsState(c)!, false)).toEqual([]);
    expect(secureUrl({ hostname: '192.168.1.1', pathname: '/netui/', hash: '#/settings/system' }, 443)).toBe(
      'https://192.168.1.1/netui/#/settings/system',
    );
    expect(secureUrl({ hostname: 'fd00::1', pathname: '/netui/', hash: '' }, 8443)).toBe('https://[fd00::1]:8443/netui/');
  });
});
