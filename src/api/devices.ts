// netui.devices, the gateway plugin that adopts access points and relays
// calls to them. Its methods report failures as { error } data, which these
// wrappers turn into thrown errors like any other ubus failure.

import { call, getSession, read, TransportError, UbusError } from './ubus';
import { APPLY_TIMEOUT_S, getConfig, type UciOp } from './uci';
import type {
  AdoptResult,
  AgentPorts,
  DeviceCredentials,
  DevicePluginError,
  DeviceStatusMap,
  ManagedDeviceList,
  PendingDeviceList,
  RelayBatchResult,
  RelayResult,
  SyncOutcome,
  SyncResult,
  UciChange,
  UciChangesAll,
  UciGet,
} from './types';
import type { ApplyDeps } from './apply';
import type { ApplyTarget } from './useApply';
import { AP_UNSUPPORTED, apSyncOps, gatewayVlans, hasVlans, readApLayout, type ApLayout, type GatewayVlans } from '../model/apPorts';
import { normalizeSwitch } from '../model/ports';

/** A device-level failure: wrong password, unreachable AP, not allowed. */
export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceError';
  }
}

function check<T extends DevicePluginError>(r: T): T {
  if (r.error) throw new DeviceError(r.error);
  return r;
}

export const listDevices = async () => check(await read<ManagedDeviceList & DevicePluginError>('netui.devices', 'list')).devices;

export const discoverDevices = async (): Promise<PendingDeviceList> =>
  check(await read<PendingDeviceList & DevicePluginError>('netui.devices', 'discover'));

/** `password` is the access point's current root password ('' on a fresh install). */
export async function adoptDevice(ip: string, password: string, name: string) {
  return check(await call<AdoptResult>('netui.devices', 'adopt', { ip, password, name })).device!;
}

export async function forgetDevice(mac: string) {
  check(await call<DevicePluginError>('netui.devices', 'forget', { mac }));
}

export async function renameDevice(mac: string, name: string) {
  check(await call<DevicePluginError>('netui.devices', 'rename', { mac, name }));
}

/**
 * Bring one device, or every online device without `mac`, in line with this
 * router: first its networks (the gateway's VLANs, see model/apPorts), then
 * the gateway plugin copies WiFi, mesh and steering.
 */
export async function syncDevices(mac?: string): Promise<Record<string, SyncOutcome>> {
  const gw = gatewayVlans(normalizeSwitch(await getConfig('network'), undefined, undefined, undefined));
  const macs = mac ? [mac] : (await listDevices()).filter((d) => d.online).map((d) => d.mac);
  const failed: Record<string, string> = {};
  const changed: string[] = [];
  for (const m of macs) {
    try {
      if (await syncDeviceNetwork(m, gw)) changed.push(m);
    } catch (e) {
      failed[m] = e instanceof Error ? e.message : String(e);
    }
  }
  const sync = async (m?: string) => (await call<SyncResult>('netui.devices', 'sync', m ? { mac: m } : {})).devices;
  const out = await sync(mac);
  // An access point whose bridge just restarted can still be settling (its
  // web server, its radios): give it a few more tries on its own.
  for (const m of changed) {
    for (let i = 0; i < SETTLE_RETRIES && out[m]?.error; i++) {
      await pause(SETTLE_PAUSE_MS);
      out[m] = (await sync(m))[m] ?? out[m]!;
    }
  }
  for (const [m, networkError] of Object.entries(failed)) out[m] = { ...out[m], networkError };
  return out;
}

const SETTLE_RETRIES = 5;
const SETTLE_PAUSE_MS = 5_000;

export interface DeviceNetwork {
  layout: ApLayout;
  network: UciGet['values'];
}

/** An access point's ports and networks. netui-agent before 0.4 cannot describe its ports (undefined). */
export async function readDeviceNetwork(mac: string): Promise<DeviceNetwork> {
  const [cfg, devices, ports] = await Promise.all([
    relay<UciGet>(mac, 'uci', 'get', { config: 'network' }),
    relay<DeviceStatusMap>(mac, 'network.device', 'status'),
    relay<AgentPorts>(mac, 'netui.agent', 'ports').catch(() => undefined),
  ]);
  return { layout: readApLayout(cfg.values, devices, ports), network: cfg.values };
}

/**
 * Moving an access point onto VLANs restarts its bridge (spanning tree holds
 * ports for ~8 s) and gives its LAN a new DHCP client ID, so it is back at a
 * new address after a while: allow more than the usual 30 s to confirm.
 */
const NETWORK_SYNC_TIMEOUT_S = 60;

/** Make one access point carry the gateway's VLANs. True if it changed anything. */
export async function syncDeviceNetwork(mac: string, gw: GatewayVlans): Promise<boolean> {
  const { layout, network } = await readDeviceNetwork(mac);
  if (layout.unsupported) {
    if (hasVlans(gw)) throw new DeviceError(`Networks not carried: ${AP_UNSUPPORTED[layout.unsupported]}`);
    return false;
  }
  const ops = apSyncOps(layout, gw, network);
  if (!ops.length) return false;
  await applyOnDevice(mac, ops, NETWORK_SYNC_TIMEOUT_S);
  return true;
}

export async function deviceCredentials(mac: string) {
  return check(await call<DeviceCredentials>('netui.devices', 'credentials', { mac }));
}

/**
 * One ubus call on an adopted access point, relayed by the gateway. Reads
 * made within RELAY_WINDOW_MS of each other for the same device go out as
 * one `netui.devices batch`: every relayed request is a connection from the
 * gateway to the device (over pinned HTTPS a handshake, ~0.2 s of both
 * routers' CPU on a slow one), and the gateway's rpcd waits for each. With
 * two access points the Devices page made 97 relayed requests a minute.
 * Writes go one at a time.
 */
export async function relay<T>(mac: string, object: string, method: string, args: object = {}, write = false): Promise<T> {
  if (!write) return queueRelay<T>(mac, { object, method, args });
  return relayResult<T>(check(await call<RelayResult<T>>('netui.devices', 'call', { mac, object, method, args })), object, method);
}

function relayResult<T>(r: RelayResult<unknown>, object: string, method: string): T {
  if (r.error) throw new DeviceError(r.error);
  if (r.status !== 0) throw new UbusError(r.status ?? -1, object, method);
  return r.data as T;
}

/** Long enough for the queries of one poll to meet; short enough not to notice. */
export const RELAY_WINDOW_MS = 50;
/** The gateway's limit (BATCH_MAX in netui-devices). */
const RELAY_BATCH_MAX = 32;

interface RelayCall {
  object: string;
  method: string;
  args: object;
}
interface PendingRelay {
  call: RelayCall;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
const relayQueues = new Map<string, PendingRelay[]>();

function queueRelay<T>(mac: string, c: RelayCall): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let q = relayQueues.get(mac);
    if (!q) {
      q = [];
      relayQueues.set(mac, q);
      setTimeout(() => void flushRelays(mac), RELAY_WINDOW_MS);
    }
    q.push({ call: c, resolve: resolve as (v: unknown) => void, reject });
  });
}

async function flushRelays(mac: string): Promise<void> {
  const pending = relayQueues.get(mac) ?? [];
  relayQueues.delete(mac);
  for (let i = 0; i < pending.length; i += RELAY_BATCH_MAX) {
    const part = pending.slice(i, i + RELAY_BATCH_MAX);
    if (part.length === 1) {
      const [p] = part as [PendingRelay];
      read<RelayResult<unknown>>('netui.devices', 'call', { mac, ...p.call }).then(
        (r) => settle(p, () => relayResult(r, p.call.object, p.call.method)),
        p.reject,
      );
      continue;
    }
    read<RelayBatchResult>('netui.devices', 'batch', { mac, calls: part.map((p) => p.call) }).then(
      (r) => {
        if (r.error || !r.results) {
          const e = new DeviceError(r.error ?? 'no answer');
          for (const p of part) p.reject(e);
          return;
        }
        part.forEach((p, k) => settle(p, () => relayResult(r.results![k] ?? { error: 'no answer' }, p.call.object, p.call.method)));
      },
      (e: unknown) => {
        for (const p of part) p.reject(e);
      },
    );
  }
}

function settle(p: PendingRelay, value: () => unknown): void {
  try {
    p.resolve(value());
  } catch (e) {
    p.reject(e);
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Change an access point's own config (its radio settings) with the same
 * safety net as on the gateway: stage, apply with rollback, then confirm
 * through the gateway. A change that cuts the device off is never
 * confirmed, so the device reverts on its own after 30 s.
 */
export async function applyOnDevice(mac: string, ops: UciOp[], timeout = APPLY_TIMEOUT_S): Promise<void> {
  const configs = [...new Set(ops.map((o) => o.config))];
  try {
    await stageOnDevice(mac, ops);
    await relay(mac, 'uci', 'apply', { rollback: true, timeout }, true);
  } catch (e) {
    for (const config of configs) await relay(mac, 'uci', 'revert', { config }, true).catch(() => {});
    throw e;
  }
  // Radios restart after apply; keep trying to confirm well inside the window.
  const deadline = Date.now() + (timeout - 8) * 1000;
  for (let i = 0; i === 0 || Date.now() < deadline; i++) {
    await pause(i ? 2_500 : 2_000);
    try {
      await relay(mac, 'uci', 'confirm', {}, true);
      return;
    } catch (e) {
      // 5: nothing pending any more, i.e. the device already rolled back.
      if (e instanceof UbusError && e.status === 5) throw new DeviceError('The access point could not keep the change and reverted it.');
    }
  }
  throw new DeviceError(`Could not confirm the change; the access point reverts it within ${timeout} seconds.`);
}

/** Stage ops on an access point, in the gateway's session there. */
export async function stageOnDevice(mac: string, ops: UciOp[]): Promise<void> {
  for (const o of ops) {
    if (o.op === 'set') {
      if (Object.keys(o.values).length) await relay(mac, 'uci', 'set', { config: o.config, section: o.section, values: o.values }, true);
    } else if (o.op === 'unset') {
      if (o.options.length) await relay(mac, 'uci', 'delete', { config: o.config, section: o.section, options: o.options }, true);
    } else if (o.op === 'add') {
      await relay(mac, 'uci', 'add', { config: o.config, type: o.type, ...(o.name ? { name: o.name } : {}), values: o.values }, true);
    } else await relay(mac, 'uci', 'delete', { config: o.config, section: o.section }, true);
  }
}

/**
 * The access point not answering (the gateway reports it unreachable) is to
 * the apply flow what a dropped connection is on the gateway: maybe the
 * change took its network down for a moment, so keep trying until the deadline.
 */
async function relayed<T>(mac: string, object: string, method: string, args: object = {}): Promise<T> {
  try {
    return await relay<T>(mac, object, method, args, true);
  } catch (e) {
    if (e instanceof DeviceError) throw new TransportError(e.message, { cause: e });
    throw e;
  }
}

/**
 * Review, apply and confirm on an access point with the same flow and dialog
 * as on the gateway (useApplyController(deviceApplyDeps(mac), deviceApplyTarget(mac))).
 * The access point's own rollback timer is the safety net: a change that cuts
 * it off from the gateway is never confirmed.
 */
export function deviceApplyDeps(mac: string): ApplyDeps {
  return {
    apply: (timeout) => relayed(mac, 'uci', 'apply', { rollback: true, timeout }),
    confirm: () => relayed(mac, 'uci', 'confirm'),
    revert: async (packages) => {
      for (const config of packages) await relayed(mac, 'uci', 'revert', { config });
    },
    // Access points never move the UI; nothing to probe or navigate to.
    probe: async () => false,
    sleep: async (ms) => {
      await pause(ms);
    },
    now: () => Date.now(),
    navigate: () => {},
    session: getSession,
    location: window.location,
  };
}

export function deviceApplyTarget(mac: string): ApplyTarget {
  return {
    stage: (ops) => stageOnDevice(mac, ops),
    changes: async () => (await relay<UciChangesAll>(mac, 'uci', 'changes')).changes ?? ({} as Record<string, UciChange[]>),
    revert: async (packages) => {
      for (const config of packages) await relay(mac, 'uci', 'revert', { config }, true);
    },
    after: async () => [],
  };
}

