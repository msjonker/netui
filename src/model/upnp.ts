import type { UciConfig } from '../api/types';
import { bool, diffSection, sectionsOfType, type UciOp } from '../api/uci';

// miniupnpd's `config upnpd 'config'` section.

export interface Upnp {
  section: string;
  enabled: boolean;
  /** UPnP IGD itself. */
  upnp: boolean;
  natpmp: boolean;
  /** Clients may only map ports to their own address. */
  secure: boolean;
}

export type UpnpDraft = Omit<Upnp, 'section'>;

export function normalizeUpnp(cfg: UciConfig): Upnp | undefined {
  const s = sectionsOfType(cfg, 'upnpd')[0];
  return (
    s && {
      section: s['.name'],
      enabled: bool(s.enabled, false),
      upnp: bool(s.enable_upnp, true),
      natpmp: bool(s.enable_natpmp, true),
      secure: bool(s.secure_mode, true),
    }
  );
}

const flag = (v: boolean) => (v ? '1' : '0');

const OPTION = { enabled: 'enabled', upnp: 'enable_upnp', natpmp: 'enable_natpmp', secure: 'secure_mode' } as const;

/** Only flags the user changed are written; untouched defaults stay implicit. */
export function upnpOps(d: UpnpDraft, u: Upnp, cfg: UciConfig): UciOp[] {
  const values: Record<string, string> = {};
  for (const k of Object.keys(OPTION) as (keyof UpnpDraft)[]) if (d[k] !== u[k]) values[OPTION[k]] = flag(d[k]);
  return diffSection('upnpd', u.section, cfg[u.section], values);
}
