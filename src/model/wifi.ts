import type { AssocStation, IwinfoInfo, UciConfig, UciSection, UciValue } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { zones } from './firewall';

// netui presents one "WiFi network" per SSID across bands. OpenWrt has one
// wifi-iface section per radio, so ap-mode sections with the same SSID are
// grouped into a Wlan and edited together.

export type Band = '2g' | '5g' | '6g' | '60g';

export const BAND_LABEL: Record<Band, string> = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

/** Live state per iwinfo device, as returned by useWifiState(). */
export interface LiveDevice {
  ifname: string;
  info?: IwinfoInfo;
  stations?: AssocStation[];
  /** false: hostapd is not broadcasting it, whatever iwinfo reports. */
  running?: boolean;
}

export interface Radio {
  section: string;
  band?: Band;
  bandLabel: string;
  enabled: boolean;
  /** "auto" or a channel number as a string. */
  channel: string;
  htmode?: string;
  /** dBm, undefined for driver default. */
  txpower?: number;
  country?: string;
  live?: { channel?: number; txpower?: number; frequency?: number; noise?: number };
  /** Live AP interface on this radio (for survey), if any is up. */
  ifname?: string;
}

export interface WlanMember {
  section: string;
  radio: string;
  band?: Band;
  bandLabel: string;
  enabled: boolean;
  /** iwinfo device currently serving this section, if up. */
  ifname?: string;
}

export type Security = 'none' | 'owe' | 'psk2' | 'psk-mixed' | 'sae' | 'sae-mixed' | 'other';

/** 802.11w management frame protection (ieee80211w 0/1/2). */
export type Pmf = 'off' | 'optional' | 'required';

/** Per-SSID options shown under Advanced, read from one wifi-iface. */
export interface IfaceSettings {
  hidden: boolean;
  /** Client device isolation. */
  isolate: boolean;
  /** As stored; see effectivePmf() for what hostapd actually uses. */
  pmf: Pmf;
  /** 802.11r. */
  fastRoaming: boolean;
  /** 4 hex digits, empty for the default (derived from the SSID). */
  mobilityDomain: string;
  /** 802.11v BSS transition management (with 802.11k neighbor reports). */
  bssTransition: boolean;
  /** multicast_to_unicast_all. */
  multicastEnhance: boolean;
  /** maxassoc, empty for no limit. */
  maxClients: string;
}

export function ifaceSettings(s: UciSection): IfaceSettings {
  const w = str(s.ieee80211w);
  return {
    hidden: bool(s.hidden, false),
    isolate: bool(s.isolate, false) || bool(s.ap_isolate, false),
    pmf: w === '2' ? 'required' : w === '1' ? 'optional' : 'off',
    fastRoaming: bool(s.ieee80211r, false),
    mobilityDomain: str(s.mobility_domain) ?? '',
    bssTransition: bool(s.bss_transition, false),
    multicastEnhance: bool(s.multicast_to_unicast_all, false) || bool(s.multicast_to_unicast, false),
    maxClients: str(s.maxassoc) ?? str(s.max_num_sta) ?? '',
  };
}

/** Modes that take a passphrase. */
export function needsKey(s: Security): boolean {
  return s === 'psk2' || s === 'psk-mixed' || s === 'sae' || s === 'sae-mixed';
}

/**
 * PMF hostapd ends up using. OpenWrt's ap.uc forces "required" for WPA3 and
 * Enhanced Open and "optional" for WPA2/WPA3, whatever ieee80211w says.
 */
export function effectivePmf(security: Security, pmf: Pmf): Pmf {
  if (security === 'sae' || security === 'owe') return 'required';
  if (security === 'sae-mixed') return 'optional';
  if (security === 'none') return 'off';
  return pmf;
}

export interface Wlan extends IfaceSettings {
  /** Stable key for the group: the SSID. */
  id: string;
  ssid: string;
  enabled: boolean;
  hidden: boolean;
  /** Raw UCI encryption, e.g. "psk2+ccmp". */
  encryption: string;
  security: Security;
  key: string;
  network: string[];
  members: WlanMember[];
  /** Bands disagree on security or an Advanced option; saving makes them the same. */
  mixed: boolean;
  /** Every band's radio is off, so it cannot broadcast even when enabled. */
  radioOff: boolean;
}

/**
 * The open "OpenWrt" network a fresh install leaves on each radio. 24.10
 * leaves it enabled and turns the radio off instead (25.12 does the
 * opposite), so turning such a radio on would start it, open, on the LAN.
 */
export function isPlaceholderIface(s: UciSection): boolean {
  return (str(s.mode) ?? 'ap') === 'ap' && str(s.ssid) === 'OpenWrt' && (str(s.encryption) ?? 'none') === 'none';
}

/** Band of a wifi-device, from `band` (23.05+) or legacy `hwmode`. */
export function radioBand(s: UciSection): Band | undefined {
  const band = str(s.band);
  if (band === '2g' || band === '5g' || band === '6g' || band === '60g') return band;
  const hw = str(s.hwmode);
  if (hw === '11a') return '5g';
  if (hw === '11b' || hw === '11g') return '2g';
  return undefined;
}

/** Band from live frequency in MHz. */
export function frequencyBand(mhz: number | undefined): Band | undefined {
  if (!mhz) return undefined;
  if (mhz < 3000) return '2g';
  if (mhz < 5925) return '5g';
  if (mhz < 7200) return '6g';
  return '60g';
}

export function securityOf(encryption: string): Security {
  const base = encryption.split('+')[0] ?? '';
  if (base === 'none' || base === '') return 'none';
  if (base === 'owe' || base === 'psk2' || base === 'psk-mixed' || base === 'sae' || base === 'sae-mixed') return base;
  return 'other';
}

export const SECURITY_LABEL: Record<Security, string> = {
  none: 'Open',
  owe: 'Enhanced Open',
  psk2: 'WPA2',
  'psk-mixed': 'WPA/WPA2',
  'sae-mixed': 'WPA2/WPA3',
  sae: 'WPA3',
  other: 'Custom',
};

export interface WifiModel {
  radios: Radio[];
  wlans: Wlan[];
  /** Station lists per live device, ready for mergeClients(). */
  assoc: { ifname: string; ssid?: string; band?: string; stations: AssocStation[] }[];
}

export function normalizeWifi(wireless: UciConfig, live: LiveDevice[] = []): WifiModel {
  const masters = live.filter((d) => d.info && (d.info.mode ?? 'Master') === 'Master' && d.running !== false);
  const liveBand = (d: LiveDevice) => frequencyBand(d.info?.frequency);

  const radios: Radio[] = sectionsOfType(wireless, 'wifi-device').map((s) => {
    const band = radioBand(s);
    const dev = masters.find((d) => liveBand(d) === band);
    const tx = str(s.txpower);
    return {
      section: s['.name'],
      band,
      bandLabel: band ? BAND_LABEL[band] : s['.name'],
      enabled: !bool(s.disabled, false),
      channel: str(s.channel) ?? 'auto',
      htmode: str(s.htmode),
      txpower: tx ? Number(tx) : undefined,
      country: str(s.country),
      live: dev?.info && { channel: dev.info.channel, txpower: dev.info.txpower, frequency: dev.info.frequency, noise: dev.info.noise },
      ifname: bool(s.disabled, false) ? undefined : dev?.ifname,
    };
  });
  const radioBySection = new Map(radios.map((r) => [r.section, r]));

  // Which live interface serves a section: its explicit ifname option, else
  // the AP on the same band with the same SSID. Some builds (SNAPSHOT 2025)
  // report no ssid in iwinfo info; then netifd's "<phy>-ap<N>" naming, N
  // counting the radio's enabled AP sections in order, identifies it.
  const apIndex = new Map<string, number>();
  const groups = new Map<string, Wlan>();
  const ssidOf = new Map<string, string>();
  for (const s of sectionsOfType(wireless, 'wifi-iface')) {
    if ((str(s.mode) ?? 'ap') !== 'ap') continue;
    const ssid = str(s.ssid) ?? '';
    const device = str(s.device) ?? '';
    const radio = radioBySection.get(device);
    const enabled = !bool(s.disabled, false) && (radio?.enabled ?? true);
    const n = enabled ? (apIndex.get(device) ?? 0) : -1;
    if (enabled) apIndex.set(device, n + 1);
    const explicit = str(s.ifname);
    const dev = explicit
      ? masters.find((d) => d.ifname === explicit)
      : (masters.find((d) => d.info?.ssid === ssid && liveBand(d) === radio?.band) ??
        masters.find((d) => d.info?.ssid === undefined && liveBand(d) === radio?.band && d.ifname.endsWith(`-ap${n}`)));
    if (enabled && dev) ssidOf.set(dev.ifname, ssid);
    const member: WlanMember = {
      section: s['.name'],
      radio: str(s.device) ?? '',
      band: radio?.band,
      bandLabel: radio?.bandLabel ?? (str(s.device) ?? '?'),
      enabled: !bool(s.disabled, false),
      ifname: enabled ? dev?.ifname : undefined,
    };
    const g = groups.get(ssid);
    const encryption = str(s.encryption) ?? 'none';
    const settings = ifaceSettings(s);
    const radioOff = radio?.enabled === false;
    if (g) {
      g.members.push(member);
      g.enabled ||= member.enabled;
      g.radioOff &&= radioOff;
      const first = wireless[g.members[0]!.section]!;
      g.mixed ||=
        securityOf(encryption) !== g.security ||
        (str(s.key) ?? '') !== (str(first.key) ?? '') ||
        JSON.stringify(settings) !== JSON.stringify(ifaceSettings(first));
      continue;
    }
    groups.set(ssid, {
      ...settings,
      id: ssid,
      ssid,
      enabled: member.enabled,
      hidden: bool(s.hidden, false),
      encryption,
      security: securityOf(encryption),
      key: str(s.key) ?? '',
      network: list(s.network),
      members: [member],
      mixed: false,
      radioOff,
    });
  }

  const assoc = live
    .filter((d) => d.stations?.length)
    .map((d) => {
      const band = liveBand(d);
      return { ifname: d.ifname, ssid: d.info?.ssid ?? ssidOf.get(d.ifname), band: band && BAND_LABEL[band], stations: d.stations! };
    });

  return { radios, wlans: [...groups.values()], assoc };
}

// ---------------------------------------------------------------------------
// Writing

export interface WlanDraft extends IfaceSettings {
  ssid: string;
  enabled: boolean;
  security: Security;
  key: string;
  network: string;
  /** wifi-device sections this SSID should broadcast on. */
  radios: string[];
  /** "Guest network": isolation on and an isolated network. UI state only. */
  guest: boolean;
}

/**
 * Networks a guest SSID can use: those in a firewall zone of their own, i.e.
 * not the LAN's zone and not the WAN's.
 */
export function isolatedNetworks(networks: string[], fw: UciConfig | undefined): string[] {
  if (!fw) return [];
  const zs = zones(fw);
  const lanZone = zs.find((z) => z.networks.includes('lan'))?.name;
  return networks.filter((n) => {
    const z = zs.find((x) => x.networks.includes(n));
    return z && z.name !== lanZone && z.name !== 'wan' && n !== 'lan';
  });
}

export function wlanDraft(w: Wlan, isolated: string[] = []): WlanDraft {
  const network = w.network[0] ?? 'lan';
  return {
    ssid: w.ssid,
    enabled: w.enabled,
    hidden: w.hidden,
    security: w.security,
    key: w.key,
    network,
    radios: w.members.map((m) => m.radio),
    isolate: w.isolate,
    pmf: w.pmf,
    fastRoaming: w.fastRoaming,
    mobilityDomain: w.mobilityDomain,
    bssTransition: w.bssTransition,
    multicastEnhance: w.multicastEnhance,
    maxClients: w.maxClients,
    guest: w.isolate && isolated.includes(network),
  };
}

/**
 * A new SSID with sensible defaults (WPA2/WPA3, BSS transition on where
 * hostapd supports it) on the given radios.
 */
export function newWlanDraft(radios: string[], network: string, bssTransition = true): WlanDraft {
  return {
    ssid: '',
    enabled: true,
    hidden: false,
    security: 'sae-mixed',
    key: '',
    network,
    radios,
    isolate: false,
    pmf: 'off',
    fastRoaming: false,
    mobilityDomain: '',
    bssTransition,
    multicastEnhance: false,
    maxClients: '',
    guest: false,
  };
}

// BSS transition (802.11v) is only in hostapd's full build. The basic build
// stock images ship rejects `bss_transition` as an unknown option and starts
// no network on that radio at all (recorded on a TL-WR1043ND v2, 25.12.6).

/** Enabled access point networks with BSS transition on, which the basic WiFi package cannot start. */
export function bssTransitionSsids(wireless: UciConfig): string[] {
  const ssids = sectionsOfType(wireless, 'wifi-iface')
    .filter((s) => (str(s.mode) ?? 'ap') === 'ap' && !bool(s.disabled, false) && bool(s.bss_transition, false))
    .map((s) => str(s.ssid) ?? '');
  return [...new Set(ssids)];
}

/** Ops to turn BSS transition off on every access point network. */
export function bssTransitionOffOps(wireless: UciConfig): UciOp[] {
  return sectionsOfType(wireless, 'wifi-iface')
    .filter((s) => s.bss_transition !== undefined && (str(s.mode) ?? 'ap') === 'ap')
    .map((s): UciOp => ({ op: 'unset', config: 'wireless', section: s['.name'], options: ['bss_transition'] }));
}

/**
 * Options for one wifi-iface from a draft, written in the form `before`
 * stored them (network as option or list, cipher suffix kept). "other" keeps
 * whatever encryption was there, since we do not know how to edit it. Empty
 * strings unset.
 *
 * Advanced options are only written when the draft differs from what
 * `before` reads as, so options another tool set in an equivalent form are
 * left alone. `full` writes them all, for a new section.
 */
export function wlanValues(d: WlanDraft, before?: UciSection, full = false): Record<string, UciValue> {
  const prevNetwork = before?.network;
  const prevList = list(prevNetwork);
  const network: UciValue = Array.isArray(prevNetwork)
    ? prevList[0] === d.network
      ? prevList
      : [d.network]
    : d.network;
  const prevEnc = str(before?.encryption);
  const out: Record<string, UciValue> = {
    mode: 'ap',
    ssid: d.ssid,
    network,
    encryption:
      d.security === 'other' ? (prevEnc ?? 'none') : prevEnc && securityOf(prevEnc) === d.security ? prevEnc : d.security,
    key: d.security === 'none' || d.security === 'owe' ? '' : d.key,
    hidden: keepBool(before, 'hidden', d.hidden),
    disabled: keepBool(before, 'disabled', !d.enabled),
  };

  const prev = before && !full ? ifaceSettings(before) : undefined;
  const changed = (k: keyof IfaceSettings) => !prev || prev[k] !== d[k];
  const flag = (v: boolean) => (v ? '1' : '');

  if (changed('isolate')) {
    out.isolate = flag(d.isolate);
    if (!d.isolate) out.ap_isolate = '';
  }
  if (changed('pmf')) out.ieee80211w = { off: '', optional: '1', required: '2' }[d.pmf];
  if (changed('fastRoaming')) out.ieee80211r = flag(d.fastRoaming);
  if (d.fastRoaming) {
    // FT over the air works with every client; over-DS is the older default
    // and breaks some. PSK networks derive the PMK locally; SAE networks
    // leave it unset so OpenWrt derives R0KH/R1KH keys instead.
    if (!prev?.fastRoaming) out.ft_over_ds = '0';
    const secChanged = !prevEnc || securityOf(prevEnc) !== d.security;
    if (!prev?.fastRoaming || secChanged) {
      out.ft_psk_generate_local = d.security === 'psk2' || d.security === 'psk-mixed' ? '1' : '';
    }
  }
  if (changed('mobilityDomain')) out.mobility_domain = d.mobilityDomain;
  if (changed('bssTransition')) {
    out.bss_transition = flag(d.bssTransition);
    // 802.11k neighbor reports let clients find the band to move to.
    if (d.bssTransition && str(before?.ieee80211k) !== '1') out.ieee80211k = '1';
  }
  if (changed('multicastEnhance')) {
    out.multicast_to_unicast_all = flag(d.multicastEnhance);
    if (!d.multicastEnhance) out.multicast_to_unicast = '';
  }
  if (changed('maxClients')) out.maxassoc = d.maxClients;
  return out;
}

/** "1"/"" for a boolean option, or the stored form ("0", "true") when it already means `want`. */
function keepBool(before: UciSection | undefined, key: string, want: boolean): string {
  const raw = str(before?.[key]);
  if (raw !== undefined && bool(raw, false) === want) return raw;
  return want ? '1' : '';
}

export function validateWlan(
  d: WlanDraft,
  others: Wlan[],
  ctx: { radios?: Radio[]; isolated?: string[] } = {},
): string | null {
  if (!d.ssid) return 'Enter a network name.';
  if (new TextEncoder().encode(d.ssid).length > 32) return 'Network name must be at most 32 bytes.';
  if (others.some((w) => w.ssid === d.ssid)) return `A WiFi network named "${d.ssid}" already exists.`;
  if (d.radios.length === 0) return 'Select at least one band.';
  if (needsKey(d.security)) {
    if (d.key.length < 8 || d.key.length > 63) return 'Password must be 8 to 63 characters.';
  }
  const sixG = ctx.radios?.some((r) => r.band === '6g' && d.radios.includes(r.section));
  if (sixG && d.security !== 'sae' && d.security !== 'owe') return '6 GHz requires WPA3 or Enhanced Open.';
  if (d.maxClients && !(/^\d+$/.test(d.maxClients) && +d.maxClients >= 1 && +d.maxClients <= 2007)) {
    return 'Maximum clients is a number from 1 to 2007, or empty for no limit.';
  }
  if (d.fastRoaming && d.mobilityDomain && !/^[0-9a-fA-F]{4}$/.test(d.mobilityDomain)) {
    return 'Mobility domain is 4 hexadecimal digits, e.g. 4f57.';
  }
  if (d.guest && ctx.isolated && !ctx.isolated.includes(d.network)) {
    return ctx.isolated.length
      ? 'A guest WiFi must use an isolated network.'
      : 'Create an isolated network for guests first (Networks, with its own firewall zone).';
  }
  return null;
}

/** Channel choices per band (20 MHz primaries; the driver rejects any not allowed in the country). */
export const CHANNELS: Record<Band, string[]> = {
  '2g': ['auto', ...Array.from({ length: 13 }, (_, i) => String(i + 1))],
  '5g': ['auto', '36', '40', '44', '48', '52', '56', '60', '64', '100', '104', '108', '112', '116', '120', '124', '128', '132', '136', '140', '144', '149', '153', '157', '161', '165'],
  '6g': ['auto', ...Array.from({ length: 24 }, (_, i) => String(1 + i * 4))],
  '60g': ['auto', '1', '2', '3', '4'],
};

/** Channel widths per band. HT/VHT/HE prefixes are kept as found on the radio. */
export function widthOptions(band: Band | undefined, current?: string): { value: string; label: string }[] {
  const family = current?.replace(/\d+\+?$/, '') || (band === '2g' ? 'HT' : band === '6g' ? 'HE' : 'VHT');
  const widths = band === '2g' ? ['20', '40'] : band === '6g' ? ['20', '40', '80', '160'] : ['20', '40', '80', '160'];
  if (family === 'HT' && band !== '2g') widths.splice(2);
  return widths.map((w) => ({ value: `${family}${w}`, label: `${w} MHz` }));
}

/** Options a new band's iface must not copy from its sibling. */
const NOT_INHERITED = new Set(['device', 'ifname', 'macaddr', 'bssid']);

/**
 * Ops to make the SSID group match the draft: edit sections on bands that
 * stay, delete those on bands that were unticked, add one per new band.
 * A new band copies the other options of an existing band, so settings this
 * UI does not show carry over. Without `existing` the whole group is new.
 */
export function wlanOps(d: WlanDraft, existing: Wlan | undefined, wireless: UciConfig): UciOp[] {
  const ops: UciOp[] = [];
  const members = existing?.members ?? [];
  for (const m of members) {
    if (d.radios.includes(m.radio)) {
      ops.push(...diffSection('wireless', m.section, wireless[m.section], wlanValues(d, wireless[m.section])));
    } else {
      ops.push({ op: 'delete', config: 'wireless', section: m.section });
    }
  }
  const template = members[0] && wireless[members[0].section];
  const inherited: Record<string, UciValue> = {};
  for (const [k, v] of Object.entries(template ?? {})) {
    if (!k.startsWith('.') && !NOT_INHERITED.has(k) && (typeof v === 'string' || Array.isArray(v))) inherited[k] = v;
  }
  for (const radio of d.radios) {
    if (members.some((m) => m.radio === radio)) continue;
    const values = Object.fromEntries(
      Object.entries({ ...inherited, ...wlanValues(d, template, true) }).filter(
        ([, v]) => v !== '' && !(Array.isArray(v) && v.length === 0),
      ),
    );
    ops.push({ op: 'add', config: 'wireless', type: 'wifi-iface', values: { device: radio, ...values } });
  }
  const keep = members.map((m) => m.section);
  for (const radio of radiosToTurnOn(d, existing, wireless)) {
    ops.push({ op: 'unset', config: 'wireless', section: radio, options: ['disabled'] }, ...placeholderOffOps(wireless, radio, keep));
  }
  return ops;
}

/**
 * Radios that are off and that applying `d` turns on: those the WiFi is
 * added to or switched on for, or all of its radios when it would otherwise
 * broadcast nowhere (a fresh 24.10 install turns every radio off). A radio
 * turned off on purpose stays off when a WiFi live on another band is edited.
 */
export function radiosToTurnOn(d: WlanDraft, existing: Wlan | undefined, wireless: UciConfig): string[] {
  if (!d.enabled) return [];
  const off = d.radios.filter((r) => bool(wireless[r]?.disabled, false));
  if (off.length === d.radios.length) return off;
  return off.filter((r) => !existing?.members.some((m) => m.radio === r && m.enabled));
}

/** Placeholder networks that would start with `radio`, except sections in `keep`. */
export function placeholdersOn(wireless: UciConfig, radio: string, keep: string[] = []): string[] {
  return sectionsOfType(wireless, 'wifi-iface')
    .filter((s) => str(s.device) === radio && isPlaceholderIface(s) && !bool(s.disabled, false) && !keep.includes(s['.name']))
    .map((s) => s['.name']);
}

function placeholderOffOps(wireless: UciConfig, radio: string, keep: string[] = []): UciOp[] {
  return placeholdersOn(wireless, radio, keep).map((section): UciOp => ({ op: 'set', config: 'wireless', section, values: { disabled: '1' } }));
}

export function deleteWlanOps(w: Wlan): UciOp[] {
  return w.members.map((m) => ({ op: 'delete', config: 'wireless', section: m.section }));
}

export interface RadioDraft {
  enabled: boolean;
  channel: string;
  htmode: string;
  /** dBm as typed; empty for driver default. */
  txpower: string;
  country: string;
}

export function radioDraft(r: Radio): RadioDraft {
  return {
    enabled: r.enabled,
    channel: r.channel,
    htmode: r.htmode ?? '',
    txpower: r.txpower !== undefined ? String(r.txpower) : '',
    country: r.country ?? '',
  };
}

export function validateRadio(d: RadioDraft): string | null {
  if (d.txpower && !/^\d{1,2}$/.test(d.txpower)) return 'Transmit power is whole dBm, e.g. 20.';
  if (d.country && !/^([A-Z]{2}|00)$/.test(d.country)) return 'Country is a two-letter code, e.g. US or DE.';
  return null;
}

/** Ops for one radio. A new country is written to every radio: they share one regulatory domain. */
export function radioOps(d: RadioDraft, r: Radio, wireless: UciConfig): UciOp[] {
  const ops = diffSection('wireless', r.section, wireless[r.section], {
    disabled: keepBool(wireless[r.section], 'disabled', !d.enabled),
    channel: d.channel,
    htmode: d.htmode,
    txpower: d.txpower,
    country: d.country,
  });
  if (d.enabled && !r.enabled) ops.push(...placeholderOffOps(wireless, r.section));
  if (d.country && d.country !== (r.country ?? '')) {
    for (const s of sectionsOfType(wireless, 'wifi-device')) {
      if (s['.name'] !== r.section) ops.push(...diffSection('wireless', s['.name'], s, { country: d.country }));
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Share WiFi

/** Escape for the WIFI: QR format: backslash, semicolon, comma, colon and double quote. */
function qrEscape(s: string): string {
  return s.replace(/[\\;,:"]/g, (c) => `\\${c}`);
}

/** The ZXing WIFI: payload phones understand. Open and Enhanced Open use T:nopass. */
export function wifiQrPayload(w: Pick<Wlan, 'ssid' | 'security' | 'key' | 'hidden'>): string {
  const open = !needsKey(w.security) && w.security !== 'other';
  let p = `WIFI:T:${open ? 'nopass' : 'WPA'};S:${qrEscape(w.ssid)};`;
  if (!open) p += `P:${qrEscape(w.key)};`;
  if (w.hidden) p += 'H:true;';
  return `${p};`;
}
