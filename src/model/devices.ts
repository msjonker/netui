// View models for the Devices page: the gateway plus adopted access points.

import type { ManagedDevice, PendingDevice, UciConfig } from '../api/types';
import type { DeviceRadio } from '../api/queries';
import { sectionsOfType, str } from '../api/uci';
import type { Band, Radio } from './wifi';

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

// ---------------------------------------------------------------------------
// An access point's radios, for per-device radio settings.

/** What a radio carries: client WiFi, the mesh backhaul, both, or nothing. */
export type RadioRole = 'wifi' | 'mesh' | 'both' | 'off';

export interface ApRadio extends Radio {
  role: RadioRole;
  /** Live channel and clients of the interfaces on this radio. */
  liveChannel?: number;
  clients: number;
}

const BAND_LABEL: Record<string, string> = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };
const bandOfMhz = (mhz: number | undefined): Band | undefined =>
  !mhz ? undefined : mhz < 3000 ? '2g' : mhz < 5925 ? '5g' : '6g';

/**
 * The access point's radios from its own wireless config, each with its role
 * and the live state of the interfaces on it (matched by band and role: sync
 * puts client WiFi on one radio per band and the mesh on the backhaul radio).
 */
export function apRadios(wireless: UciConfig, live: DeviceRadio[] | undefined): ApRadio[] {
  const ifaces = sectionsOfType(wireless, 'wifi-iface').filter((s) => str(s.disabled) !== '1');
  return sectionsOfType(wireless, 'wifi-device').map((s) => {
    const section = s['.name'];
    const band = str(s.band) as Band | undefined;
    const on = ifaces.filter((i) => str(i.device) === section);
    const wifi = on.some((i) => str(i.mode) === 'ap');
    const mesh = on.some((i) => str(i.mode) === 'mesh');
    const role: RadioRole = str(s.disabled) === '1' || (!wifi && !mesh) ? 'off' : wifi && mesh ? 'both' : wifi ? 'wifi' : 'mesh';
    const mine = (live ?? []).filter((r) => bandOfMhz(r.info.frequency) === band && (r.mesh ? mesh : wifi));
    const txpower = str(s.txpower);
    return {
      section,
      band,
      bandLabel: (band && BAND_LABEL[band]) ?? section,
      enabled: str(s.disabled) !== '1',
      channel: str(s.channel) ?? 'auto',
      htmode: str(s.htmode),
      txpower: txpower ? Number(txpower) : undefined,
      country: str(s.country),
      role,
      liveChannel: mine[0]?.info.channel,
      clients: mine.reduce((n, r) => n + r.clients, 0),
    };
  });
}

export const ROLE_LABEL: Record<RadioRole, string> = {
  wifi: 'WiFi',
  mesh: 'Mesh backhaul',
  both: 'WiFi + mesh',
  off: 'Off',
};
