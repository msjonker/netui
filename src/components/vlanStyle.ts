import type { Switch, Vlan } from '../model/ports';
import { networkLabel } from '../model/network';

// One color per VLAN, in VID order, so a network looks the same on the port
// panel, the port table and the networks table.
const PALETTE = ['#006fff', '#0ea5a4', '#f59e0b', '#a855f7', '#ef4444', '#22c55e', '#ec4899', '#64748b'];

export function vlanColor(sw: Switch, vid: number): string {
  const i = sw.vlans.findIndex((v) => v.vid === vid);
  return PALETTE[(i < 0 ? sw.vlans.length : i) % PALETTE.length]!;
}

/** "IoT", or "VLAN 30" for a VLAN no interface uses. */
export function vlanName(v: Vlan | undefined, vid?: number): string {
  if (!v) return `VLAN ${vid}`;
  return v.networks[0] ? networkLabel(v.networks[0]) : `VLAN ${v.vid}`;
}

export function vlanLabel(sw: Switch, vid: number): string {
  const v = sw.vlans.find((x) => x.vid === vid);
  const name = vlanName(v, vid);
  return sw.vlanFiltering && v?.networks.length ? `${name} (${vid})` : name;
}
