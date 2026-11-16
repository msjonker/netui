// Client steering with usteer, in plain terms: band steering, a roaming
// assistant and a minimum signal. usteer reads negative "snr" values as a
// signal level in dBm. The settings live in the gateway's usteer config and
// the gateway's sync copies them to every adopted access point.

import type { UciConfig } from '../api/types';
import { sectionsOfType, str, type UciOp } from '../api/uci';

export interface Steering {
  /** Nudge dual-band clients to 5 GHz. */
  bandSteering: boolean;
  /** Ask weak clients to roam to a better access point. */
  roaming: boolean;
  /** dBm below which a client is disconnected so it rejoins somewhere better; 0 = off. */
  minSignal: number;
}

/** The usteer options netui manages; sync copies exactly these. */
export const STEERING_OPTIONS = ['band_steering_threshold', 'roam_scan_snr', 'roam_trigger_snr', 'min_snr'] as const;

/** Below this a client is asked to scan for a better access point, below the trigger it is steered. */
export const ROAM_SCAN_DBM = -70;
export const ROAM_TRIGGER_DBM = -75;
/** usteer's own default band steering threshold. */
const BAND_STEERING_DEFAULT = '5';

export const MIN_SIGNAL_CHOICES = [0, -80, -75, -70] as const;

const num = (v: unknown, fallback: number) => {
  const n = Number(str(v));
  return str(v) === undefined || Number.isNaN(n) ? fallback : n;
};

export function readSteering(usteer: UciConfig): Steering | undefined {
  const s = sectionsOfType(usteer, 'usteer')[0];
  if (!s) return undefined;
  return {
    bandSteering: num(s.band_steering_threshold, Number(BAND_STEERING_DEFAULT)) > 0,
    roaming: num(s.roam_scan_snr, 0) !== 0 && num(s.roam_trigger_snr, 0) !== 0,
    minSignal: num(s.min_snr, 0),
  };
}

const isLan = (net: unknown) => (Array.isArray(net) ? net.includes('lan') : String(net ?? '').split(' ').includes('lan'));

/**
 * Ops for the gateway's usteer config, plus, when the roaming assistant is
 * on, BSS transition and 802.11k on the LAN WiFi networks: steering is then a
 * polite request the client can follow instead of a disconnect. `wnm` false:
 * hostapd's basic build, which cannot start a network with BSS transition on.
 */
export function steeringOps(next: Steering, usteer: UciConfig, wireless: UciConfig | undefined, wnm = true): UciOp[] {
  const s = sectionsOfType(usteer, 'usteer')[0];
  if (!s) return [];
  const values = {
    band_steering_threshold: next.bandSteering ? BAND_STEERING_DEFAULT : '0',
    roam_scan_snr: next.roaming ? String(ROAM_SCAN_DBM) : '0',
    roam_trigger_snr: next.roaming ? String(ROAM_TRIGGER_DBM) : '0',
    min_snr: String(next.minSignal),
  };
  const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => str(s[k]) !== v));
  const ops: UciOp[] = Object.keys(changed).length ? [{ op: 'set', config: 'usteer', section: s['.name'], values: changed }] : [];
  if (next.roaming && wireless && wnm) {
    for (const w of sectionsOfType(wireless, 'wifi-iface')) {
      if (str(w.mode) !== 'ap' || str(w.disabled) === '1' || !isLan(w.network)) continue;
      if (str(w.bss_transition) !== '1' || str(w.ieee80211k) !== '1')
        ops.push({ op: 'set', config: 'wireless', section: w['.name'], values: { bss_transition: '1', ieee80211k: '1' } });
    }
  }
  return ops;
}
