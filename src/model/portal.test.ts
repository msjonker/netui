import { describe, expect, it } from 'vitest';
import type { UciGet } from '../api/types';
import recorded from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.opennds.json';
import { portalDraft, portalOps, readPortal, sessionLabel, validatePortal } from './portal';
import type { Network } from './network';

const cfg = () => structuredClone((recorded as UciGet).values);
const net = (id: string, device: string): Network => ({ id, proto: 'static', device, addressForm: 'cidr-list', extraAddresses: [] });
const networks = [net('lan', 'br-lan'), net('guest', 'br-guest')];

describe('guest portal', () => {
  it('reads the bench config: off, defaults, the guest network suggested', () => {
    const p = readPortal(cfg(), networks);
    expect(p).toMatchObject({ section: 'setup', enabled: false, network: undefined, login: 'click', sessionMinutes: 1440 });
    // No gatewayinterface means br-lan, the LAN: suggest another network instead.
    expect(portalDraft(p, networks).network).toBe('guest');
  });

  it('maps a device name back to its network', () => {
    const c = cfg();
    c.setup!.gatewayinterface = 'br-guest';
    expect(readPortal(c, networks).network).toBe('guest');
  });

  it('turns the portal on for a network with name, sign-in, session and speed limits', () => {
    const d = { ...portalDraft(readPortal(cfg(), networks), networks), enabled: true, network: 'guest', name: "Matt's Guests", login: 'email' as const, sessionMinutes: 240, downMbps: '25', upMbps: '5' };
    expect(validatePortal(d)).toEqual({});
    expect(portalOps(d, cfg(), networks)).toEqual([
      {
        op: 'set',
        config: 'opennds',
        section: 'setup',
        values: {
          enabled: '1',
          gatewayinterface: 'br-guest',
          gatewayname: 'Matt&#39;s Guests',
          login_option_enabled: '2',
          sessiontimeout: '240',
          downloadrate: '25000',
          uploadrate: '5000',
          enable_serial_number_suffix: '0',
        },
      },
    ]);
  });

  it('turns it off without touching the rest', () => {
    const c = cfg();
    c.setup!.enabled = '1';
    const d = { ...portalDraft(readPortal(c, networks), networks), enabled: false };
    expect(portalOps(d, c, networks)).toEqual([{ op: 'set', config: 'opennds', section: 'setup', values: { enabled: '0' } }]);
  });

  it('validates and labels', () => {
    expect(validatePortal({ enabled: true, network: '', name: ' ', login: 'click', sessionMinutes: 60, downMbps: '-1', upMbps: '' })).toMatchObject({
      network: expect.any(String),
      name: expect.any(String),
      downMbps: expect.any(String),
    });
    expect([60, 240, 1440, 10080, 0].map(sessionLabel)).toEqual(['1 hour', '4 hours', '1 day', '7 days', 'No limit']);
  });
});
