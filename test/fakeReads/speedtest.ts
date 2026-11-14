// netui.speedtest for component tests: a run starts, the next status still
// shows it running, and the one after that has the recorded result.

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import type { SpeedTestStatus } from '../../src/api/types';
import idle from '../fixtures/ubus/bench-v2/netui.speedtest.status.idle.json';
import running from '../fixtures/ubus/bench-v2/netui.speedtest.status.running.json';
import done from '../fixtures/ubus/bench-v2/netui.speedtest.status.done.json';

const states = new WeakMap<FakeRouter, { status: SpeedTestStatus; polls?: number }>();

const stateOf = (r: FakeRouter) => {
  let s = states.get(r);
  if (!s) states.set(r, (s = { status: structuredClone(idle) as SpeedTestStatus }));
  return s;
};

export function seedSpeedTest(r: FakeRouter, status: SpeedTestStatus): void {
  stateOf(r).status = structuredClone(status);
}

export const handle: FakeReadHandler = (object, method, _args, router) => {
  if (object !== 'netui.speedtest') return undefined;
  const s = stateOf(router);
  if (method === 'start') {
    if (s.status.running) return { error: 'a speed test is already running' };
    s.status = structuredClone(running) as SpeedTestStatus;
    s.polls = 0;
    return { result: true };
  }
  if (method === 'status') {
    const out = structuredClone(s.status);
    if (s.status.running && ++s.polls! > 1) s.status = structuredClone(done) as SpeedTestStatus;
    return out;
  }
  return undefined;
};
