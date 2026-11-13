// `log read` for the System Log, notifications and the dashboard: the real
// DL-WRX36 recording followed by the hand-written supplement (see
// test/fixtures/ubus/dl-wrx36/log.read.synthetic.txt). Change it per test
// with router.overrides.

import type { FakeReadHandler } from '../fakeRouter';
import type { LogRead } from '../../src/api/types';
import real from '../fixtures/ubus/dl-wrx36/plain/log.read.json';
import synthetic from '../fixtures/ubus/dl-wrx36/log.read.synthetic.json';

const recorded: LogRead = real;
const extra: LogRead = synthetic;

export const handle: FakeReadHandler = (object, method, args) => {
  if (object !== 'log' || method !== 'read') return undefined;
  const lines = typeof args.lines === 'number' ? args.lines : 100;
  return { log: structuredClone([...recorded.log, ...extra.log].slice(-lines)) };
};
