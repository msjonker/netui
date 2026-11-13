const MAC_RE = /^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i;

export function isMac(value: string): boolean {
  return MAC_RE.test(value.trim());
}

/**
 * Canonical form used as the merge key across leases, host hints and assoc
 * lists: lowercase, colon separated. Returns null for anything that is not a
 * 48-bit MAC so bad input cannot collide on a shared key.
 */
export function normalizeMac(value: string): string | null {
  const v = value.trim();
  if (!isMac(v)) return null;
  const hex = v.replace(/[:-]/g, '').toLowerCase();
  return hex.match(/../g)!.join(':');
}

/** Locally administered bit: set on randomized (private) WiFi addresses. */
export function isLocallyAdministered(mac: string): boolean {
  const n = normalizeMac(mac);
  if (!n) return false;
  return (parseInt(n.slice(0, 2), 16) & 0x02) !== 0;
}
