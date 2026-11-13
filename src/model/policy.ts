// Zone-based policy matrix: who may start connections to whom.
// Derived from fw4's model as seen in `fw4 print` on the DL-WRX36:
//   source zone -> router       the zone's `input` policy
//   source zone -> same zone    the zone's `forward` policy (fw4 ends
//                               forward_<z> with `jump <policy>_to_<z>`)
//   source zone -> other zone   a `forwarding` section, else the defaults'
//                               forward policy (forward chain's handle_reject)
// Rules and port forwards that name the pair turn a cell "custom".

import type { UciConfig, UciSection, UciValue } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';

export const ROUTER = '@router';

export type Verdict = 'allow' | 'block';

export interface Zone {
  name: string;
  section: string;
  networks: string[];
  /** The uplink zone (masquerading, or named wan). */
  internet: boolean;
}

export interface PairRule {
  section: string;
  name: string;
  /** ACCEPT / REJECT / DROP / DNAT ... */
  target: string;
}

export interface PolicyCell {
  src: string;
  /** Zone name or ROUTER. */
  dest: string;
  verdict: Verdict;
  /** Which UCI setting decides the base verdict. */
  via: 'input' | 'zone-forward' | 'forwarding' | 'default';
  /** Enabled rules and port forwards narrowing this pair. */
  rules: PairRule[];
  /** Why the cell cannot be changed here, if it cannot. */
  locked?: string;
}

export interface PolicyMatrix {
  /** Rows: local zones, then internet zones. */
  sources: Zone[];
  /** Columns: local zones, the router, internet zones. */
  dests: (Zone | typeof ROUTER)[];
  cell(src: string, dest: string): PolicyCell;
}

function verdictOf(policy: string | undefined): Verdict {
  return (policy ?? '').toUpperCase() === 'ACCEPT' ? 'allow' : 'block';
}

export function zoneList(fw: UciConfig): Zone[] {
  return sectionsOfType(fw, 'zone').map((z) => {
    const name = str(z.name) ?? z['.name'];
    return { name, section: z['.name'], networks: list(z.network), internet: name === 'wan' || bool(z.masq, false) };
  });
}

/** The zone holding a network, if any. */
export function zoneOfNetwork(fw: UciConfig, network: string): Zone | undefined {
  return zoneList(fw).find((z) => z.networks.includes(network));
}

/** Name of the uplink zone fw4 rules should target for "the internet". */
export function internetZone(fw: UciConfig): string {
  return zoneList(fw).find((z) => z.internet)?.name ?? 'wan';
}

function defaults(fw: UciConfig): UciSection | undefined {
  return sectionsOfType(fw, 'defaults')[0];
}

const enabled = (s: UciSection) => bool(s.enabled, true);

function pairRules(fw: UciConfig): Map<string, PairRule[]> {
  const out = new Map<string, PairRule[]>();
  const zoneNames = zoneList(fw).map((z) => z.name);
  const add = (src: string, dest: string, r: PairRule) => {
    const k = `${src}>${dest}`;
    out.set(k, [...(out.get(k) ?? []), r]);
  };
  for (const s of sectionsOfType(fw, 'rule')) {
    const src = str(s.src);
    // No src: output rules. '*': device-wide rules (blocks), shown elsewhere.
    if (!enabled(s) || !src || src === '*') continue;
    const r = { section: s['.name'], name: str(s.name) ?? s['.name'], target: (str(s.target) ?? 'DROP').toUpperCase() };
    const dest = str(s.dest);
    if (!dest) add(src, ROUTER, r);
    else if (dest === '*') zoneNames.forEach((d) => add(src, d, r));
    else add(src, dest, r);
  }
  for (const s of sectionsOfType(fw, 'redirect')) {
    if (!enabled(s) || (str(s.target) ?? 'DNAT') !== 'DNAT') continue;
    const src = str(s.src) ?? 'wan';
    const dest = str(s.dest) ?? (s.dest_ip ? 'lan' : ROUTER);
    add(src, dest, { section: s['.name'], name: str(s.name) ?? 'Port forward', target: 'DNAT' });
  }
  return out;
}

/**
 * The matrix. `uiZone` is the zone the browser reaches the router through,
 * when known; blocking its access to the router is refused outright since
 * netui could not confirm the change.
 */
export function policyMatrix(fw: UciConfig, uiZone?: string): PolicyMatrix {
  const zs = zoneList(fw);
  const local = zs.filter((z) => !z.internet);
  const inet = zs.filter((z) => z.internet);
  const byName = new Map(zs.map((z) => [z.name, z]));
  const def = defaults(fw);
  const rules = pairRules(fw);
  const forwardings = sectionsOfType(fw, 'forwarding').filter(enabled);

  const cell = (src: string, dest: string): PolicyCell => {
    const zs = fw[byName.get(src)?.section ?? ''];
    const r = rules.get(`${src}>${dest}`) ?? [];
    const srcInternet = byName.get(src)?.internet ?? false;
    let c: PolicyCell;
    if (dest === ROUTER) {
      c = { src, dest, via: 'input', verdict: verdictOf(str(zs?.input) ?? str(def?.input)), rules: r };
      if (srcInternet) c.locked = 'The router stays closed to the internet. Use Router Access for ping.';
      else if (src === uiZone && c.verdict === 'allow')
        c.locked = 'You are connected through this zone. Blocking it would cut netui off from the router.';
    } else if (dest === src) {
      c = { src, dest, via: 'zone-forward', verdict: verdictOf(str(zs?.forward) ?? str(def?.forward)), rules: r };
    } else if (forwardings.some((f) => str(f.src) === src && str(f.dest) === dest)) {
      c = { src, dest, via: 'forwarding', verdict: 'allow', rules: r };
    } else {
      const v = verdictOf(str(def?.forward));
      // With an accepting default there is nothing a forwarding could add.
      c = { src, dest, via: v === 'allow' ? 'default' : 'forwarding', verdict: v, rules: r };
      if (v === 'allow') c.locked = 'The firewall’s default forward policy allows this. Change it in LuCI.';
    }
    if (srcInternet && !c.locked) {
      c.locked = 'Traffic from the internet stays blocked. Use Port Forwarding to reach a device.';
    }
    return c;
  };

  return { sources: [...local, ...inet], dests: [...local, ROUTER, ...inet], cell };
}

// ---------------------------------------------------------------------------
// Changing a cell

const isAccept = (s: UciSection) => (str(s.target) ?? '').toUpperCase() === 'ACCEPT';

function allowsPort(s: UciSection, port: string): boolean {
  return list(s.dest_port).some((p) => {
    const [a, b] = p.split(/[-:]/).map(Number);
    return a === Number(port) || (b !== undefined && a! <= Number(port) && Number(port) <= b);
  });
}

/**
 * Rules keeping DHCP and DNS reachable when a zone loses router access, the
 * same pair netui adds for isolated networks. Skipped if already present.
 */
export function essentialInputOps(fw: UciConfig, zone: string): UciOp[] {
  const input = sectionsOfType(fw, 'rule').filter((s) => str(s.src) === zone && !s.dest && isAccept(s) && enabled(s));
  const add = (values: Record<string, UciValue>): UciOp => ({ op: 'add', config: 'firewall', type: 'rule', values });
  const ops: UciOp[] = [];
  if (!input.some((s) => allowsPort(s, '67'))) {
    ops.push(add({ name: `Allow-${zone}-DHCP`, src: zone, proto: 'udp', dest_port: '67-68', target: 'ACCEPT', family: 'ipv4' }));
  }
  if (!input.some((s) => allowsPort(s, '53'))) {
    ops.push(add({ name: `Allow-${zone}-DNS`, src: zone, proto: ['tcp', 'udp'], dest_port: '53', target: 'ACCEPT' }));
  }
  return ops;
}

/** Ops to set a cell's base verdict. Empty when it already has it or is locked. */
export function cellOps(c: PolicyCell, verdict: Verdict, fw: UciConfig): UciOp[] {
  if (c.locked || c.verdict === verdict || c.via === 'default') return [];
  const zone = zoneList(fw).find((z) => z.name === c.src);
  if (!zone) return [];
  const policy = verdict === 'allow' ? 'ACCEPT' : 'REJECT';
  switch (c.via) {
    case 'input':
      return [
        ...diffSection('firewall', zone.section, fw[zone.section], { input: policy }),
        ...(verdict === 'block' ? essentialInputOps(fw, zone.name) : []),
      ];
    case 'zone-forward':
      return diffSection('firewall', zone.section, fw[zone.section], { forward: policy });
    case 'forwarding': {
      const matching = sectionsOfType(fw, 'forwarding').filter((f) => str(f.src) === c.src && str(f.dest) === c.dest);
      if (verdict === 'block') return matching.map((f) => ({ op: 'delete', config: 'firewall', section: f['.name'] }));
      const off = matching[0];
      if (off) return [{ op: 'unset', config: 'firewall', section: off['.name'], options: ['enabled'] }];
      return [{ op: 'add', config: 'firewall', type: 'forwarding', values: { src: c.src, dest: c.dest } }];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Router access from the internet

export interface WanInputRule {
  section: string;
  name: string;
  enabled: boolean;
  proto: string;
  ports: string;
  family?: string;
}

/** Input rules from the internet zone(s): Allow-Ping, Allow-DHCP-Renew, ... */
export function wanInputRules(fw: UciConfig): WanInputRule[] {
  const inet = new Set(zoneList(fw).filter((z) => z.internet).map((z) => z.name));
  return sectionsOfType(fw, 'rule')
    .filter((s) => inet.has(str(s.src) ?? '') && !s.dest)
    .map((s) => ({
      section: s['.name'],
      name: str(s.name) ?? s['.name'],
      enabled: enabled(s),
      proto: list(s.proto).join(' ') || 'tcp udp',
      ports: list(s.dest_port).join(' '),
      family: str(s.family),
    }));
}

/** The stock IPv4 echo-request rule (fw4 calls it Allow-Ping). */
export function pingRule(fw: UciConfig): WanInputRule | undefined {
  const inet = new Set(zoneList(fw).filter((z) => z.internet).map((z) => z.name));
  const s = sectionsOfType(fw, 'rule').find(
    (s) =>
      inet.has(str(s.src) ?? '') &&
      !s.dest &&
      isAccept(s) &&
      list(s.proto).includes('icmp') &&
      list(s.icmp_type).includes('echo-request') &&
      str(s.family) !== 'ipv6',
  );
  return s && wanInputRules(fw).find((r) => r.section === s['.name']);
}

export function pingOps(fw: UciConfig, on: boolean): UciOp[] {
  const r = pingRule(fw);
  if (r) {
    if (r.enabled === on) return [];
    return on
      ? [{ op: 'unset', config: 'firewall', section: r.section, options: ['enabled'] }]
      : [{ op: 'set', config: 'firewall', section: r.section, values: { enabled: '0' } }];
  }
  if (!on) return [];
  return [
    {
      op: 'add',
      config: 'firewall',
      type: 'rule',
      values: { name: 'Allow-Ping', src: internetZone(fw), proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' },
    },
  ];
}
