import type { UciConfig } from '../api/types';

// netui.config get, as the router plugin answers it (openwrt/files/usr/share/
// rpcd/ucode/netui-config): a config with credentials replaced. Used by the
// demo and the test router for read-only sessions.

const HIDDEN = '********';

export const CONFIG_PACKAGES = [
  'network', 'wireless', 'dhcp', 'firewall', 'system', 'sqm', 'upnpd', 'ddns', 'wifi_schedule',
  'usteer', 'nlbwmon', 'mwan3', 'adblock-fast', 'opennds', 'https-dns-proxy',
];

export function isSecretOption(name: string): boolean {
  if (name === 'public_key') return false;
  return /password|passwd|passphrase|secret|token|(^|_)psk$|_key$|^key[0-9]?$|^r[01]kh$|^pin(code)?$|faskey/i.test(name);
}

export function maskConfig(cfg: UciConfig): UciConfig {
  const out: UciConfig = {};
  for (const [name, s] of Object.entries(cfg)) {
    out[name] = Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k, !k.startsWith('.') && isSecretOption(k) ? (Array.isArray(v) ? [HIDDEN] : HIDDEN) : v]),
    ) as typeof s;
  }
  return out;
}
