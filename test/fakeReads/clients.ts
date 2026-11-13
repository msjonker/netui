// Connection table for the Clients and Insights pages: the DL-WRX36
// recording (luci getConntrackList, nf_conntrack_acct on). Tests that need
// traffic for dev-container clients override it per call.

import type { FakeReadHandler } from '../fakeRouter';
import type { ConntrackList } from '../../src/api/types';
import conntrackJson from '../fixtures/ubus/dl-wrx36/plain/luci.getConntrackList.json';

export const conntrack: ConntrackList = conntrackJson;

export const handle: FakeReadHandler = (object, method) =>
  object === 'luci' && method === 'getConntrackList' ? structuredClone(conntrack) : undefined;
