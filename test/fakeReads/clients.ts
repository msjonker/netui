// Connection table for the Clients and Insights pages: the DL-WRX36
// recording (netui.traffic connections, nf_conntrack_acct on). Tests that need
// traffic for dev-container clients override it per call.

import type { FakeReadHandler } from '../fakeRouter';
import type { ConnectionsReply } from '../../src/api/types';
import conntrackJson from '../fixtures/ubus/dl-wrx36/plain/netui.traffic.connections.json';

export const conntrack: ConnectionsReply = conntrackJson;

export const handle: FakeReadHandler = (object, method) =>
  object === 'netui.traffic' && method === 'connections' ? structuredClone(conntrack) : undefined;
