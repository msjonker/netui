/** A device a rule can point at. */
export interface Host {
  ip: string;
  name: string;
  fixed: boolean;
}

export const PLAN = { returnTo: '/settings/security' };

export const LUCI_FIREWALL = '/cgi-bin/luci/admin/network/firewall';
export const LUCI_RULES = '/cgi-bin/luci/admin/network/firewall/rules';

export const PROTOCOLS = [
  { value: 'tcp udp', label: 'TCP and UDP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
];

export function protoLabel(p: string): string {
  if (p === 'all') return 'Any';
  return PROTOCOLS.find((x) => x.value === p)?.label ?? p.toUpperCase();
}
