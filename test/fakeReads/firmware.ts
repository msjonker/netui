// netui.firmware for component tests, on the gateway and (through
// netui.devices call, see devices.ts) on access points. A check finishes at
// once with the recorded result; an upgrade goes straight to installing, and
// the next status after that is a freshly booted device with no job.

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import type { FirmwareStatus } from '../../src/api/types';
import idle from '../fixtures/ubus/bench-v2/netui.firmware.status.idle.json';
import checked from '../fixtures/ubus/bench-v2/netui.firmware.status.checked.json';
import installing from '../fixtures/ubus/bench-v2/netui.firmware.status.upgrade-installing.synthetic.json';

interface State {
  status: FirmwareStatus;
  /** Flashing: report the installing job once, then come back idle. */
  rebooting?: boolean;
}

const states = new WeakMap<FakeRouter, Map<string, State>>();

function stateOf(router: FakeRouter, mac: string): State {
  let m = states.get(router);
  if (!m) states.set(router, (m = new Map()));
  let s = m.get(mac);
  if (!s) m.set(mac, (s = { status: structuredClone(idle) as FirmwareStatus }));
  return s;
}

/** `mac` '' is the gateway. */
export function seedFirmware(router: FakeRouter, mac: string, status: FirmwareStatus): void {
  stateOf(router, mac).status = structuredClone(status);
}

export function firmwareCall(router: FakeRouter, mac: string, method: string, args: Record<string, unknown>): unknown {
  const s = stateOf(router, mac);
  switch (method) {
    case 'status': {
      const out = structuredClone(s.status);
      if (s.rebooting) {
        s.rebooting = false;
        s.status = { ...structuredClone(idle), installed: s.status.job?.version ?? undefined } as FirmwareStatus;
      }
      return out;
    }
    case 'check':
      s.status = structuredClone(checked) as FirmwareStatus;
      return { result: true };
    case 'upgrade': {
      const status = structuredClone(installing) as FirmwareStatus;
      status.job!.version = args.version as string;
      s.status = status;
      s.rebooting = true;
      return { result: true };
    }
  }
  return undefined;
}

export const handle: FakeReadHandler = (object, method, args, router) =>
  object === 'netui.firmware' ? firmwareCall(router, '', method, args) : undefined;
