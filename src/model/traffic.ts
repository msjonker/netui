import type { ConntrackEntry } from '../api/types';
import { inSubnet, isIPv4 } from '../lib/ip';
import { RingBuffer } from '../lib/ringbuffer';
import { HISTORY_MS } from '../lib/throughput';
import type { Subnet } from './network';

// Per-client traffic from the router's connection table (luci
// getConntrackList). What the data allows, and what it does not:
//
// - Each entry is one connection's ORIGINAL tuple with the byte count of
//   both directions summed (see ConntrackEntry). So traffic is attributable
//   to a LAN host, but not split into download and upload.
// - The reply tuple is dropped, so a port-forwarded (DNAT) connection shows
//   the router's WAN address as destination and cannot be attributed.
// - Counters only exist since the connection started, so usage counts from
//   the first poll after netui was opened; a connection that closes between
//   two polls loses its last few seconds.
// - Flows accelerated in hardware (NSS/ECM, flow offloading) may not update
//   the counters at all, or only in bursts.
//
// Kept at module level, like the device throughput history: survives page
// changes, lost on reload.

export const SERVICE_PORTS: Record<number, string> = {
  20: 'FTP',
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  67: 'DHCP',
  68: 'DHCP',
  80: 'HTTP',
  110: 'POP3',
  123: 'NTP',
  143: 'IMAP',
  443: 'HTTPS',
  445: 'SMB',
  465: 'SMTP',
  500: 'IPsec',
  554: 'RTSP',
  587: 'SMTP',
  853: 'DNS over TLS',
  993: 'IMAP',
  995: 'POP3',
  1194: 'OpenVPN',
  1883: 'MQTT',
  1900: 'SSDP',
  3074: 'Xbox Live',
  3389: 'Remote Desktop',
  3478: 'STUN',
  4500: 'IPsec',
  5060: 'SIP',
  5222: 'XMPP',
  5223: 'Apple Push',
  5228: 'Google Play',
  5353: 'mDNS',
  8080: 'HTTP',
  8443: 'HTTPS',
  8883: 'MQTT',
  19302: 'Google Meet',
  51820: 'WireGuard',
};

/** Friendly name for a destination port, e.g. "HTTPS", "QUIC", "TCP 8123". */
export function serviceName(proto: string, port: number | undefined): string {
  if (port === undefined) return proto.toUpperCase();
  if (port === 443 && proto === 'udp') return 'QUIC';
  return SERVICE_PORTS[port] ?? `${proto.toUpperCase()} ${port}`;
}

export interface Connection {
  /** LAN-side address the traffic is attributed to. */
  local: string;
  remote: string;
  /** Destination port of the original direction: the service. */
  port?: number;
  proto: string;
  service: string;
  /** Both directions since the connection opened. */
  bytes: number;
  /** Bytes/s over the last poll; null on the first sight of the table. */
  rate: number | null;
  /** The LAN host opened it (as opposed to an inbound connection). */
  outbound: boolean;
}

export interface RatePoint {
  /** seconds since epoch */
  t: number;
  /** bytes/s, both directions; null across a polling gap */
  v: number | null;
}

export interface HostTraffic {
  ip: string;
  /** Bytes since netui started watching. */
  total: number;
  /** Latest rate, bytes/s. */
  rate: number | null;
  points: RingBuffer<RatePoint>;
}

const LOOPBACK = /^(127\.|::1$)/;

export class TrafficTracker {
  private prev = new Map<string, number>();
  private at = 0;
  private readonly capacity: number;
  readonly hosts = new Map<string, HostTraffic>();
  /** Cumulative bytes by service name and by remote address. */
  readonly services = new Map<string, number>();
  readonly remotes = new Map<string, number>();
  /** Attributed connections in the latest poll. */
  conns: Connection[] = [];
  /** All entries in the latest poll, loopback excluded. */
  active = 0;
  /** Bumped on every sample, for memo keys. */
  version = 0;

  constructor(
    private readonly intervalMs = 5_000,
    historyMs = HISTORY_MS,
  ) {
    this.capacity = Math.ceil(historyMs / intervalMs);
  }

  /**
   * Fold one poll in. `isLocal` says which addresses are LAN hosts (not the
   * router itself). Returns false for a repeat of an already-seen poll.
   */
  add(entries: ConntrackEntry[], at: number, isLocal: (ip: string) => boolean): boolean {
    if (at <= this.at) return false;
    const first = this.at === 0;
    const dt = at - this.at;
    const gap = !first && dt > this.intervalMs * 3;
    this.at = at;

    const next = new Map<string, number>();
    const perHost = new Map<string, number>();
    const conns: Connection[] = [];
    let active = 0;
    for (const e of entries) {
      if (LOOPBACK.test(e.src)) continue;
      active++;
      const key = `${e.layer4} ${e.src} ${e.sport} ${e.dst} ${e.dport} ${e.zone}`;
      next.set(key, e.bytes);
      const outbound = isLocal(e.src);
      const local = outbound ? e.src : isLocal(e.dst) ? e.dst : undefined;
      if (!local) continue;
      const before = this.prev.get(key);
      // New since the last poll: all of its bytes are new. A smaller count
      // means the tuple was reused by a new connection.
      const delta = first ? 0 : before === undefined || e.bytes < before ? e.bytes : e.bytes - before;
      const remote = outbound ? e.dst : e.src;
      const service = serviceName(e.layer4, e.dport);
      conns.push({
        local,
        remote,
        port: e.dport,
        proto: e.layer4,
        service,
        bytes: e.bytes,
        rate: first || gap ? null : (delta * 1000) / dt,
        outbound,
      });
      perHost.set(local, (perHost.get(local) ?? 0) + delta);
      if (delta) {
        this.services.set(service, (this.services.get(service) ?? 0) + delta);
        this.remotes.set(remote, (this.remotes.get(remote) ?? 0) + delta);
      }
    }
    this.prev = next;
    this.conns = conns;
    this.active = active;

    // Every host seen so far gets a point, so a host going quiet drops to 0.
    for (const ip of perHost.keys()) {
      if (!this.hosts.has(ip)) this.hosts.set(ip, { ip, total: 0, rate: null, points: new RingBuffer(this.capacity) });
    }
    for (const h of this.hosts.values()) {
      const d = perHost.get(h.ip) ?? 0;
      h.total += d;
      h.rate = first || gap ? null : (d * 1000) / dt;
      h.points.push({ t: at / 1000, v: h.rate });
    }
    this.version++;
    return true;
  }

  /** Sum over several addresses (a client's IPv4 and IPv6 addresses). */
  host(ips: string[]): { total: number; rate: number | null; points: RatePoint[] } | undefined {
    const hs = ips.map((ip) => this.hosts.get(ip)).filter((h): h is HostTraffic => !!h);
    if (!hs.length) return undefined;
    if (hs.length === 1) return { total: hs[0]!.total, rate: hs[0]!.rate, points: hs[0]!.points.toArray() };
    // Points of different hosts share timestamps (every host gets one per poll).
    const byT = new Map<number, number | null>();
    for (const h of hs) {
      for (const p of h.points.toArray()) {
        const cur = byT.get(p.t);
        byT.set(p.t, p.v === null ? (cur ?? null) : (cur ?? 0) + p.v);
      }
    }
    const rates = hs.map((h) => h.rate);
    return {
      total: hs.reduce((a, h) => a + h.total, 0),
      rate: rates.every((r) => r === null) ? null : rates.reduce<number>((a, r) => a + (r ?? 0), 0),
      points: [...byT].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })),
    };
  }

  reset(): void {
    this.prev.clear();
    this.at = 0;
    this.hosts.clear();
    this.services.clear();
    this.remotes.clear();
    this.conns = [];
    this.active = 0;
  }
}

/** The app-wide tracker fed by useClientTraffic(). */
export const traffic = new TrafficTracker();

/** Top `n` entries of a byte map, largest first. */
export function topBytes(m: Map<string, number>, n: number): [string, number][] {
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------------------------------------------------------------------------
// Which side of a connection is the LAN host.

/** Eight 16-bit groups of an IPv6 address, or null. */
function hextets(ip: string): number[] | null {
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const part = (s: string | undefined) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const out = [...head, ...Array<number>(fill).fill(0), ...tail];
  return out.every((h) => h >= 0 && h <= 0xffff) ? out : null;
}

export function inPrefix6(ip: string, prefix: string, mask: number): boolean {
  const a = hextets(ip);
  const b = hextets(prefix);
  if (!a || !b) return false;
  for (let i = 0; i < 8 && mask > 0; i++, mask -= 16) {
    const bits = Math.min(16, mask);
    const m = (0xffff << (16 - bits)) & 0xffff;
    if ((a[i]! & m) !== (b[i]! & m)) return false;
  }
  return true;
}

export interface LocalScope {
  subnets: Subnet[];
  /** IPv6 prefixes delegated to LAN interfaces. */
  prefixes6?: { address: string; mask: number }[];
  /** The router's own addresses, never a LAN host. */
  router?: string[];
  /** Addresses known to belong to clients (e.g. IPv6 from host hints). */
  known?: Iterable<string>;
}

/** Memoized predicate: is `ip` a LAN host (on a local subnet, not the router)? */
export function localPredicate(scope: LocalScope): (ip: string) => boolean {
  const router = new Set([...scope.subnets.map((s) => s.gateway), ...(scope.router ?? [])]);
  const known = new Set(scope.known ?? []);
  const memo = new Map<string, boolean>();
  return (ip) => {
    let r = memo.get(ip);
    if (r === undefined) {
      r =
        !router.has(ip) &&
        (known.has(ip) ||
          (isIPv4(ip)
            ? scope.subnets.some((s) => inSubnet(ip, s.address, s.prefix))
            : !ip.startsWith('fe80') && (scope.prefixes6 ?? []).some((p) => inPrefix6(ip, p.address, p.mask))));
      if (memo.size > 50_000) memo.clear();
      memo.set(ip, r);
    }
    return r;
  };
}

/** Clients ranked by usage since netui started watching, with their current rate (bytes/s). */
export function topClientsByUsage<C extends { mac: string }>(
  clients: C[],
  addresses: (c: C) => string[],
  hosts: Map<string, HostTraffic>,
  n: number,
): { client: C; total: number; rate: number }[] {
  return clients
    .map((client) => {
      const hs = addresses(client).flatMap((ip) => hosts.get(ip) ?? []);
      return { client, total: hs.reduce((a, h) => a + h.total, 0), rate: hs.reduce((a, h) => a + (h.rate ?? 0), 0) };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}
