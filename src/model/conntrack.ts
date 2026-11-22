import type { ConntrackEntry } from '../api/types';

// The router's connection table as the kernel prints it in
// /proc/net/nf_conntrack, parsed here rather than on the router (netui.traffic
// sends the text: parsing in ucode cost 1.5 ms a line on a slow router).
//
//   ipv4     2 tcp      6 7440 ESTABLISHED src=a dst=b sport=1 dport=2
//   packets=3 bytes=4 [UNREPLIED] src=b dst=a sport=2 dport=1 packets=5
//   bytes=6 [ASSURED] mark=0 zone=0 use=2
//
// One entry per connection: the ORIGINAL direction (the reply tuple, and with
// it any NAT translation, is dropped) and the bytes of both directions summed
// (needs nf_conntrack_acct=1). TIME_WAIT and loopback are left out.

/** Protocols the kernel tracks without detail print as "unknown" and their number. */
const OTHER: Record<string, string> = { '2': 'igmp', '41': 'ipv6', '47': 'gre', '50': 'esp', '51': 'ah', '89': 'ospf', '112': 'vrrp' };
const PORTS = new Set(['tcp', 'udp', 'udplite', 'sctp', 'dccp']);

const value = (token: string | undefined, key: string): string | undefined =>
  token?.startsWith(`${key}=`) ? token.slice(key.length + 1) : undefined;

/** The short form of an IPv6 address the kernel writes in full (fe80:0000:...:0001 -> fe80::1). */
export function shortIPv6(full: string): string {
  const groups = full.split(':');
  if (groups.length !== 8) return full;
  const hex = groups.map((g) => g.replace(/^0+(?=.)/, '').toLowerCase());
  // The longest run of two or more zero groups becomes "::" (RFC 5952).
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (hex[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && hex[j] === '0') j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

const address = (a: string) => (a.includes(':') ? shortIPv6(a) : a);
const isLoopback = (ip: string) => ip.startsWith('127.') || ip === '::1';

/** One line of the table, or null for a line without a tuple (or TIME_WAIT, loopback). */
export function parseConntrackLine(line: string): ConntrackEntry | null {
  const t = line.trim().split(/ +/);
  // l3 name, l3 number, l4 name, l4 number, timeout, then the state word for TCP-like protocols.
  let i = 5;
  if (value(t[i], 'src') === undefined) i++;
  const src = value(t[i], 'src');
  const dst = value(t[i + 1], 'dst');
  if (src === undefined || dst === undefined || t[i - 1] === 'TIME_WAIT') return null;
  const layer4 = t[2] === 'unknown' ? (OTHER[t[3]!] ?? `proto ${t[3]}`) : t[2]!;
  let j = i + 2;
  let ports: { sport?: number; dport?: number } = {};
  if (PORTS.has(layer4)) {
    ports = { sport: Number(value(t[i + 2], 'sport')), dport: Number(value(t[i + 3], 'dport')) };
    j = i + 4;
  }
  while (j < t.length && value(t[j], 'packets') === undefined) j++;
  const sent = value(t[j + 1], 'bytes');
  if (sent === undefined) return null;
  // The reply tuple has the same fields, after an optional [UNREPLIED].
  let r = j + 2;
  if (t[r]?.startsWith('[')) r++;
  const received = value(t[r + (j + 2 - i) - 1], 'bytes');
  const zone = value(t[t.length - 2], 'zone');
  const entry: ConntrackEntry = {
    layer4,
    src: address(src),
    dst: address(dst),
    ...ports,
    bytes: Number(sent) + (received === undefined ? 0 : Number(received)),
    ...(zone === undefined ? {} : { zone }),
  };
  return isLoopback(entry.src) ? null : entry;
}

export function parseConntrack(text: string): ConntrackEntry[] {
  const out: ConntrackEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const e = parseConntrackLine(line);
    if (e) out.push(e);
  }
  return out;
}
