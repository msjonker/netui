import type { UciConfig, UciSection, UciValue } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';

// More passwords for one WiFi, each of which can put the devices using it on
// another network (an IoT network, say). OpenWrt keeps them as wifi-station
// sections (password, device MAC, vid) tied to a wifi-iface by `iface`, and
// wifi-vlan sections mapping a vid to a network for that wifi-iface; hostapd
// gets them as its wpa_psk_file and vlan_file.
//
// netui writes one section per band and password, each with a single
// `iface`: 24.10's netifd reads an `iface` list as no iface at all, which
// applies the section to every WiFi. `mac` is always written, since 25.12
// skips a station without one; 00:00:00:00:00:00 means any device.
//
// WPA2 only. A WPA3 handshake can check one password, and 25.12 also writes
// the stations into the SAE password file as catch-alls that take the main
// password's place.
//
// Another network needs AP/VLAN support in the WiFi driver (ath11k has none;
// hostapd then starts nothing on that radio): see netui.wifi caps.

export interface WifiPassword {
  /** What it is for, e.g. "Kids" or "Smart plugs". */
  label: string;
  key: string;
  /** Network for devices that join with it; '' for the WiFi's own. `vlan:<vid>` when no wifi-vlan names one. */
  network: string;
  /** `mac` as stored: one device it is limited to (LuCI can set that), or undefined for any. */
  mac?: UciValue;
}

export const ANY_DEVICE = '00:00:00:00:00:00';

/** The vid label of a network no wifi-vlan names: hostapd turns its devices away. */
export const isUnknownNetwork = (network: string) => network.startsWith('vlan:');

/** Devices a password is limited to; empty for any device. */
export function passwordDevices(p: WifiPassword): string[] {
  return list(p.mac).filter((m) => m !== ANY_DEVICE);
}

/** Security modes extra passwords work with. */
export const passwordsAllowed = (security: string) => security === 'psk2' || security === 'psk-mixed';

/** wifi-station/wifi-vlan sections and the wifi-iface each belongs to (the first of its `iface` list in `ifaces`). */
function owned(wireless: UciConfig, type: 'wifi-station' | 'wifi-vlan', ifaces: string[]): [UciSection, string][] {
  const out: [UciSection, string][] = [];
  for (const s of sectionsOfType(wireless, type)) {
    const owner = list(s.iface).find((i) => ifaces.includes(i));
    if (owner) out.push([s, owner]);
  }
  return out;
}

/** The extra passwords of one wifi-iface section. */
export function readPasswords(wireless: UciConfig, iface: string): WifiPassword[] {
  const vlans = sectionsOfType(wireless, 'wifi-vlan').filter((v) => {
    const i = list(v.iface);
    return i.length === 0 || i.includes(iface);
  });
  return sectionsOfType(wireless, 'wifi-station')
    .filter((s) => list(s.iface).includes(iface) && str(s.key))
    .map((s) => {
      const vid = str(s.vid);
      const vlan = vid ? vlans.find((v) => str(v.vid) === vid) : undefined;
      const network = !vid ? '' : (list(vlan?.network)[0] ?? `vlan:${vid}`);
      const mac = Array.isArray(s.mac) ? list(s.mac) : str(s.mac);
      return { label: str(s.label) ?? '', key: str(s.key)!, network, ...(mac !== undefined ? { mac } : {}) };
    });
}

/** Station and VLAN sections tied to these wifi-iface sections only: removed with them. */
export function passwordSections(wireless: UciConfig, ifaces: string[]): string[] {
  return [...sectionsOfType(wireless, 'wifi-station'), ...sectionsOfType(wireless, 'wifi-vlan')]
    .filter((s) => {
      const i = list(s.iface);
      return i.length > 0 && i.every((x) => ifaces.includes(x));
    })
    .map((s) => s['.name']);
}

/** Whether any wifi-station belongs to these sections: then netui manages their VLAN sections too. */
export function hasPasswords(wireless: UciConfig, ifaces: string[]): boolean {
  return owned(wireless, 'wifi-station', ifaces).length > 0;
}

/**
 * Ops that make the wifi-iface sections `ifaces` (existing or about to be
 * added under these names) carry `passwords`, and remove the password
 * sections of `dropped` (bands the WiFi leaves). `own` is the WiFi's network;
 * `netVids` the 802.1Q ID of networks on a VLAN, reused as hostapd's vid so
 * the two read the same (any number works).
 */
export function passwordOps(
  wireless: UciConfig,
  ifaces: string[],
  dropped: string[],
  passwords: WifiPassword[],
  own: string,
  netVids: Record<string, number> = {},
): UciOp[] {
  const ops: UciOp[] = [];
  const all = [...ifaces, ...dropped];
  const stations = owned(wireless, 'wifi-station', all);
  const vlans = owned(wireless, 'wifi-vlan', all);
  for (const [s, owner] of [...stations, ...vlans]) {
    if (dropped.includes(owner)) ops.push({ op: 'delete', config: 'wireless', section: s['.name'] });
  }

  // One vid per network, the same on every band: the one in use, else the
  // network's VLAN ID, else from 100 up. Unknown ones keep theirs.
  const target = (p: WifiPassword) => (p.network === own ? '' : p.network);
  const nets = [...new Set(passwords.map(target).filter((n) => n && !isUnknownNetwork(n)))];
  const used = new Set(passwords.map((p) => p.network).filter(isUnknownNetwork).map((n) => n.slice(5)));
  const vid = new Map<string, string>();
  for (const n of nets) {
    const v = str(vlans.find(([s]) => list(s.network)[0] === n && str(s.vid) && !used.has(str(s.vid)!))?.[0].vid);
    if (v) {
      vid.set(n, v);
      used.add(v);
    }
  }
  for (const n of nets) {
    if (vid.has(n)) continue;
    let id = netVids[n] && !used.has(String(netVids[n])) ? netVids[n]! : 100;
    while (used.has(String(id))) id++;
    vid.set(n, String(id));
    used.add(String(id));
  }
  const vidOf = (p: WifiPassword) => {
    const n = target(p);
    return !n ? '' : isUnknownNetwork(n) ? n.slice(5) : vid.get(n)!;
  };

  for (const iface of ifaces) {
    const wantVlans = nets.map((n) => ({ iface, name: `v${vid.get(n)}`, network: n, vid: vid.get(n)! }));
    match(
      vlans.filter(([, o]) => o === iface).map(([s]) => s),
      wantVlans,
      (s, w) => list(s.network)[0] === w.network,
      'wifi-vlan',
      ops,
    );
    const wantStations = passwords.map((p) => ({ iface, key: p.key, mac: p.mac ?? ANY_DEVICE, vid: vidOf(p), label: p.label }));
    match(
      stations.filter(([, o]) => o === iface).map(([s]) => s),
      wantStations,
      (s, w) => str(s.key) === w.key,
      'wifi-station',
      ops,
    );
  }
  return ops;
}

/**
 * Pair existing sections with wanted ones (by `same`, then in order), edit the
 * pairs, delete what is left over and add what is missing.
 */
function match<W extends Record<string, UciValue>>(
  have: UciSection[],
  want: W[],
  same: (s: UciSection, w: W) => boolean,
  type: string,
  ops: UciOp[],
): void {
  const free = [...have];
  const pairs: [UciSection | undefined, W][] = want.map((w) => {
    const i = free.findIndex((s) => same(s, w));
    return [i >= 0 ? free.splice(i, 1)[0] : undefined, w];
  });
  for (const pair of pairs) if (!pair[0]) pair[0] = free.shift();
  for (const [s, w] of pairs) {
    if (s) ops.push(...diffSection('wireless', s['.name'], s, w));
    else ops.push({ op: 'add', config: 'wireless', type, values: Object.fromEntries(Object.entries(w).filter(([, v]) => v !== '')) });
  }
  for (const s of free) ops.push({ op: 'delete', config: 'wireless', section: s['.name'] });
}

/** Problems with the passwords, or null. `vlanOk`: every band's radio can put devices on another network. */
export function validatePasswords(
  passwords: WifiPassword[],
  ctx: { security: string; key: string; network: string; vlanOk: boolean },
): string | null {
  if (!passwords.length) return null;
  if (!passwordsAllowed(ctx.security)) return 'More passwords need WPA2 security: WPA3 checks one password per WiFi.';
  const seen = new Set([ctx.key]);
  for (const p of passwords) {
    const name = p.label.trim() || 'Each password';
    if (!p.label.trim()) return 'Give each password a name.';
    if (p.key.length < 8 || p.key.length > 63) return `${name}: the password must be 8 to 63 characters.`;
    if (seen.has(p.key)) return `${name}: every password must be different (from the main one too).`;
    seen.add(p.key);
    if (!ctx.vlanOk && p.network && p.network !== ctx.network && !isUnknownNetwork(p.network)) {
      return `${name}: this WiFi hardware cannot put devices on another network by password.`;
    }
  }
  return null;
}

/** 802.1Q ID of each network on a VLAN device ("br-lan.10" -> 10). */
export function networkVids(networks: { id: string; device?: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of networks) {
    const m = /\.(\d{1,4})$/.exec(n.device ?? '');
    if (m && +m[1]! >= 1 && +m[1]! <= 4094) out[n.id] = +m[1]!;
  }
  return out;
}
