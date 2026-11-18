// netui.devices for component tests: the gateway plugin with in-memory state,
// answering from the bench recordings (test/fixtures/ubus/bench-v2).
// Each FakeRouter starts with no devices; seed them with seedDevices().

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import { firmwareCall } from './firmware';
import { packagesCall } from './packages';
import type { AgentPorts, AssocStation, ManagedDevice, ManagedDeviceList, PendingDevice, PendingDeviceList, UciChange, UciConfig } from '../../src/api/types';
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
import apWireless from '../fixtures/ubus/bench-v2/netui.devices.call.uci.get.wireless.json';
import r1info from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.info.radio1.json';
import r1freq from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.freqlist.radio1.json';
import r1pow from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.txpowerlist.radio1.json';
import r2info from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.info.radio2.json';
import r2freq from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.freqlist.radio2.json';
import r2pow from '../fixtures/ubus/bench-v2/netui.devices.call.iwinfo.txpowerlist.radio2.json';
import { apFixtures } from '../fixtures';

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
  /** Stations associated to the AP's 5 GHz WiFi (phy1-ap0); none were recorded on the bench. */
  stations?: AssocStation[];
  /** The AP's network config (test/fixtures/ubus/ap/ax3600 unless seeded). */
  apNetwork?: UciConfig;
  /** netui.agent ports; null for an agent older than 0.4. */
  agentPorts?: AgentPorts | null;
  /** Changes staged on the AP through the relay, as `uci changes` lists them. */
  apStaged?: Record<string, UciChange[]>;
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
  'iwinfo.info.radio1': r1info,
  'iwinfo.freqlist.radio1': r1freq,
  'iwinfo.txpowerlist.radio1': r1pow,
  'iwinfo.info.radio2': r2info,
  'iwinfo.freqlist.radio2': r2freq,
  'iwinfo.txpowerlist.radio2': r2pow,
};

/** Staging and applying on the AP itself (per-device radio settings) succeeds. */
const AP_WRITES = new Set(['uci.set', 'uci.delete', 'uci.add', 'uci.apply', 'uci.confirm', 'uci.revert']);

/** Keep a `uci changes` list of what was staged on the AP (one entry per option is enough for the review). */
function stageOnAp(s: State, key: string, a: Record<string, unknown>): void {
  const config = String(a.config ?? '');
  const add = (c: UciChange) => ((s.apStaged ??= {})[config] ??= []).push(c);
  if (key === 'uci.set') for (const [k, v] of Object.entries((a.values ?? {}) as Record<string, unknown>)) add(['set', String(a.section), k, Array.isArray(v) ? v.join(' ') : String(v)]);
  else if (key === 'uci.add') add(['add', String(a.name ?? 'cfgnew'), String(a.type)]);
  else if (key === 'uci.delete') add(['remove', String(a.section)]);
  else if (key === 'uci.revert' || key === 'uci.apply') delete s.apStaged?.[config];
  if (key === 'uci.apply') s.apStaged = {};
}

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
      if (args.object === 'netui.firmware') return { status: 0, data: firmwareCall(router, known.mac, args.method as string, a) };
      if (args.object === 'netui.packages') return { status: 0, data: packagesCall(router, known.mac, args.method as string, a) };
      if (key === 'iwinfo.devices' && s.mesh) return structuredClone(iwDevicesMesh);
      if (key === 'uci.get' && a.config === 'wireless') return structuredClone(apWireless);
      if (key === 'uci.get' && a.config === 'network') return { status: 0, data: { values: structuredClone(s.apNetwork ?? apFixtures('ax3600').uci.network()) } };
      if (key === 'netui.agent.ports') return s.agentPorts === null ? structuredClone(denied) : { status: 0, data: structuredClone(s.agentPorts ?? apFixtures('ax3600').ports()) };
      if (AP_WRITES.has(key)) {
        stageOnAp(s, key, a);
        return { status: 0 };
      }
      if (key === 'uci.changes') return { status: 0, data: { changes: structuredClone(s.apStaged ?? {}) } };
      if (key === 'iwinfo.assoclist.phy1-ap0' && s.stations) return { status: 0, data: { results: structuredClone(s.stations) } };
      return key in RELAYED ? structuredClone(RELAYED[key]) : structuredClone(denied);
    }
  }
  return undefined;
};
