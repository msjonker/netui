// netui.devices, the gateway plugin that adopts access points and relays
// calls to them. Its methods report failures as { error } data, which these
// wrappers turn into thrown errors like any other ubus failure.

import { call, read, UbusError } from './ubus';
import { APPLY_TIMEOUT_S, type UciOp } from './uci';
import type {
  AdoptResult,
  DeviceCredentials,
  DevicePluginError,
  ManagedDeviceList,
  PendingDeviceList,
  RelayResult,
  SyncResult,
} from './types';

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

export const discoverDevices = async () =>
  check(await read<PendingDeviceList & DevicePluginError>('netui.devices', 'discover')).devices;

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

/** Mirror the gateway's LAN WiFi onto one device, or every device without `mac`. */
export async function syncDevices(mac?: string) {
  return (await call<SyncResult>('netui.devices', 'sync', mac ? { mac } : {})).devices;
}

export async function deviceCredentials(mac: string) {
  return check(await call<DeviceCredentials>('netui.devices', 'credentials', { mac }));
}

/** One ubus call on an adopted access point, relayed by the gateway. */
export async function relay<T>(mac: string, object: string, method: string, args: object = {}, write = false): Promise<T> {
  const send = write ? call : read;
  const r = check(await send<RelayResult<T>>('netui.devices', 'call', { mac, object, method, args }));
  if (r.status !== 0) throw new UbusError(r.status ?? -1, object, method);
  return r.data as T;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Change an access point's own config (its radio settings) with the same
 * safety net as on the gateway: stage, apply with rollback, then confirm
 * through the gateway. A change that cuts the device off is never
 * confirmed, so the device reverts on its own after 30 s.
 */
export async function applyOnDevice(mac: string, ops: UciOp[]): Promise<void> {
  const configs = [...new Set(ops.map((o) => o.config))];
  try {
    for (const o of ops) {
      if (o.op === 'set') await relay(mac, 'uci', 'set', { config: o.config, section: o.section, values: o.values }, true);
      else if (o.op === 'unset') await relay(mac, 'uci', 'delete', { config: o.config, section: o.section, options: o.options }, true);
      else if (o.op === 'add')
        await relay(mac, 'uci', 'add', { config: o.config, type: o.type, ...(o.name ? { name: o.name } : {}), values: o.values }, true);
      else await relay(mac, 'uci', 'delete', { config: o.config, section: o.section }, true);
    }
    await relay(mac, 'uci', 'apply', { rollback: true, timeout: APPLY_TIMEOUT_S }, true);
  } catch (e) {
    for (const config of configs) await relay(mac, 'uci', 'revert', { config }, true).catch(() => {});
    throw e;
  }
  // Radios restart after apply; keep trying to confirm well inside the window.
  for (let i = 0; i < 8; i++) {
    await pause(i ? 2_500 : 2_000);
    try {
      await relay(mac, 'uci', 'confirm', {}, true);
      return;
    } catch (e) {
      // 5: nothing pending any more, i.e. the device already rolled back.
      if (e instanceof UbusError && e.status === 5) throw new DeviceError('The access point could not keep the change and reverted it.');
    }
  }
  throw new DeviceError('Could not confirm the change; the access point reverts it within 30 seconds.');
}
