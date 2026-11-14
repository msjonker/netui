// Topology: the tree Internet -> Gateway -> ports / radios ->
// clients, as plain layout data. ubus exposes no bridge FDB, so wired clients
// cannot be pinned to a port: they hang off the wired side grouped by network.

import type { Client } from './clients';
import { displayName } from './clients';
import type { SystemSummary, Uplink } from './network';
import { networkLabel } from './network';
import type { Switch, SwitchPort } from './ports';
import type { WifiModel } from './wifi';

export interface TopoClient {
  mac: string;
  name: string;
  ip?: string;
  /** dBm, wireless only. */
  signal?: number;
  ssid?: string;
}

export interface TopoPort {
  name: string;
  /** "WAN" for the uplink port, else the netdev name. */
  label: string;
  role: SwitchPort['role'];
  carrier: boolean;
  speed?: number;
}

export interface TopoRadio {
  section: string;
  band: string;
  enabled: boolean;
  /** Live channel when up, else the configured one ("Auto" for auto). */
  channel?: string;
  /** "80 MHz" from htmode. */
  width?: string;
  ssids: string[];
  clients: TopoClient[];
}

export interface Topology {
  internet: { online: boolean; iface?: string; address?: string; gateway?: string; proto?: string };
  gateway: { name?: string; model?: string; firmware?: string; uptime?: number };
  ports: TopoPort[];
  /** Wired clients by network. */
  wired: { network: string; label: string; clients: TopoClient[] }[];
  radios: TopoRadio[];
  /** Associated to a radio the WiFi model does not know about. */
  otherWireless: TopoClient[];
}

export interface TopologyInput {
  system?: SystemSummary;
  uplink?: Uplink;
  sw?: Switch;
  wifi?: WifiModel;
  clients: Client[];
}

/** "HE80" -> "80 MHz"; "NOHT" or unknown -> undefined. */
export function channelWidth(htmode: string | undefined): string | undefined {
  const m = htmode ? /^(?:HT|VHT|HE|EHT)(\d+)\+?$/.exec(htmode) : null;
  return m ? `${m[1]} MHz` : undefined;
}

/**
 * Seen on the network now, as far as ubus can tell: associated, holding a
 * lease, or reported by host hints at an address other than its reservation.
 * A reservation or block rule alone is not presence.
 */
export function isPresent(c: Client): boolean {
  return !!c.wireless || c.leaseExpires !== undefined || (!!c.ip && c.ip !== c.reservation?.ip);
}

const byName = (a: TopoClient, b: TopoClient) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function topoClient(c: Client): TopoClient {
  return { mac: c.mac, name: displayName(c), ip: c.ip, signal: c.wireless?.signal, ssid: c.wireless?.ssid };
}

export function buildTopology({ system, uplink, sw, wifi, clients }: TopologyInput): Topology {
  const present = clients.filter(isPresent);

  const radios: TopoRadio[] = (wifi?.radios ?? []).map((r) => {
    const members = (wifi?.wlans ?? []).flatMap((w) =>
      w.members.filter((m) => m.radio === r.section).map((m) => ({ ssid: w.ssid, member: m })),
    );
    const ifnames = new Set(members.map((m) => m.member.ifname).filter(Boolean));
    return {
      section: r.section,
      band: r.bandLabel,
      enabled: r.enabled,
      channel: r.live?.channel != null ? String(r.live.channel) : r.channel === 'auto' ? 'Auto' : r.channel,
      width: channelWidth(r.htmode),
      ssids: [...new Set(members.filter((m) => m.member.enabled && r.enabled).map((m) => m.ssid))],
      clients: present.filter((c) => c.wireless && !c.wireless.ap && ifnames.has(c.wireless.ifname)).map(topoClient).sort(byName),
    };
  });

  const placed = new Set(radios.flatMap((r) => r.clients.map((c) => c.mac)));
  const otherWireless: TopoClient[] = [];
  // Stations on adopted access points hang off those devices, not this router's radios.
  for (const c of present.filter((x) => x.wireless && !x.wireless.ap && !placed.has(x.mac))) {
    // Not matched by ifname (e.g. the radio is down in UCI but still serving):
    // fall back to the only radio on the same band.
    const sameBand = radios.filter((r) => r.band === c.wireless!.band);
    if (sameBand.length === 1) sameBand[0]!.clients.push(topoClient(c));
    else otherWireless.push(topoClient(c));
  }
  radios.forEach((r) => r.clients.sort(byName));

  const groups = new Map<string, TopoClient[]>();
  for (const c of present.filter((x) => !x.wireless)) {
    const key = c.network ?? '';
    groups.set(key, [...(groups.get(key) ?? []), topoClient(c)]);
  }
  const wired = [...groups]
    .map(([network, cs]) => ({ network, label: network ? networkLabel(network) : 'Other', clients: cs.sort(byName) }))
    // Named networks first ("lan" before "iot"), unknown last.
    .sort((a, b) => (a.network === '' ? 1 : b.network === '' ? -1 : a.network === 'lan' ? -1 : b.network === 'lan' ? 1 : a.label.localeCompare(b.label)));

  const ports: TopoPort[] = (sw?.ports ?? [])
    .map((p) => ({ name: p.name, label: p.role === 'wan' ? 'WAN' : p.name, role: p.role, carrier: p.carrier, speed: p.speed }))
    .sort((a, b) => (a.role === 'wan' ? -1 : b.role === 'wan' ? 1 : 0));

  return {
    internet: {
      // Static WANs stay up without a cable; trust the port's link too.
      online: !!uplink?.up && !!uplink.gateway && sw?.ports.find((p) => p.role === 'wan')?.carrier !== false,
      iface: uplink?.name,
      address: uplink?.address,
      gateway: uplink?.gateway,
      proto: uplink?.proto,
    },
    gateway: { name: system?.hostname, model: system?.model, firmware: system?.version, uptime: system?.uptime },
    ports,
    wired,
    radios,
    otherWireless,
  };
}
