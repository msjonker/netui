import type { NlbwTable } from '../api/types';

// nlbwmon counts per local host: rx is what the host downloaded, tx what it
// uploaded. Rows come per host and application (port-based: HTTPS, DNS...).

export interface AppUsage {
  name: string;
  rx: number;
  tx: number;
}

export interface HostUsage {
  mac: string;
  rx: number;
  tx: number;
  conns: number;
  /** Largest first. */
  apps: AppUsage[];
}

export interface Usage {
  /** Largest total first; empty hosts left out. */
  hosts: HostUsage[];
  apps: AppUsage[];
  rx: number;
  tx: number;
}

const OTHER = 'Other';

const byTotal = <T extends { rx: number; tx: number }>(a: T, b: T) => b.rx + b.tx - (a.rx + a.tx);

export function normalizeUsage(t: NlbwTable): Usage {
  const col = (name: string) => t.columns.indexOf(name);
  const [iMac, iRx, iTx, iConns, iApp, iProto] = ['mac', 'rx_bytes', 'tx_bytes', 'conns', 'layer7', 'proto'].map(col);
  const hosts = new Map<string, HostUsage & { appMap: Map<string, AppUsage> }>();
  const apps = new Map<string, AppUsage>();
  const add = (m: Map<string, AppUsage>, name: string, rx: number, tx: number) => {
    const a = m.get(name) ?? { name, rx: 0, tx: 0 };
    a.rx += rx;
    a.tx += tx;
    m.set(name, a);
  };
  for (const row of t.data) {
    const mac = String(row[iMac!] ?? '').toLowerCase();
    const rx = Number(row[iRx!] ?? 0);
    const tx = Number(row[iTx!] ?? 0);
    if (!mac || /^(00:){5}00$/.test(mac) || rx + tx === 0) continue;
    // Unclassified traffic: name it by protocol when that says something (ICMP), else Other.
    const proto = iProto! >= 0 ? String(row[iProto!] ?? '') : '';
    const app = (iApp! >= 0 && (row[iApp!] as string | null)) || (proto && proto !== 'IP' && proto !== 'TCP' && proto !== 'UDP' ? proto : OTHER);
    const h = hosts.get(mac) ?? { mac, rx: 0, tx: 0, conns: 0, apps: [], appMap: new Map() };
    h.rx += rx;
    h.tx += tx;
    h.conns += Number(row[iConns!] ?? 0);
    add(h.appMap, app, rx, tx);
    hosts.set(mac, h);
    add(apps, app, rx, tx);
  }
  const list = [...hosts.values()].map(({ appMap, ...h }) => ({ ...h, apps: [...appMap.values()].sort(byTotal) })).sort(byTotal);
  return {
    hosts: list,
    apps: [...apps.values()].sort(byTotal),
    rx: list.reduce((n, h) => n + h.rx, 0),
    tx: list.reduce((n, h) => n + h.tx, 0),
  };
}

/** One row for the router's own addresses (WAN, LAN bridge...): it is one device. */
export function mergeHosts(hosts: HostUsage[], macs: Set<string>, key: string): HostUsage[] {
  const own = hosts.filter((h) => macs.has(h.mac));
  if (own.length < 2) return hosts;
  const apps = new Map<string, AppUsage>();
  for (const a of own.flatMap((h) => h.apps)) {
    const m = apps.get(a.name) ?? { name: a.name, rx: 0, tx: 0 };
    m.rx += a.rx;
    m.tx += a.tx;
    apps.set(a.name, m);
  }
  const merged: HostUsage = {
    mac: key,
    rx: own.reduce((n, h) => n + h.rx, 0),
    tx: own.reduce((n, h) => n + h.tx, 0),
    conns: own.reduce((n, h) => n + h.conns, 0),
    apps: [...apps.values()].sort(byTotal),
  };
  return [...hosts.filter((h) => !macs.has(h.mac)), merged].sort(byTotal);
}

/** "2026-11-01" -> "November 2026"; nlbwmon periods start on the configured day. */
export function periodLabel(start: string): string {
  const d = new Date(`${start}T00:00:00`);
  if (Number.isNaN(d.getTime())) return start;
  const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return d.getDate() === 1 ? label : `From ${d.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
}
