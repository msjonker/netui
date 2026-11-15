// First-run setup. A fresh install (recorded on the DL-WRX36 with `wifi config`
// on 25.12.6: test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.fresh.json)
// has every WiFi network named "OpenWrt", open and disabled, radios without a
// country, and root without a password. The wizard turns WiFi on with a name
// and password on every radio, sets the country, the timezone and the WAN,
// in one apply; root's password follows the confirmed apply (netui.users).

import type { UciConfig, UciValue } from '../api/types';
import { bool, sectionsOfType, str, type UciOp } from '../api/uci';
import type { Timezone } from './system';

/** WiFi as a fresh install leaves it: networks named OpenWrt, open, disabled. */
export function isFreshWifi(wireless: UciConfig): boolean {
  const ifaces = sectionsOfType(wireless, 'wifi-iface');
  return (
    ifaces.length > 0 &&
    ifaces.every((s) => {
      const radio = wireless[str(s.device) ?? ''];
      return (
        str(s.ssid) === 'OpenWrt' &&
        (str(s.encryption) ?? 'none') === 'none' &&
        (bool(s.disabled, false) || bool(radio?.disabled, false))
      );
    })
  );
}

export interface SetupWifi {
  ssid: string;
  password: string;
  /** ISO 3166 code, e.g. "US". */
  country: string;
}

export function validateSetupWifi(d: SetupWifi): Partial<Record<keyof SetupWifi, string>> {
  const e: Partial<Record<keyof SetupWifi, string>> = {};
  const len = new TextEncoder().encode(d.ssid).length;
  if (!d.ssid.trim()) e.ssid = 'Give your WiFi a name.';
  else if (len > 32) e.ssid = 'At most 32 bytes.';
  if (d.password.length < 8 || d.password.length > 63) e.password = 'Use 8 to 63 characters.';
  if (!/^[A-Z]{2}$/.test(d.country)) e.country = 'Choose your country.';
  return e;
}

/**
 * Every radio on with the country, every access point network named and
 * protected (WPA2/WPA3, so older devices still connect).
 */
export function setupWifiOps(d: SetupWifi, wireless: UciConfig): UciOp[] {
  const ops: UciOp[] = [];
  for (const r of sectionsOfType(wireless, 'wifi-device')) {
    ops.push({ op: 'set', config: 'wireless', section: r['.name'], values: { country: d.country } });
    if (r.disabled !== undefined)
      ops.push({ op: 'unset', config: 'wireless', section: r['.name'], options: ['disabled'] });
  }
  for (const s of sectionsOfType(wireless, 'wifi-iface')) {
    if ((str(s.mode) ?? 'ap') !== 'ap') continue;
    const values: Record<string, UciValue> = { ssid: d.ssid.trim(), encryption: 'sae-mixed', key: d.password };
    ops.push({ op: 'set', config: 'wireless', section: s['.name'], values });
    if (s.disabled !== undefined)
      ops.push({ op: 'unset', config: 'wireless', section: s['.name'], options: ['disabled'] });
  }
  return ops;
}

/** The browser's country, for the WiFi regulatory domain: "en-US" -> "US". */
export function browserCountry(languages: readonly string[]): string {
  for (const l of languages) {
    const m = /-([A-Z]{2})\b/i.exec(l);
    if (m) return m[1]!.toUpperCase();
  }
  return '';
}

/** The browser's timezone in LuCI's spelling ("America/New_York" -> "America/New York"), if the router knows it. */
export function browserZone(zones: Timezone[], ianaZone: string | undefined): string | undefined {
  const name = ianaZone?.replace(/_/g, ' ');
  return zones.find((z) => z.name === name)?.name;
}

export function validateRootPassword(pw: string, again: string): string | undefined {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw !== again) return 'The passwords do not match.';
  return undefined;
}
