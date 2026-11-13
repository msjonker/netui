// luci.upnp / luci.ddns for the Internet page. Rules and service status come
// from the DL-WRX36 recordings; tests swap them with router.overrides.

import type { FakeReadHandler } from '../fakeRouter';
import type { DdnsServicesStatus, UpnpStatus } from '../../src/api/types';
import upnpStatus from '../fixtures/ubus/dl-wrx36/plain/luci.upnp.get_status.json';
import ddnsStatus from '../fixtures/ubus/dl-wrx36/plain/luci.ddns.get_services_status.json';

const upnp: UpnpStatus = upnpStatus;
const ddns: DdnsServicesStatus = ddnsStatus;

export const handle: FakeReadHandler = (object, method) => {
  if (object === 'luci.upnp' && method === 'get_status') return structuredClone(upnp);
  if (object === 'luci.upnp' && method === 'delete_rule') return { result: 'OK' };
  if (object === 'luci.ddns' && method === 'get_services_status') return structuredClone(ddns);
  return undefined;
};
