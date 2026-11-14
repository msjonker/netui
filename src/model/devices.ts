// View models for the Devices page: the gateway plus adopted access points.

import type { ManagedDevice, PendingDevice } from '../api/types';

/** "OpenWrt 25.12.6 r33311-981c978eff" -> "25.12.6"; snapshots keep their revision. */
export function firmwareVersion(release: string | undefined): string | undefined {
  if (!release) return undefined;
  const m = /OpenWrt\s+(\S+)(?:\s+(r\S+))?/.exec(release);
  if (!m) return release;
  return m[1] === 'SNAPSHOT' && m[2] ? `SNAPSHOT ${m[2]}` : m[1];
}

/** Online devices first, then by name. */
export function sortDevices(devices: ManagedDevice[]): ManagedDevice[] {
  return [...devices].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** A name to offer when adopting: the hostname unless it is OpenWrt's default. */
export function suggestedName(p: PendingDevice): string {
  if (p.hostname && p.hostname !== 'OpenWrt') return p.hostname;
  return p.model ? `${p.model} AP` : 'Access point';
}

/** Matches the gateway plugin's rule for the hostname it gives the device. */
export function hostnameFor(name: string): string {
  const h = name.trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return (h || 'netui-ap').slice(0, 63);
}
