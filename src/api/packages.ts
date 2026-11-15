// netui.packages: install the optional packages behind netui's features, on
// the gateway or (through the gateway's relay) an adopted access point. The
// router runs each install as a background job; poll the status.

import { useQuery } from '@tanstack/react-query';
import { call, read } from './ubus';
import { DeviceError, relay } from './devices';
import type { AddonKey, PackagesStatus } from './types';

/** A feature's package is not installed; the UI offers to install `addon`. */
export class AddonMissingError extends Error {
  readonly addon: AddonKey;

  constructor(addon: AddonKey, message: string) {
    super(message);
    this.name = 'AddonMissingError';
    this.addon = addon;
  }
}

export const packagesKey = (mac = '') => ['netui.packages', 'status', mac] as const;

export async function packagesStatus(mac?: string): Promise<PackagesStatus> {
  return mac ? relay<PackagesStatus>(mac, 'netui.packages', 'status') : read<PackagesStatus>('netui.packages', 'status');
}

/** Start installing or removing an add-on; follow it with usePackages. */
export async function addonJob(action: 'install' | 'remove', addon: AddonKey, mac?: string): Promise<void> {
  const r = mac
    ? await relay<{ error?: string }>(mac, 'netui.packages', action, { addon }, true)
    : await call<{ error?: string }>('netui.packages', action, { addon });
  if (r?.error) throw new DeviceError(r.error);
}

/** Polls quickly while a job runs. No data (and an error) on routers without the plugin. */
export const usePackages = (mac?: string, enabled = true) =>
  useQuery({
    queryKey: packagesKey(mac),
    enabled,
    retry: false,
    // Until a job has an exit code: it may not have recorded its pid yet.
    refetchInterval: (q) => {
      const j = q.state.data?.job;
      return j && (j.running || j.exit === null) ? 2_000 : false;
    },
    queryFn: () => packagesStatus(mac),
  });
