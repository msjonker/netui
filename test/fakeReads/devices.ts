// netui.devices for component tests: the gateway plugin with in-memory state,
// answering from the bench recordings (test/fixtures/ubus/bench-v2).
// Each FakeRouter starts with no devices; seed them with seedDevices().

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import type { ManagedDevice, ManagedDeviceList, PendingDevice, PendingDeviceList } from '../../src/api/types';
import listJson from '../fixtures/ubus/bench-v2/netui.devices.list.json';
import discoverJson from '../fixtures/ubus/bench-v2/netui.devices.discover.json';
import syncJson from '../fixtures/ubus/bench-v2/netui.devices.sync.json';
import wrongPassword from '../fixtures/ubus/bench-v2/netui.devices.adopt.wrong-password.json';
import denied from '../fixtures/ubus/bench-v2/netui.devices.call.denied.json';
import systemInfo from '../fixtures/ubus/bench-v2/netui.devices.call.system.info.json';
import systemBoard from '../fixtures/ubus/bench-v2/netui.devices.call.system.board.json';
import iwDevices from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.devices.json';
import info5 from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.info.phy1-ap0.json';
import info2 from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.info.phy2-ap0.json';
import assoc5 from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.assoclist.phy1-ap0.json';
import assoc2 from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.assoclist.phy2-ap0.json';
import credentials from '../fixtures/ubus/bench-v2/netui.devices.credentials.json';
import links from '../fixtures/ubus/bench-v2/netui.devices.call.network.device.status.json';
import iwDevicesMesh from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.devices.mesh.json';
import infoMesh from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.info.phy1-mesh0.json';
import assocMesh from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.assoclist.phy1-mesh0.json';

const recordedList: ManagedDeviceList = listJson;
const recordedPending: PendingDeviceList = discoverJson;

/** The adopted AX3600 and the same unit as it looked before adoption. */
export const recorded = {
  device: recordedList.devices[0]!,
  pending: recordedPending.devices[0]!,
};

interface State {
  managed: ManagedDevice[];
  pending: PendingDevice[];
  /** The AP also runs the mesh backhaul (phy1-mesh0), as recorded with the cable in. */
  mesh?: boolean;
}

const states = new WeakMap<FakeRouter, State>();
const stateOf = (r: FakeRouter) => {
  let s = states.get(r);
  if (!s) states.set(r, (s = { managed: [], pending: [] }));
  return s;
};

export function seedDevices(r: FakeRouter, seed: Partial<State>): void {
  Object.assign(stateOf(r), structuredClone(seed));
}

const RELAYED: Record<string, unknown> = {
  'system.info': systemInfo,
  'system.board': systemBoard,
  'iwinfo.devices': iwDevices,
  'iwinfo.info.phy1-ap0': info5,
  'iwinfo.info.phy2-ap0': info2,
  'iwinfo.assoclist.phy1-ap0': assoc5,
  'iwinfo.assoclist.phy2-ap0': assoc2,
  'iwinfo.info.phy1-mesh0': infoMesh,
  'iwinfo.assoclist.phy1-mesh0': assocMesh,
  'network.device.status': links,
};

export const handle: FakeReadHandler = (object, method, args, router) => {
  if (object !== 'netui.devices') return undefined;
  const s = stateOf(router);
  const mac = args.mac as string | undefined;
  const known = s.managed.find((d) => d.mac === mac);
  switch (method) {
    case 'list':
      return { devices: structuredClone(s.managed) };
    case 'discover':
      return { devices: structuredClone(s.pending) };
    case 'adopt': {
      if (args.password === 'wrong') return structuredClone(wrongPassword);
      const p = s.pending.find((d) => d.ip === args.ip);
      if (!p) return { error: 'unreachable' };
      s.pending = s.pending.filter((d) => d !== p);
      const device: ManagedDevice = { ...recorded.device, mac: p.mac, ip: p.ip, name: (args.name as string) || p.model || 'AP' };
      s.managed.push(device);
      return { device };
    }
    case 'forget':
      if (!known) return { error: 'unknown device' };
      s.managed = s.managed.filter((d) => d !== known);
      return { result: true };
    case 'rename':
      if (!known) return { error: 'unknown device' };
      known.name = args.name as string;
      return { result: true, networks: 2, skipped: [] };
    case 'sync':
      return mac ? { devices: { [mac]: (syncJson as { devices: Record<string, unknown> }).devices[recorded.device.mac] } } : syncJson;
    case 'credentials':
      return known ? { ...credentials, password: 'ap-root-secret' } : { error: 'unknown device' };
    case 'call': {
      if (!known) return { error: 'unknown device' };
      const a = (args.args ?? {}) as Record<string, unknown>;
      const key = [args.object, args.method, a.device].filter(Boolean).join('.');
      if (key === 'system.reboot') return { status: 0 };
      if (key === 'iwinfo.devices' && s.mesh) return structuredClone(iwDevicesMesh);
      return key in RELAYED ? structuredClone(RELAYED[key]) : structuredClone(denied);
    }
  }
  return undefined;
};
