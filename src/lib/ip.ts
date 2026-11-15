/** Parse dotted-quad IPv4 into an unsigned 32-bit integer, or null. */
export function parseIPv4(value: string): number | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const octet = Number(p);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

export function formatIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isIPv4(value: string): boolean {
  return parseIPv4(value) !== null;
}

export function prefixToNetmask(prefix: number): string {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new RangeError(`Bad prefix ${prefix}`);
  return formatIPv4(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
}

/** "255.255.255.0" -> 24. Null if not a contiguous mask. */
export function netmaskToPrefix(mask: string): number | null {
  const n = parseIPv4(mask);
  if (n === null) return null;
  const inverted = ~n >>> 0;
  if ((inverted & (inverted + 1)) !== 0) return null;
  return 32 - Math.log2(inverted + 1);
}

/** Parse "192.168.1.1/24" or ("192.168.1.1", "255.255.255.0") into address + prefix. */
export function parseCidr(value: string, netmask?: string): { address: string; prefix: number } | null {
  const [addr, len] = value.trim().split('/');
  if (!addr || parseIPv4(addr) === null) return null;
  let prefix: number | null = 32;
  if (len !== undefined) prefix = /^\d{1,2}$/.test(len) && Number(len) <= 32 ? Number(len) : null;
  else if (netmask !== undefined) prefix = netmaskToPrefix(netmask);
  return prefix === null ? null : { address: addr, prefix };
}

export function inSubnet(ip: string, network: string, prefix: number): boolean {
  const a = parseIPv4(ip);
  const b = parseIPv4(network);
  if (a === null || b === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Network address of ip/prefix: ("10.0.1.7", 24) -> "10.0.1.0". */
export function networkAddress(ip: string, prefix: number): string | null {
  const a = parseIPv4(ip);
  if (a === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return formatIPv4((a & mask) >>> 0);
}

/** The address `offset` hosts into ip/prefix's network: ("10.0.1.1", 24, 100) -> "10.0.1.100". */
export function hostAt(ip: string, prefix: number, offset: number): string | null {
  const net = networkAddress(ip, prefix);
  return net === null ? null : formatIPv4((parseIPv4(net)! + offset) >>> 0);
}

/** Offset of `ip` within net/prefix, or null when outside it. */
export function hostOffset(ip: string, net: string, prefix: number): number | null {
  if (!inSubnet(ip, net, prefix)) return null;
  return parseIPv4(ip)! - parseIPv4(networkAddress(net, prefix)!)!;
}

/**
 * Who can reach an IPv4 address: 'cgnat' is the shared address space ISPs use
 * behind carrier-grade NAT (100.64.0.0/10, RFC 6598); 'private' is RFC 1918 or
 * link-local, usually another router in front of this one. Null if not IPv4.
 */
export function ipv4Scope(ip: string): 'public' | 'private' | 'cgnat' | null {
  if (!isIPv4(ip)) return null;
  if (inSubnet(ip, '100.64.0.0', 10)) return 'cgnat';
  const priv = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]] as const;
  return priv.some(([n, p]) => inSubnet(ip, n, p)) ? 'private' : 'public';
}
