// Content filtering per network through public filtering resolvers
// (Cloudflare for Families). Three pieces:
//   dhcp <pool>.dhcp_option  "6,<v4>,<v4>"    dnsmasq hands these out over DHCPv4.
//                                             Written with dns.ts setDhcpOption, so
//                                             it replaces a custom DNS entry from the
//                                             Networks page rather than adding a
//                                             second option 6; switching off removes
//                                             option 6 only while it is still ours.
//   dhcp <pool>.dns          <v6> <v6>        odhcpd (and dnsmasq DHCPv6) announce
//                                             these instead of the router over RA and
//                                             DHCPv6. Same override/remove rule.
//   firewall rule "netui: filter <net>"      REJECT tcp/udp 53 and 853 from the
//                                             network to the internet unless the
//                                             destination is one of the resolvers.
// Every other dhcp_option entry is kept in place.

import type { UciConfig, UciValue } from '../api/types';
import { diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { findDhcpOption, setDhcpOption } from './dns';
import type { Subnet } from './network';
import { internetZone, zoneOfNetwork } from './policy';

export type FilterLevel = 'none' | 'malware' | 'family';

export const RESOLVERS: Record<Exclude<FilterLevel, 'none'>, { v4: [string, string]; v6: [string, string] }> = {
  malware: { v4: ['1.1.1.2', '1.0.0.2'], v6: ['2606:4700:4700::1112', '2606:4700:4700::1002'] },
  family: { v4: ['1.1.1.3', '1.0.0.3'], v6: ['2606:4700:4700::1113', '2606:4700:4700::1003'] },
};

export const FILTER_PREFIX = 'netui: filter ';

const LEVELS = ['malware', 'family'] as const;
type Level = (typeof LEVELS)[number];
const dhcpOption = (l: Level) => `6,${RESOLVERS[l].v4.join(',')}`;
const sameList = (a: string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface NetworkFilter {
  network: string;
  level: FilterLevel;
  /** dhcp section serving the network. */
  pool?: string;
  zone?: string;
  /** netui's firewall rule for this network. */
  rule?: string;
  /** Custom DNS servers (Networks page or LuCI) a filter would override. */
  foreignDns: string[];
  /** The DHCP and firewall halves disagree (edited elsewhere, or half-applied). */
  incomplete: boolean;
  /** Why filtering cannot be switched on. */
  blocker?: string;
}

function levelFromOptions(opts: string[]): FilterLevel {
  const six = findDhcpOption(opts, 6);
  return LEVELS.find((l) => sameList(six, [dhcpOption(l)])) ?? 'none';
}

function levelFromRule(dest: string[]): FilterLevel {
  return LEVELS.find((l) => dest.includes(`!${RESOLVERS[l].v4[0]}`)) ?? 'none';
}

export function normalizeFilters(networks: string[], dhcp: UciConfig, fw: UciConfig): NetworkFilter[] {
  const pools = sectionsOfType(dhcp, 'dhcp');
  const rules = sectionsOfType(fw, 'rule');
  return networks.map((network) => {
    const pool = pools.find((p) => str(p.interface) === network);
    const opts = list(pool?.dhcp_option);
    const rule = rules.find((r) => str(r.name) === `${FILTER_PREFIX}${network}`);
    const fromDhcp = levelFromOptions(opts);
    const fromRule = rule ? levelFromRule(list(rule.dest_ip)) : 'none';
    const v6 = list(pool?.dns);
    const zone = zoneOfNetwork(fw, network)?.name;
    const f: NetworkFilter = {
      network,
      level: fromDhcp !== 'none' ? fromDhcp : fromRule,
      pool: pool?.['.name'],
      zone,
      rule: rule?.['.name'],
      foreignDns:
        fromDhcp === 'none'
          ? [...findDhcpOption(opts, 6).flatMap((o) => o.split(',').slice(1)), ...v6]
          : v6.filter((a) => !RESOLVERS[fromDhcp].v6.includes(a)),
      incomplete: fromDhcp !== fromRule,
    };
    if (!pool || str(pool.ignore) === '1') f.blocker = 'DHCP is off on this network.';
    else if (!zone) f.blocker = 'This network has no firewall zone.';
    return f;
  });
}

export function filterRuleValues(level: Level, f: NetworkFilter, ctx: { fw: UciConfig; subnets: Subnet[] }): Record<string, UciValue> {
  const zone = zoneOfNetwork(ctx.fw, f.network);
  const subnet = ctx.subnets.find((s) => s.network === f.network);
  // A zone shared with other networks is narrowed by IPv4 subnet, which makes
  // the rule IPv4-only: leave out the IPv6 exceptions fw4 could not pair.
  const shared = !!zone && zone.networks.length > 1 && !!subnet;
  const allowed = [...RESOLVERS[level].v4, ...(shared ? [] : RESOLVERS[level].v6)];
  return {
    name: `${FILTER_PREFIX}${f.network}`,
    src: f.zone ?? '',
    src_ip: shared ? `${subnet!.address}/${subnet!.prefix}` : '',
    dest: internetZone(ctx.fw),
    dest_ip: allowed.map((a) => `!${a}`),
    proto: ['tcp', 'udp'],
    dest_port: ['53', '853'],
    target: 'REJECT',
  };
}

/**
 * Ops to move a network to `level`. Turning a filter on overrides the pool's
 * DNS servers; turning it off removes them only while they are still the
 * filter's own, so a custom server set since then survives.
 */
export function filterOps(
  f: NetworkFilter,
  level: FilterLevel,
  ctx: { dhcp: UciConfig; fw: UciConfig; subnets: Subnet[] },
): UciOp[] {
  const ops: UciOp[] = [];
  if (f.pool) {
    const pool = ctx.dhcp[f.pool];
    const opts = list(pool?.dhcp_option);
    const dns = list(pool?.dns);
    const was = levelFromOptions(opts);
    const own = LEVELS.flatMap((l) => RESOLVERS[l].v6);
    ops.push(
      ...diffSection(
        'dhcp',
        f.pool,
        pool,
        level !== 'none'
          ? { dhcp_option: setDhcpOption(opts, 6, RESOLVERS[level].v4), dns: RESOLVERS[level].v6 }
          : { dhcp_option: was !== 'none' ? setDhcpOption(opts, 6, []) : opts, dns: dns.filter((a) => !own.includes(a)) },
      ),
    );
  }
  if (level === 'none') {
    if (f.rule) ops.push({ op: 'delete', config: 'firewall', section: f.rule });
  } else {
    const values = filterRuleValues(level, f, { fw: ctx.fw, subnets: ctx.subnets });
    if (f.rule) ops.push(...diffSection('firewall', f.rule, ctx.fw[f.rule], values));
    else {
      const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v.length > 0));
      ops.push({ op: 'add', config: 'firewall', type: 'rule', values: set });
    }
  }
  return ops;
}
