// A guest captive portal with openNDS: devices on one network see a sign-in
// page ("click to continue", or name and email) before they get internet.
// openNDS serves one interface. It needs the network's device (br-guest,
// br-lan.20): given the interface section name, 10.3.1 finds no address
// ("guest is not up") and exits, over and over.

import type { UciConfig } from '../api/types';
import { bool, diffSection, sectionsOfType, str, type UciOp } from '../api/uci';
import type { Network } from './network';

export type PortalLogin = 'click' | 'email';
const LOGIN_OPTION: Record<PortalLogin, string> = { click: '1', email: '2' };

/** Session lengths offered, in minutes; 0 is no limit. openNDS defaults to a day. */
export const SESSION_CHOICES = [60, 240, 480, 1440, 10080, 0];

export interface Portal {
  section?: string;
  enabled: boolean;
  /** Network id (interface section); undefined when unset or not a local network. */
  network?: string;
  name: string;
  login: PortalLogin | 'other';
  sessionMinutes: number;
  /** Per guest, Mbit/s; 0 is no limit. */
  downMbps: number;
  upMbps: number;
}

export function readPortal(cfg: UciConfig, networks: Network[]): Portal {
  const s = sectionsOfType(cfg, 'opennds')[0];
  // openNDS takes an interface section or a device; show either as its network.
  // Unset means br-lan (the LAN), which is never what a guest portal is for.
  const iface = str(s?.gatewayinterface);
  const network = iface ? networks.find((n) => n.id === iface || n.device === iface)?.id : undefined;
  const login = str(s?.login_option_enabled) ?? '1';
  return {
    section: s?.['.name'],
    enabled: !!s && bool(s.enabled, true),
    network,
    name: (str(s?.gatewayname) ?? 'Guest WiFi').replace(/&#39;/g, "'"),
    login: login === '1' ? 'click' : login === '2' ? 'email' : 'other',
    sessionMinutes: Number(str(s?.sessiontimeout) ?? 1440),
    downMbps: Number(str(s?.downloadrate) ?? 0) / 1000,
    upMbps: Number(str(s?.uploadrate) ?? 0) / 1000,
  };
}

export interface PortalDraft {
  enabled: boolean;
  network: string;
  name: string;
  login: PortalLogin;
  sessionMinutes: number;
  downMbps: string;
  upMbps: string;
}

export function portalDraft(p: Portal, networks: Network[]): PortalDraft {
  return {
    enabled: p.enabled,
    network: p.network ?? networks.find((n) => n.id !== 'lan')?.id ?? '',
    name: p.name,
    login: p.login === 'email' ? 'email' : 'click',
    sessionMinutes: SESSION_CHOICES.includes(p.sessionMinutes) ? p.sessionMinutes : 1440,
    downMbps: p.downMbps ? String(p.downMbps) : '',
    upMbps: p.upMbps ? String(p.upMbps) : '',
  };
}

const rate = (v: string) => (v.trim() === '' ? 0 : Number(v));

export function validatePortal(d: PortalDraft): Partial<Record<keyof PortalDraft, string>> {
  const e: Partial<Record<keyof PortalDraft, string>> = {};
  if (!d.enabled) return e;
  if (!d.network) e.network = 'Choose the network guests use.';
  if (!d.name.trim()) e.name = 'Give the portal a name guests will see.';
  else if (d.name.length > 64) e.name = 'Keep it under 64 characters.';
  for (const k of ['downMbps', 'upMbps'] as const) {
    const v = rate(d[k]);
    if (!Number.isFinite(v) || v < 0 || v > 10000) e[k] = 'Mbit/s from 0 (no limit) to 10000.';
  }
  return e;
}

export function portalOps(d: PortalDraft, cfg: UciConfig, networks: Network[]): UciOp[] {
  const net = networks.find((n) => n.id === d.network);
  const values = {
    enabled: d.enabled ? '1' : '0',
    ...(d.enabled
      ? {
          gatewayinterface: net?.device ?? d.network,
          // openNDS cannot take a quote character in the name.
          gatewayname: d.name.trim().replace(/'/g, '&#39;'),
          login_option_enabled: LOGIN_OPTION[d.login],
          sessiontimeout: String(d.sessionMinutes),
          downloadrate: String(Math.round(rate(d.downMbps) * 1000)),
          uploadrate: String(Math.round(rate(d.upMbps) * 1000)),
          // Not "Guest WiFi Node:f2524608dca7".
          enable_serial_number_suffix: '0',
        }
      : {}),
  };
  const s = sectionsOfType(cfg, 'opennds')[0];
  return s ? diffSection('opennds', s['.name'], s, values) : [{ op: 'add', config: 'opennds', type: 'opennds', values }];
}

export function sessionLabel(minutes: number): string {
  if (minutes === 0) return 'No limit';
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;
}
