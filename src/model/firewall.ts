import type { UciConfig, UciValue } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { inSubnet, isIPv4, parseCidr } from '../lib/ip';
import { normalizeMac } from '../lib/mac';

// ---------------------------------------------------------------------------
// Port forwards (redirect sections with target DNAT)

export type Protocol = 'tcp' | 'udp' | 'tcp udp';

export interface PortForward {
  section: string;
  name: string;
  enabled: boolean;
  protocol: Protocol | string;
  srcZone: string;
  /** External port or range, "8080" / "8000-8100". */
  externalPort: string;
  /** Restrict to this source address, if set. */
  srcIp?: string;
  destZone: string;
  destIp: string;
  /** Internal port; defaults to the external port when unset. */
  internalPort: string;
}

export function normalizePortForwards(fw: UciConfig): PortForward[] {
  return sectionsOfType(fw, 'redirect')
    .filter((s) => (str(s.target) ?? 'DNAT') === 'DNAT')
    .map((s) => {
      const external = str(s.src_dport) ?? '';
      return {
        section: s['.name'],
        name: str(s.name) ?? '',
        enabled: bool(s.enabled, true),
        protocol: list(s.proto).join(' ') || 'tcp udp',
        srcZone: str(s.src) ?? 'wan',
        externalPort: external,
        srcIp: str(s.src_ip),
        destZone: str(s.dest) ?? 'lan',
        destIp: str(s.dest_ip) ?? '',
        internalPort: str(s.dest_port) ?? external,
      };
    });
}

/** UCI options for a port forward. `enabled` is only written when off, like LuCI. */
export function portForwardValues(p: Omit<PortForward, 'section'>): Record<string, UciValue | undefined> {
  return {
    name: p.name,
    target: 'DNAT',
    src: p.srcZone,
    dest: p.destZone,
    proto: p.protocol,
    src_dport: p.externalPort,
    dest_ip: p.destIp,
    dest_port: p.internalPort === p.externalPort ? '' : p.internalPort,
    src_ip: p.srcIp ?? '',
    enabled: p.enabled ? '' : '0',
  };
}

/** "80", "8000-8100" with every port in 1..65535 and a non-descending range. */
export function isPortSpec(v: string): boolean {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(v.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return a >= 1 && b <= 65535 && a <= b;
}

/** Zone names and the networks they cover. */
export function zones(fw: UciConfig): { name: string; networks: string[] }[] {
  return sectionsOfType(fw, 'zone').map((z) => ({ name: str(z.name) ?? z['.name'], networks: list(z.network) }));
}

// ---------------------------------------------------------------------------
// Client blocking. A block is a forward rule from any zone to any zone
// matching the client's MAC. netui manages rules whose name starts with
// BLOCK_PREFIX; other matching rules are shown but left alone.

export const BLOCK_PREFIX = 'netui: block';

export interface BlockRule {
  section: string;
  /** Normalized lowercase MACs. */
  macs: string[];
  enabled: boolean;
  managed: boolean;
  name: string;
}

export function normalizeBlockRules(fw: UciConfig): BlockRule[] {
  return sectionsOfType(fw, 'rule')
    .filter((s) => {
      const target = str(s.target);
      if (target !== 'REJECT' && target !== 'DROP') return false;
      if (list(s.src_mac).length === 0) return false;
      // Rules narrowed by port, protocol or destination are policies, not blocks.
      return !s.dest_port && !s.dest_ip && !s.proto && str(s.dest) === '*';
    })
    .map((s) => ({
      section: s['.name'],
      macs: list(s.src_mac)
        .map(normalizeMac)
        .filter((m): m is string => m !== null),
      enabled: bool(s.enabled, true),
      managed: (str(s.name) ?? '').startsWith(BLOCK_PREFIX),
      name: str(s.name) ?? '',
    }));
}

export function blockRuleValues(mac: string, label: string): Record<string, UciValue> {
  return {
    name: `${BLOCK_PREFIX} ${label}`.slice(0, 64),
    src: '*',
    dest: '*',
    src_mac: [mac.toUpperCase()],
    target: 'REJECT',
  };
}

/** Ops to block `mac`: re-enable a disabled netui rule for it, else add one. */
export function blockOps(mac: string, label: string, existing: BlockRule | undefined): UciOp[] {
  if (existing?.managed && !existing.enabled) {
    return [{ op: 'unset', config: 'firewall', section: existing.section, options: ['enabled'] }];
  }
  if (existing?.enabled) return [];
  return [{ op: 'add', config: 'firewall', type: 'rule', values: blockRuleValues(mac, label) }];
}

/**
 * Ops to unblock `mac`. netui's own rule is removed (or just loses this MAC
 * if it lists several); a rule written elsewhere is left alone and the
 * caller should send the user to LuCI.
 */
export function unblockOps(mac: string, rule: BlockRule, fw: UciConfig): UciOp[] | null {
  if (!rule.managed) return null;
  const rest = list(fw[rule.section]?.src_mac).filter((m) => normalizeMac(m) !== normalizeMac(mac));
  if (rest.length === 0) return [{ op: 'delete', config: 'firewall', section: rule.section }];
  return [{ op: 'set', config: 'firewall', section: rule.section, values: { src_mac: rest } }];
}

// ---------------------------------------------------------------------------
// Port forward editing

export type PortForwardDraft = Omit<PortForward, 'section'>;

export function newPortForward(): PortForwardDraft {
  return {
    name: '',
    enabled: true,
    protocol: 'tcp udp',
    srcZone: 'wan',
    externalPort: '',
    srcIp: undefined,
    destZone: 'lan',
    destIp: '',
    internalPort: '',
  };
}

function portCount(spec: string): number {
  const [a, b] = spec.split('-').map(Number);
  return b === undefined ? 1 : b - a! + 1;
}

/**
 * Field errors for a port forward. `subnets` are the local networks the
 * destination must sit in; the destination zone is derived from it.
 */
export function validatePortForward(
  p: PortForwardDraft,
  subnets: { network: string; address: string; prefix: number; gateway: string }[],
): Partial<Record<keyof PortForwardDraft, string>> {
  const e: Partial<Record<keyof PortForwardDraft, string>> = {};
  if (!p.name.trim()) e.name = 'Give the rule a name.';
  if (!isPortSpec(p.externalPort)) e.externalPort = 'A port (1-65535) or range like 8000-8100.';
  if (p.internalPort && !isPortSpec(p.internalPort)) e.internalPort = 'A port (1-65535) or range like 8000-8100.';
  else if (
    p.internalPort &&
    !e.externalPort &&
    portCount(p.internalPort) !== 1 &&
    portCount(p.internalPort) !== portCount(p.externalPort)
  ) {
    e.internalPort = 'A range must be the same size as the external range.';
  }
  if (!isIPv4(p.destIp)) e.destIp = 'Enter the device’s IPv4 address.';
  else if (!subnets.some((s) => inSubnet(p.destIp, s.address, s.prefix))) e.destIp = 'Not on any local network.';
  else if (subnets.some((s) => s.gateway === p.destIp)) e.destIp = 'That is the router itself.';
  if (p.srcIp) {
    const c = parseCidr(p.srcIp);
    if (!c) e.srcIp = 'An IPv4 address or subnet like 203.0.113.0/24.';
  }
  return e;
}

export function portForwardOps(p: PortForwardDraft, section: string | undefined, fw: UciConfig): UciOp[] {
  const values = portForwardValues({ ...p, internalPort: p.internalPort || p.externalPort });
  if (section) return diffSection('firewall', section, fw[section], values);
  const set = Object.fromEntries(Object.entries(values).filter((e): e is [string, UciValue] => !!e[1] && e[1].length > 0));
  return [{ op: 'add', config: 'firewall', type: 'redirect', values: set }];
}
