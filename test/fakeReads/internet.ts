// luci.upnp / luci.ddns for the Internet page. Rules and service status come
// from the DL-WRX36 recordings; tests swap them with router.overrides.

import type { FakeReadHandler } from '../fakeRouter';
import type { DdnsServicesStatus, MwanStatus, UpnpStatus } from '../../src/api/types';
import mwanStatus from '../fixtures/ubus/bench-v2/gateway.mwan3.status.json';
import mwanNoLink from '../fixtures/ubus/bench-v2/gateway.mwan3.status.wan2-no-link.json';
import upnpStatus from '../fixtures/ubus/dl-wrx36/plain/luci.upnp.get_status.json';
import ddnsStatus from '../fixtures/ubus/dl-wrx36/plain/luci.ddns.get_services_status.json';

const upnp: UpnpStatus = upnpStatus;
const ddns: DdnsServicesStatus = ddnsStatus;

/** mwan3 status as recorded, before WAN2 and with WAN2 on a port with nothing plugged in. */
const mwan3Status = (enabled: boolean) => structuredClone(enabled ? mwanNoLink : mwanStatus) as MwanStatus;

export const handle: FakeReadHandler = (object, method, _args, router) => {
  if (object === 'mwan3' && method === 'status') {
    const m = router.current('mwan3');
    if (!m) return undefined;
    return mwan3Status(m.wanb?.enabled === '1' && !!router.current('network')?.wanb);
  }
  if (object === 'luci.upnp' && method === 'get_status') return structuredClone(upnp);
  if (object === 'luci.upnp' && method === 'delete_rule') return { result: 'OK' };
  if (object === 'luci.ddns' && method === 'get_services_status') return structuredClone(ddns);
  return undefined;
};
