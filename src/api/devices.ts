// netui.devices, the gateway plugin that adopts access points and relays
// calls to them. Its methods report failures as { error } data, which these
// wrappers turn into thrown errors like any other ubus failure.

import { call, read, UbusError } from './ubus';
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
