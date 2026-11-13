import { describe, expect, it } from 'vitest';
import { fixtures, wrxFixtures } from '../../test/fixtures';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import {
  activeRoutes,
  gatewayOnLink,
  newStaticRoute,
  normalizeStaticRoutes,
  staticRouteOps,
  validateStaticRoute,
} from './routing';

const network = () => {
  const n = wrxFixtures('plain').uci.network();
  n.r1 = {
    '.anonymous': true, '.index': 9, '.name': 'r1', '.type': 'route',
    interface: 'lan', target: '10.20.0.0', netmask: '255.255.0.0', gateway: '192.168.1.254',
  };
  n.r2 = {
    '.anonymous': true, '.index': 10, '.name': 'r2', '.type': 'route',
    interface: 'lan', target: '172.16.5.0/24', metric: '10', disabled: '1', name: 'Lab',
  };
  return n;
};

describe('static routes', () => {
  it('reads both target forms', () => {
    expect(normalizeStaticRoutes(network())).toEqual([
      { section: 'r1', name: '', enabled: true, target: '10.20.0.0/16', gateway: '192.168.1.254', interface: 'lan', metric: '' },
      { section: 'r2', name: 'Lab', enabled: false, target: '172.16.5.0/24', gateway: '', interface: 'lan', metric: '10' },
    ]);
    expect(normalizeStaticRoutes(wrxFixtures('plain').uci.network())).toEqual([]);
  });

  it('adds a route without empty options', () => {
    const r = { ...newStaticRoute(), target: '10.9.0.0/24', gateway: '192.168.1.2', name: 'VPN' };
    expect(staticRouteOps(r, network())).toEqual([
      {
        op: 'add',
        config: 'network',
        type: 'route',
        values: { name: 'VPN', interface: 'lan', target: '10.9.0.0/24', gateway: '192.168.1.2' },
      },
    ]);
  });

  it('edits in the stored form and enables', () => {
    const n = network();
    const [r1, r2] = normalizeStaticRoutes(n);
    const out = stageOn(new FakeRouter({ network: n }), [
      ...staticRouteOps({ ...r1!, target: '10.21.0.0/24' }, n),
      ...staticRouteOps({ ...r2!, enabled: true, metric: '' }, n),
    ]);
    expect(out.network!.r1).toMatchObject({ target: '10.21.0.0', netmask: '255.255.255.0' });
    expect(out.network!.r2).not.toHaveProperty('disabled');
    expect(out.network!.r2).not.toHaveProperty('metric');
  });

  it('validates', () => {
    const ctx = { interfaces: ['lan', 'wan'], routes: normalizeStaticRoutes(network()) };
    expect(validateStaticRoute({ ...newStaticRoute(), target: '10.20.0.0/16', gateway: '192.168.1.254' }, ctx)).toEqual({
      target: 'A route to this network already exists.',
    });
    expect(validateStaticRoute({ ...newStaticRoute(), target: '10.0.0.5/24', gateway: 'x', interface: 'nope', metric: '-1' }, ctx)).toEqual({
      target: expect.stringContaining('10.0.0.0/24'),
      gateway: expect.any(String),
      interface: expect.any(String),
      metric: expect.any(String),
    });
    expect(validateStaticRoute({ ...newStaticRoute(), target: '10.0.0.0' }, ctx).target).toBeTruthy();
    expect(validateStaticRoute({ ...newStaticRoute(), target: '0.0.0.0/0', interface: 'wan' }, ctx)).toEqual({});
  });
});

describe('active routes', () => {
  it('lists connected networks and netifd routes of up interfaces', () => {
    expect(activeRoutes(fixtures.ifaceDump())).toEqual([
      { target: '10.231.1.0/24', via: '', interface: 'lan', device: 'br-lan', kind: 'connected' },
      { target: '10.231.0.0/24', via: '', interface: 'wan', device: 'eth1', kind: 'connected' },
      { target: '0.0.0.0/0', via: '10.231.0.1', interface: 'wan', device: 'eth1', kind: 'route' },
    ]);
  });

  it('checks the gateway is on the interface subnet', () => {
    const dump = fixtures.ifaceDump();
    expect(gatewayOnLink('10.231.0.9', 'wan', dump)).toBe(true);
    expect(gatewayOnLink('10.9.9.9', 'wan', dump)).toBe(false);
    expect(gatewayOnLink('10.9.9.9', 'wan6', dump)).toBeUndefined();
  });
});
