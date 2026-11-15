import { describe, expect, it } from 'vitest';
import type { UciConfig } from '../api/types';
import cfgRec from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.https-dns-proxy.json';
import dhcpRec from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.dhcp.doh-active.json';
import plainDhcp from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.dhcp.json';
import { dohDhcpCleanOps, dohDraft, dohOps, dohSwitch, normalizeDoh, validateDoh } from './doh';

const cfg = (): UciConfig => structuredClone(cfgRec.values);
const active = (): UciConfig => structuredClone(dhcpRec.values);
const stopped = (): UciConfig => structuredClone(plainDhcp.values);
const CLEAN = {
  op: 'unset',
  config: 'dhcp',
  section: 'cfg01411c',
  // Recorded: no servers of the user's own (backup ''), noresolv was unset (backup -1).
  options: ['server', 'noresolv', 'doh_server', 'doh_backup_server', 'doh_backup_noresolv'],
};

describe('DNS over HTTPS', () => {
  it('reads the package as installed: running with two resolvers', () => {
    const d = normalizeDoh(cfg(), active());
    expect(d).toEqual({ active: true, urls: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'] });
    expect(dohDraft(d)).toEqual({ enabled: true, provider: 'cloudflare', customUrl: '' });
    expect(normalizeDoh(cfg(), stopped()).active).toBe(false);
  });

  it('changes nothing for an untouched draft', () => {
    const d = normalizeDoh(cfg(), active());
    expect(dohOps(dohDraft(d), d, cfg(), active())).toEqual([]);
    expect(dohSwitch(dohDraft(d), d)).toBeUndefined();
  });

  it('switches off by cleaning up dnsmasq only, then stopping', () => {
    const d = normalizeDoh(cfg(), active());
    const off = { ...dohDraft(d), enabled: false, provider: 'quad9' };
    // No change to the proxy's own config: its reload would race the stop.
    expect(dohOps(off, d, cfg(), active())).toEqual([CLEAN]);
    expect(dohSwitch(off, d)).toBe(false);
  });

  it('switches on with nothing to write, or with a new provider', () => {
    const d = normalizeDoh(cfg(), stopped());
    const on = { ...dohDraft(d), enabled: true };
    expect(dohOps(on, d, cfg(), stopped())).toEqual([]);
    expect(dohSwitch(on, d)).toBe(true);
    const ops = dohOps({ ...on, provider: 'quad9' }, d, cfg(), stopped());
    expect(ops.map((o) => o.op)).toEqual(['delete', 'delete', 'add']);
    expect(ops.at(-1)).toEqual({
      op: 'add',
      config: 'https-dns-proxy',
      type: 'https-dns-proxy',
      values: {
        resolver_url: 'https://dns.quad9.net/dns-query',
        bootstrap_dns: '9.9.9.9,149.112.112.112,2620:fe::fe,2620:fe::9',
        listen_port: '5053',
      },
    });
  });

  it('changes provider while running and cleans up for the reload that follows', () => {
    const d = normalizeDoh(cfg(), active());
    const custom = { ...dohDraft(d), provider: 'custom', customUrl: 'https://doh.example/dns-query' };
    expect(validateDoh(custom)).toEqual({});
    expect(validateDoh({ ...custom, customUrl: 'http://doh.example/dns-query' }).customUrl).toBeTruthy();
    const ops = dohOps(custom, d, cfg(), active());
    expect(ops.at(-2)).toMatchObject({ values: { resolver_url: 'https://doh.example/dns-query', bootstrap_dns: '1.1.1.1,8.8.8.8' } });
    expect(ops.at(-1)).toEqual(CLEAN);
    expect(dohSwitch(custom, d)).toBeUndefined();
  });

  it("keeps the user's servers out of a backup the proxy filled with its own entries", () => {
    // As left on the DL-WRX36 by a start while running (see model/doh.ts).
    const dhcp = active();
    const s = dhcp.cfg01411c!;
    s.server = ['/mask.icloud.com/', '/mask-h2.icloud.com/', '/use-application-dns.net/', '127.0.0.1#5053', '127.0.0.1#5054', '/corp/10.8.0.1'];
    s.doh_backup_server = ['', '9.9.9.9', '/mask.icloud.com/', '127.0.0.1#5053', '127.0.0.1#5054', '/corp/10.8.0.1'];
    s.doh_server = ['127.0.0.1#5053'];
    s.doh_backup_noresolv = '1';
    expect(dohDhcpCleanOps(dhcp, cfg())).toEqual([
      { op: 'set', config: 'dhcp', section: 'cfg01411c', values: { server: ['/corp/10.8.0.1', '9.9.9.9'] } },
      { op: 'unset', config: 'dhcp', section: 'cfg01411c', options: ['doh_server', 'doh_backup_server', 'doh_backup_noresolv'] },
    ]);
    expect(dohDhcpCleanOps(stopped(), cfg())).toEqual([]);
  });

  it('reads a custom resolver back as custom', () => {
    const c = cfg();
    c.cfg022d79!.resolver_url = 'https://doh.example/dns-query';
    expect(dohDraft(normalizeDoh(c, stopped()))).toEqual({ enabled: false, provider: 'custom', customUrl: 'https://doh.example/dns-query' });
  });
});
