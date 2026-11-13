import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet, UpnpStatus } from '../api/types';
import upnpdJson from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.upnpd.json';
import statusJson from '../../test/fixtures/ubus/dl-wrx36/plain/luci.upnp.get_status.json';
import { normalizeUpnp, upnpOps } from './upnp';

const recorded: { cfg: UciGet; status: UpnpStatus } = { cfg: upnpdJson, status: statusJson };
const cfg = (): UciConfig => structuredClone(recorded.cfg.values);

describe('upnp', () => {
  it('reads the factory config', () => {
    expect(normalizeUpnp(cfg())).toEqual({ section: 'config', enabled: false, upnp: true, natpmp: true, secure: true });
    expect(recorded.status.rules).toEqual([]);
  });

  it('writes only the flags that changed', () => {
    const c = cfg();
    const u = normalizeUpnp(c)!;
    expect(upnpOps({ enabled: true, upnp: true, natpmp: false, secure: true }, u, c)).toEqual([
      { op: 'set', config: 'upnpd', section: 'config', values: { enabled: '1', enable_natpmp: '0' } },
    ]);
    expect(upnpOps({ enabled: false, upnp: true, natpmp: true, secure: true }, u, c)).toEqual([]);
  });

  it('is undefined without an upnpd section', () => {
    expect(normalizeUpnp({})).toBeUndefined();
  });
});
