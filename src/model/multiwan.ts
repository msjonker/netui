// A second WAN (WAN2) with mwan3: failover or load balancing.
//
// netui uses mwan3's stock layout as installed (recorded in
// test/fixtures/ubus/bench-v2/gateway.uci.get.mwan3.json): interfaces `wan`
// and `wanb`, policies `wan_wanb` (wan first, wanb when it fails) and
// `balanced`, and the rules `default_rule_v4` and `https` choosing between
// them. WAN2 is the network interface `wanb` on a port taken out of the LAN
// bridge, in the firewall's wan zone. Anything else in mwan3 is a custom setup
// and stays LuCI's.

import type { UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { isIPv4, inSubnet } from '../lib/ip';
import { currentPlan, switchOps, vlanOf, type Switch } from './ports';

export const WAN1 = 'wan';
export const WAN2 = 'wanb';

export type MultiWanMode = 'failover' | 'balance';

const POLICY: Record<MultiWanMode, string> = { failover: 'wan_wanb', balance: 'balanced' };
/** The rules netui points at the chosen policy. */
const RULES = ['default_rule_v4', 'https'];

export interface MultiWan {
  /** mwan3's stock interfaces, policies and default rule are all there. */
  supported: boolean;
  /** WAN2 exists in network and is enabled in mwan3. */
  enabled: boolean;
  port?: string;
  proto: 'dhcp' | 'static';
  address?: string;
  prefix?: number;
  gateway?: string;
  dns: string[];
  mode: MultiWanMode | 'custom';
}

export function readMultiWan(network: UciConfig, mwan3: UciConfig): MultiWan {
  const rule = mwan3.default_rule_v4;
  const supported =
    !!mwan3[WAN1] && !!mwan3[WAN2] && !!mwan3.balanced && !!mwan3.wan_wanb && !!rule && str(rule['.type']) === 'rule';
  const policy = str(rule?.use_policy);
  const s = network[WAN2];
  const [address, prefix] = (str(s?.ipaddr) ?? '').split('/');
  return {
    supported,
    enabled: !!s && bool(mwan3[WAN2]?.enabled, false),
    port: str(s?.device),
    proto: str(s?.proto) === 'static' ? 'static' : 'dhcp',
    address: address || undefined,
    prefix: prefix ? Number(prefix) : str(s?.netmask) ? undefined : address ? 24 : undefined,
    gateway: str(s?.gateway),
    dns: list(s?.dns),
    mode: policy === POLICY.balance ? 'balance' : policy === POLICY.failover ? 'failover' : 'custom',
  };
}

export interface MultiWanDraft {
  port: string;
  proto: 'dhcp' | 'static';
  address: string;
  prefix: string;
  gateway: string;
  /** Comma or space separated; static only. */
  dns: string;
  mode: MultiWanMode;
}

export function multiWanDraft(m: MultiWan, ports: string[]): MultiWanDraft {
  return {
    port: m.port ?? ports[ports.length - 1] ?? '',
    proto: m.proto,
    address: m.address ?? '',
    prefix: String(m.prefix ?? 24),
    gateway: m.gateway ?? '',
    dns: m.dns.join(', '),
    mode: m.mode === 'balance' ? 'balance' : 'failover',
  };
}

const splitList = (v: string) => v.split(/[\s,]+/).filter(Boolean);

export function validateMultiWan(d: MultiWanDraft): Partial<Record<keyof MultiWanDraft, string>> {
  const e: Partial<Record<keyof MultiWanDraft, string>> = {};
  if (!d.port) e.port = 'Choose a port for the second connection.';
  if (d.proto === 'static') {
    const prefix = Number(d.prefix);
    if (!isIPv4(d.address)) e.address = 'Enter an IPv4 address.';
    if (!/^\d{1,2}$/.test(d.prefix) || prefix < 1 || prefix > 32) e.prefix = 'A prefix length from 1 to 32.';
    if (!isIPv4(d.gateway)) e.gateway = 'Enter the gateway’s IPv4 address.';
    else if (!e.address && !e.prefix && !inSubnet(d.gateway, d.address, prefix)) e.gateway = 'Not in this connection’s subnet.';
    const bad = splitList(d.dns).find((x) => !isIPv4(x));
    if (bad) e.dns = `${bad} is not an IPv4 address.`;
    else if (splitList(d.dns).length === 0) e.dns = 'Enter at least one DNS server.';
  }
  return e;
}

function wanZone(firewall: UciConfig) {
  return sectionsOfType(firewall, 'zone').find((z) => str(z.name) === 'wan');
}

/**
 * Set up or change WAN2. The port leaves the LAN bridge (and its VLANs), each
 * WAN gets its own route metric (mwan3 needs them distinct), WAN2 joins the
 * wan firewall zone, and mwan3 enables it with the chosen policy.
 */
export function multiWanOps(
  d: MultiWanDraft,
  ctx: { network: UciConfig; firewall: UciConfig; mwan3: UciConfig; sw: Switch },
): UciOp[] {
  const { network, firewall, mwan3, sw } = ctx;
  const ops: UciOp[] = [];
  const before = str(network[WAN2]?.device);

  // Ports: the new one leaves the bridge; a previous WAN2 port goes back to the LAN.
  // (A port already used as WAN2 is not in the plan: it is a WAN port now.)
  const physical = (p: string | undefined) => !!p && sw.ports.some((x) => x.name === p);
  const plan = currentPlan(sw);
  if (physical(d.port)) plan.profiles[d.port] = { tagged: [] };
  if (before !== d.port && physical(before)) plan.profiles[before!] = { native: vlanOf(sw, 'lan')?.vid ?? 1, tagged: [] };
  ops.push(...switchOps(sw, plan, network));

  const wanMetric = Number(str(network[WAN1]?.metric) ?? '') || 10;
  if (!str(network[WAN1]?.metric)) ops.push({ op: 'set', config: 'network', section: WAN1, values: { metric: String(wanMetric) } });
  const values = {
    proto: d.proto,
    device: d.port,
    metric: String(wanMetric + 10),
    ipaddr: d.proto === 'static' ? `${d.address}/${d.prefix}` : '',
    netmask: '',
    gateway: d.proto === 'static' ? d.gateway : '',
    dns: d.proto === 'static' ? splitList(d.dns) : [],
  };
  if (network[WAN2]) ops.push(...diffSection('network', WAN2, network[WAN2], values));
  else
    ops.push({
      op: 'add',
      config: 'network',
      type: 'interface',
      name: WAN2,
      values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && !(Array.isArray(v) && v.length === 0))),
    });

  const zone = wanZone(firewall);
  if (zone && !list(zone.network).includes(WAN2)) {
    ops.push({ op: 'set', config: 'firewall', section: zone['.name'], values: { network: [...list(zone.network), WAN2] } });
  }

  ops.push(...diffSection('mwan3', WAN2, mwan3[WAN2], { enabled: '1' }));
  for (const r of RULES) if (mwan3[r]) ops.push(...diffSection('mwan3', r, mwan3[r], { use_policy: POLICY[d.mode] }));
  return ops;
}

/** Remove WAN2: its port goes back to the LAN, mwan3 stops tracking it. */
export function removeMultiWanOps(ctx: { network: UciConfig; firewall: UciConfig; mwan3: UciConfig; sw: Switch }): UciOp[] {
  const { network, firewall, mwan3, sw } = ctx;
  const ops: UciOp[] = [];
  const port = str(network[WAN2]?.device);
  if (port && sw.ports.some((x) => x.name === port)) {
    const plan = currentPlan(sw);
    plan.profiles[port] = { native: vlanOf(sw, 'lan')?.vid ?? 1, tagged: [] };
    ops.push(...switchOps(sw, plan, network));
  }
  if (network[WAN2]) ops.push({ op: 'delete', config: 'network', section: WAN2 });
  const zone = wanZone(firewall);
  if (zone && list(zone.network).includes(WAN2)) {
    ops.push({ op: 'set', config: 'firewall', section: zone['.name'], values: { network: list(zone.network).filter((n) => n !== WAN2) } });
  }
  ops.push(...diffSection('mwan3', WAN2, mwan3[WAN2], { enabled: '0' }));
  return ops;
}

/** Ports WAN2 can use: on the LAN bridge or unused, never the primary WAN's. */
export function wan2Ports(sw: Switch, current?: string): Switch['ports'] {
  return sw.ports.filter((p) => p.role !== 'wan' || p.name === current);
}
