import { describe, expect, it } from 'vitest';
import rec from '../../test/fixtures/ubus/dl-wrx36/plain/file.exec.diagnostics.json';
import { checkSteps, isTarget, parseLookup, parsePing } from './diagnostics';

describe('busybox output (recorded)', () => {
  it('reads ping statistics, total loss and a name that does not resolve', () => {
    expect(parsePing(rec.pingOk)).toMatchObject({ sent: 3, received: 3, error: undefined });
    expect(parsePing(rec.pingOk).avgMs).toBeGreaterThan(0);
    expect(parsePing(rec.pingLost)).toEqual({ sent: 3, received: 0, avgMs: undefined, error: undefined });
    expect(parsePing(rec.pingBadAddress)).toMatchObject({
      sent: 0,
      received: 0,
      error: "bad address 'no-such-host.invalid'",
    });
  });

  it('lists the addresses a lookup found, not the server', () => {
    expect(parseLookup(rec.nslookupOk)).toEqual(['64.226.122.113', '2a03:b0c0:3:d0::1a51:c001']);
    expect(parseLookup(rec.nslookupNxdomain)).toEqual([]);
  });
});

describe('isTarget', () => {
  it('takes host names and addresses, nothing that reads as an option', () => {
    for (const ok of ['openwrt.org', '1.1.1.1', 'router.lan', '2606:4700:4700::1111', 'nas', 'a_b.example.'])
      expect(isTarget(ok)).toBe(true);
    for (const bad of ['-f', '--help', 'a b', '', 'host;reboot', '-c 1000 x', 'exa$mple.com'])
      expect(isTarget(bad)).toBe(false);
  });
});

describe('connection check', () => {
  const ok = parsePing(rec.pingOk);
  const lost = parsePing(rec.pingLost);
  const states = (s: ReturnType<typeof checkSteps>) => s.map((x) => x.state);

  it('passes every step on a working connection', () => {
    const s = checkSteps({
      carrier: true,
      address: '192.168.0.127',
      gateway: '192.168.0.1',
      gatewayPing: ok,
      internetPing: ok,
      internetTarget: '1.1.1.1',
      lookup: ['64.226.122.113'],
    });
    expect(states(s)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(s[2]!.detail).toMatch(/^192\.168\.0\.1, 1 ms$/);
  });

  it('stops at a missing cable or address, with advice', () => {
    const s = checkSteps({ carrier: false });
    expect(states(s)).toEqual(['fail', 'skip', 'skip', 'skip', 'skip']);
    expect(s[0]!.detail).toMatch(/cable/);
    expect(states(checkSteps({ carrier: true }))).toEqual(['ok', 'fail', 'skip', 'skip', 'skip']);
  });

  it('only warns about a silent gateway when the internet answers', () => {
    const base = { carrier: true, address: '100.71.3.9', gateway: '100.64.0.1', gatewayPing: lost };
    expect(states(checkSteps(base))).toEqual(['ok', 'ok', 'skip', 'skip', 'skip']);
    expect(states(checkSteps({ ...base, internetPing: ok, lookup: ['1.2.3.4'] }))).toEqual([
      'ok',
      'ok',
      'warn',
      'ok',
      'ok',
    ]);
    expect(states(checkSteps({ ...base, internetPing: lost, lookup: [] }))).toEqual([
      'ok',
      'ok',
      'fail',
      'fail',
      'fail',
    ]);
  });

  it('blames DNS when the internet answers but names do not resolve', () => {
    const s = checkSteps({ carrier: true, address: '81.2.69.160', gatewayPing: ok, internetPing: ok, lookup: [] });
    expect(states(s)).toEqual(['ok', 'ok', 'ok', 'ok', 'fail']);
    expect(s[4]!.detail).toMatch(/DNS servers/);
  });
});
