import { describe, expect, it } from 'vitest';
import rec from '../../test/fixtures/ubus/dl-wrx36/plain/netui.services.tunnel.json';
import type { TunnelStatus } from '../api/types';
import { normalizeTunnel, parseTunnelToken, removeTunnelOps, tunnelOps, tunnelProblem } from './tunnel';

const status = (s: object) => structuredClone(s) as TunnelStatus;

/** A token shaped like the dashboard's (base64 JSON), with made-up values. */
const TOKEN = btoa(JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: '6f1c2a9e-3b7d-4c55-9a10-2e8f4d7b6c31', s: 'c2VjcmV0LXNlY3JldA==' }));

describe('normalizeTunnel (recorded, cloudflared 2026.10.6)', () => {
  it('reads a connected tunnel', () => {
    expect(normalizeTunnel(status(rec.connected))).toEqual({
      state: 'connected',
      enabled: true,
      configFile: false,
      tunnelId: '6f1c2a9e-3b7d-4c55-9a10-2e8f4d7b6c31',
      connections: 4,
      locations: ['ord02', 'ord06', 'ord08', 'ord11'],
    });
  });

  it('explains a token the tunnel service rejects', () => {
    const t = normalizeTunnel(status(rec.rejected))!;
    expect(t.state).toBe('failed');
    expect(t.problem).toMatch(/did not accept the token/);
    expect(t.detail).toBe('Register tunnel error from server side: Failed to get tunnel');
  });

  it('is off, not failed, when switched off (the shutdown message is not an error to show)', () => {
    const t = normalizeTunnel(status(rec.off))!;
    expect(t).toMatchObject({ state: 'off', enabled: false });
    expect(t.problem).toBeUndefined();
  });

  it('tells a missing package from a tunnel not set up', () => {
    expect(normalizeTunnel(status(rec.notInstalled))?.state).toBe('not-installed');
    expect(normalizeTunnel(status(rec.notSetUp))?.state).toBe('not-set-up');
  });

  it('is connecting while running without a connection or an error', () => {
    expect(normalizeTunnel({ ...status(rec.connected), connections: 0, locations: [] })?.state).toBe('connecting');
  });

  it('fails when enabled but not running (procd gave up)', () => {
    const t = normalizeTunnel({ ...status(rec.connected), running: false, connections: null, error: null })!;
    expect(t.state).toBe('failed');
    expect(t.problem).toMatch(/not running/);
  });

  it('shows a tunnel run from a config file, which has no token', () => {
    expect(normalizeTunnel({ ...status(rec.notSetUp), enabled: true, config_file: true, running: true, connections: 2 })).toMatchObject({
      state: 'connected',
      configFile: true,
    });
  });
});

describe('tunnelProblem', () => {
  it('names a network problem', () => {
    expect(tunnelProblem('Failed to dial a quic connection: lookup region1.v2.argotunnel.com: no such host')).toMatch(/Check that the router is online/);
  });

  it('passes anything else through', () => {
    expect(tunnelProblem('something new')).toBe('something new');
  });
});

describe('parseTunnelToken', () => {
  it('takes the token out of the install commands the dashboard shows', () => {
    for (const text of [
      `cloudflared service install ${TOKEN}`,
      `sudo cloudflared service install ${TOKEN}\n`,
      `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${TOKEN}`,
      `  ${TOKEN}  `,
    ]) {
      expect(parseTunnelToken(text)).toEqual({ token: TOKEN, tunnelId: '6f1c2a9e-3b7d-4c55-9a10-2e8f4d7b6c31' });
    }
  });

  it('accepts the URL-safe alphabet', () => {
    const token = btoa(JSON.stringify({ a: 'a', t: 't-1', s: '>>>???' })).replace(/\+/g, '-').replace(/\//g, '_');
    expect(parseTunnelToken(token)).toMatchObject({ tunnelId: 't-1' });
  });

  it('rejects anything else', () => {
    expect(parseTunnelToken('')).toEqual({ error: expect.stringMatching(/Paste/) });
    expect(parseTunnelToken('hello there')).toEqual({ error: expect.stringMatching(/not a tunnel token/) });
    // base64 JSON without the secret
    expect(parseTunnelToken(btoa(JSON.stringify({ a: 'x', t: 'y', other: 'zzzzzzzzzzzzzzzzzzz' })))).toHaveProperty('error');
  });
});

describe('tunnelOps', () => {
  it('sets the package’s own section', () => {
    expect(tunnelOps(status(rec.notSetUp), true, TOKEN)).toEqual([
      { op: 'set', config: 'cloudflared', section: 'config', values: { enabled: '1', token: TOKEN } },
    ]);
    expect(tunnelOps(status(rec.connected), false)).toEqual([
      { op: 'set', config: 'cloudflared', section: 'config', values: { enabled: '0' } },
    ]);
  });

  it('adds the section when it was removed by hand, with the log file the status reads', () => {
    expect(tunnelOps({ ...status(rec.notSetUp), section: false }, true, TOKEN)).toEqual([
      {
        op: 'add',
        config: 'cloudflared',
        type: 'cloudflared',
        name: 'config',
        values: { enabled: '1', token: TOKEN, logfile: '/var/log/cloudflared.log' },
      },
    ]);
  });

  it('removes: off, token gone', () => {
    expect(removeTunnelOps(status(rec.connected))).toEqual([
      { op: 'set', config: 'cloudflared', section: 'config', values: { enabled: '0' } },
      { op: 'unset', config: 'cloudflared', section: 'config', options: ['token'] },
    ]);
    expect(removeTunnelOps({ ...status(rec.notSetUp), section: false })).toEqual([]);
  });
});
