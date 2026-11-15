import { useEffect, useState } from 'preact/hooks';
import { QueryClient, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { read, SessionExpiredError, TransportError, UbusError, UbusStatus } from './ubus';
import { getChanges, getConfig } from './uci';
import { discoverDevices, listDevices, relay } from './devices';
import { AddonMissingError } from './packages';
import type {
  AssocList,
  BoardJson,
  DeviceStatusMap,
  DhcpLeases,
  HostHints,
  InterfaceDump,
  IwinfoDevices,
  IwinfoInfo,
  SystemBoard,
  SystemInfo,
  UciConfig,
  UciGet,
} from './types';
import { POLL_INTERVAL_MS, ThroughputSeries } from '../lib/throughput';

// One hook per data source. Every fetch goes through read(), so the hooks a
// page mounts in the same render go out as a single batched request.
//
// UCI-backed queries keep staleTime 0: the router is the source of truth and
// other tools edit the same config.

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        // Re-read on focus even if fresh: LuCI or ssh may have changed config meanwhile.
        refetchOnWindowFocus: 'always',
        // Polling stops while document.hidden (TanStack default); stated explicitly.
        refetchIntervalInBackground: false,
        // Only transient transport failures are worth retrying. A ubus status
        // error will not fix itself, and an expired session must go to login.
        retry: (failureCount, error) =>
          !(error instanceof SessionExpiredError) && error instanceof TransportError && failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}

export const keys = {
  interfaces: ['network.interface', 'dump'] as const,
  devices: ['network.device', 'status'] as const,
  systemInfo: ['system', 'info'] as const,
  systemBoard: ['system', 'board'] as const,
  leases: ['luci-rpc', 'getDHCPLeases'] as const,
  hints: ['luci-rpc', 'getHostHints'] as const,
  board: ['luci-rpc', 'getBoardJSON'] as const,
  wifiDevices: ['iwinfo', 'devices'] as const,
  wifiInfo: (dev: string) => ['iwinfo', 'info', dev] as const,
  assoc: (dev: string) => ['iwinfo', 'assoclist', dev] as const,
  uci: (config: string) => ['uci', config] as const,
  changes: ['uci-changes'] as const,
};

const LIVE_MS = 10_000;

export const useInterfaces = (refetchInterval: number | false = LIVE_MS) =>
  useQuery({
    queryKey: keys.interfaces,
    queryFn: () => read<InterfaceDump>('network.interface', 'dump'),
    refetchInterval,
  });

export const useDevices = (refetchInterval: number | false = POLL_INTERVAL_MS) =>
  useQuery({
    queryKey: keys.devices,
    queryFn: () => read<DeviceStatusMap>('network.device', 'status'),
    refetchInterval,
  });

export const useSystemInfo = () =>
  useQuery({ queryKey: keys.systemInfo, queryFn: () => read<SystemInfo>('system', 'info'), refetchInterval: LIVE_MS });

export const useSystemBoard = () =>
  useQuery({ queryKey: keys.systemBoard, queryFn: () => read<SystemBoard>('system', 'board') });

export const useLeases = () =>
  useQuery({
    queryKey: keys.leases,
    queryFn: () => read<DhcpLeases>('luci-rpc', 'getDHCPLeases'),
    refetchInterval: LIVE_MS,
  });

export const useHostHints = () =>
  useQuery({
    queryKey: keys.hints,
    queryFn: () => read<HostHints>('luci-rpc', 'getHostHints'),
    refetchInterval: 30_000,
  });

/** The factory port layout. Fixed for the life of the firmware, so read once. */
export const useBoardJson = () =>
  useQuery({
    queryKey: keys.board,
    queryFn: () => read<BoardJson>('luci-rpc', 'getBoardJSON'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

export const useUci = (config: string) =>
  useQuery<UciConfig>({ queryKey: keys.uci(config), queryFn: () => getConfig(config) });

/** Changes staged in this session but not applied (e.g. after an interrupted apply). */
export const useStagedChanges = (enabled = true) =>
  useQuery({ queryKey: keys.changes, queryFn: getChanges, enabled });

export const useWifiDevices = () =>
  useQuery({
    queryKey: keys.wifiDevices,
    queryFn: async () => (await read<IwinfoDevices>('iwinfo', 'devices')).devices,
    refetchInterval: 30_000,
  });

export interface WifiDeviceState {
  ifname: string;
  info?: IwinfoInfo;
  stations?: AssocList['results'];
}

/** iwinfo info (and optionally assoclist) for every wireless device. */
export function useWifiState(opts: { assoc?: boolean; refetchInterval?: number } = {}): {
  devices: WifiDeviceState[];
  isPending: boolean;
  error: Error | null;
} {
  const devs = useWifiDevices();
  const names = devs.data ?? [];
  const interval = opts.refetchInterval ?? LIVE_MS;
  const infos = useQueries({
    queries: names.map((device) => ({
      queryKey: keys.wifiInfo(device),
      queryFn: () => read<IwinfoInfo>('iwinfo', 'info', { device }),
      refetchInterval: interval,
    })),
  });
  const assocs = useQueries({
    queries: (opts.assoc ? names : []).map((device) => ({
      queryKey: keys.assoc(device),
      queryFn: async () => (await read<AssocList>('iwinfo', 'assoclist', { device })).results,
      refetchInterval: interval,
    })),
  });
  // Only an access point's stations are clients: a mesh interface lists other
  // routers, a client-mode interface the access point it joined.
  const devices = names.map((ifname, i) => {
    const info = infos[i]?.data;
    const ap = !info?.mode || info.mode === 'Master';
    return { ifname, info, stations: ap ? assocs[i]?.data : undefined };
  });
  // Shared queries give every caller the same timestamp, so several mounted
  // components sample each poll once.
  const sampledAt = Math.max(0, ...assocs.map((q) => q.dataUpdatedAt));
  useEffect(() => {
    if (sampledAt) sampleStations(devices, sampledAt);
    // devices is rebuilt every render; the timestamp identifies the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampledAt]);
  return {
    devices,
    isPending: devs.isPending,
    error: devs.error ?? infos.find((q) => q.error)?.error ?? null,
  };
}

/** First error among several queries, for a page-level error banner. */
export function firstError(...qs: Pick<UseQueryResult, 'error'>[]): Error | null {
  return qs.find((q) => q.error)?.error ?? null;
}

// ---------------------------------------------------------------------------
// Throughput history. Client-side only (no persisted history in v1): kept at
// module level so it survives navigating between pages, lost on reload.

const series = new Map<string, ThroughputSeries>();
let lastSampledAt = 0;

function sampleDevices(data: DeviceStatusMap, at: number): void {
  if (at === lastSampledAt) return;
  lastSampledAt = at;
  for (const [name, d] of Object.entries(data)) {
    let s = series.get(name);
    if (!s) series.set(name, (s = new ThroughputSeries()));
    s.add({ t: at, rxBytes: d.statistics.rx_bytes, txBytes: d.statistics.tx_bytes });
  }
}

/**
 * Poll network.device status every 3 s while visible and return the rate
 * series for `device` in uPlot's aligned form. Re-renders on every sample.
 */
export function useThroughput(device: string | undefined) {
  const q = useDevices(POLL_INTERVAL_MS);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!q.data) return;
    sampleDevices(q.data, q.dataUpdatedAt);
    bump((n) => n + 1);
  }, [q.data, q.dataUpdatedAt]);
  const s = device ? series.get(device) : undefined;
  return { data: s?.toAligned() ?? ([[], [], []] as ReturnType<ThroughputSeries['toAligned']>), latest: s?.points.last(), query: q };
}

/** Per-station byte-counter rates from successive assoclist polls. */
const stationSeries = new Map<string, ThroughputSeries>();

let stationsSampledAt = 0;

export function sampleStations(devices: WifiDeviceState[], at: number): void {
  if (at <= stationsSampledAt) return;
  stationsSampledAt = at;
  for (const d of devices) {
    for (const st of d.stations ?? []) {
      if (st.rx.bytes === undefined || st.tx.bytes === undefined) continue;
      const key = st.mac.toLowerCase();
      let s = stationSeries.get(key);
      if (!s) stationSeries.set(key, (s = new ThroughputSeries(60_000, LIVE_MS)));
      // From the AP's view rx is upload from the client, tx is download to it.
      s.add({ t: at, rxBytes: st.tx.bytes, txBytes: st.rx.bytes });
    }
  }
}

/** Latest download/upload rate for a client, bytes/s, from the client's view. */
export function stationRate(mac: string): { down: number | null; up: number | null } | undefined {
  const p = stationSeries.get(mac)?.points.last();
  return p && { down: p.rx, up: p.tx };
}

// ---------------------------------------------------------------------------
// Internet / SQM / UPnP / DDNS
// (Imports kept with this section so parallel edits to the header don't collide.)

import { call } from './ubus';
import type { DdnsServicesStatus, UpnpStatus } from './types';

export const internetKeys = {
  upnp: ['luci.upnp', 'get_status'] as const,
  ddns: ['luci.ddns', 'get_services_status'] as const,
  mwan3: ['mwan3', 'status'] as const,
  adblock: ['netui.services', 'adblock'] as const,
  portal: ['netui.services', 'portal'] as const,
};

/** Active UPnP / NAT-PMP port maps. Runtime state, not config. */
export const useUpnpStatus = (enabled = true) =>
  useQuery({
    queryKey: internetKeys.upnp,
    queryFn: async () => (await read<UpnpStatus>('luci.upnp', 'get_status')).rules ?? [],
    refetchInterval: LIVE_MS,
    enabled,
  });

export const useDdnsStatus = (enabled = true) =>
  useQuery({
    queryKey: internetKeys.ddns,
    // rpcd sends a bare [0] (no data) when the reply is an empty object.
    queryFn: async () => (await read<DdnsServicesStatus | undefined>('luci.ddns', 'get_services_status')) ?? {},
    refetchInterval: 60_000,
    enabled,
  });

/**
 * Drop one UPnP port map. This edits miniupnpd's lease file and restarts it,
 * runtime state rather than UCI, so it bypasses the apply flow.
 */
export const deleteUpnpRule = (token: string) => call('luci.upnp', 'delete_rule', { token });

/** adblock-fast's state; polled quickly while lists download after an apply. */
export const useAdblockStatus = (enabled = true) =>
  useQuery({
    queryKey: internetKeys.adblock,
    enabled,
    refetchInterval: (q) => (q.state.data?.busy ? 3_000 : 30_000),
    queryFn: () => read<import('./types').AdblockStatus>('netui.services', 'adblock'),
  });

/** openNDS: running, and the guests it knows. */
export const usePortalStatus = (enabled = true) =>
  useQuery({
    queryKey: internetKeys.portal,
    enabled,
    refetchInterval: (q) => (q.state.data?.busy ? 3_000 : 15_000),
    queryFn: () => read<import('./types').PortalStatus>('netui.services', 'portal'),
  });

/** mwan3's view of each WAN: online, offline or not tracked (mwan3 installed). */
export const useMwanStatus = (enabled = true) =>
  useQuery({
    queryKey: internetKeys.mwan3,
    enabled,
    refetchInterval: LIVE_MS,
    queryFn: () => read<import('./types').MwanStatus>('mwan3', 'status'),
  });

// --- Routing / DNS / System -------------------------------------------------

export const systemKeys = {
  timezones: ['luci', 'getTimezones'] as const,
  localtime: ['luci', 'getUnixtime'] as const,
};

/** The zone list ships with the firmware: read once. */
export const useTimezones = () =>
  useQuery({
    queryKey: systemKeys.timezones,
    queryFn: () => read<import('./types').LuciTimezones>('luci', 'getTimezones'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

/** luci-base renamed getLocaltime to getUnixtime in 2026 (26.x); older releases only have the first. */
async function routerClock(): Promise<number> {
  try {
    return (await read<import('./types').LuciLocaltime>('luci', 'getUnixtime')).result;
  } catch (e) {
    if (!(e instanceof UbusError && e.status === UbusStatus.METHOD_NOT_FOUND)) throw e;
    return (await read<import('./types').LuciLocaltime>('luci', 'getLocaltime')).result;
  }
}

export const useLocaltime = () =>
  useQuery({
    queryKey: systemKeys.localtime,
    queryFn: routerClock,
    refetchInterval: 30_000,
  });

// ---------------------------------------------------------------------------
// WiFi radio capabilities and channel survey. `radio` is a wifi-device section
// name, which iwinfo resolves to its phy even with no interface up.

export const wifiKeys = {
  freqlist: (radio: string) => ['iwinfo', 'freqlist', radio] as const,
  txpowerlist: (radio: string) => ['iwinfo', 'txpowerlist', radio] as const,
  countrylist: (radio: string) => ['iwinfo', 'countrylist', radio] as const,
  radioInfo: (radio: string) => ['iwinfo', 'info', 'radio', radio] as const,
  survey: (dev: string) => ['iwinfo', 'survey', dev] as const,
};

/** Channels the regulatory domain allows. Changes with the country, so not cached forever. */
export const useFreqList = (radio: string | undefined) =>
  useQuery({
    queryKey: wifiKeys.freqlist(radio ?? ''),
    queryFn: async () => (await read<import('./types').IwinfoFreqList>('iwinfo', 'freqlist', { device: radio })).results,
    enabled: !!radio,
  });

export const useTxPowerList = (radio: string | undefined) =>
  useQuery({
    queryKey: wifiKeys.txpowerlist(radio ?? ''),
    queryFn: async () => (await read<import('./types').IwinfoTxPowerList>('iwinfo', 'txpowerlist', { device: radio })).results,
    enabled: !!radio,
  });

/** The list of country codes ships with the firmware: read once. */
export const useCountryList = (radio: string | undefined) =>
  useQuery({
    queryKey: wifiKeys.countrylist(radio ?? ''),
    queryFn: async () => (await read<import('./types').IwinfoCountryList>('iwinfo', 'countrylist', { device: radio })).results,
    enabled: !!radio,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

/** iwinfo info for a radio (htmodes etc.), available while the radio is down. */
export const useRadioInfo = (radio: string | undefined) =>
  useQuery({
    queryKey: wifiKeys.radioInfo(radio ?? ''),
    queryFn: () => read<IwinfoInfo>('iwinfo', 'info', { device: radio }),
    enabled: !!radio,
  });

/** Channel survey counters of a live interface, polled while the page is visible. */
export const useSurvey = (device: string | undefined, refetchInterval = LIVE_MS) =>
  useQuery({
    queryKey: wifiKeys.survey(device ?? ''),
    queryFn: async () => (await read<import('./types').IwinfoSurvey>('iwinfo', 'survey', { device })).results,
    enabled: !!device,
    refetchInterval,
  });

// --- VPN (WireGuard) ----------------------------------------------------------

export const vpnKeys = {
  wgInstances: ['luci.wireguard', 'getWgInstances'] as const,
};

/** Live WireGuard state (`wg show all dump`): handshakes, endpoints, transfer. */
export const useWgInstances = (refetchInterval: number | false = 10_000) =>
  useQuery({
    queryKey: vpnKeys.wgInstances,
    // No instances: rpcd sends a bare [0] (no data), not {}.
    queryFn: async () => (await read<import('./types').WgInstances | undefined>('luci.wireguard', 'getWgInstances')) ?? {},
    refetchInterval,
  });

// ---------------------------------------------------------------------------
// Events (system log)

import { useQueryClient } from '@tanstack/react-query';
import type { LogEntry, LogRead } from './types';
import { mergeLog } from '../model/events';

export const eventKeys = {
  log: ['log', 'read'] as const,
};

/** How many lines each poll asks logd for. */
export const LOG_LINES = 500;

/**
 * The router's syslog, polled while visible. Each poll reads the last
 * LOG_LINES lines and merges them by id into what was already read, so lines
 * that scroll out of the router's window stay visible until reload.
 */
export function useLog(refetchInterval: number | false = LIVE_MS) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: eventKeys.log,
    queryFn: async () => {
      const fresh = await read<LogRead>('log', 'read', { lines: LOG_LINES, stream: false, oneshot: true });
      return mergeLog(qc.getQueryData<LogEntry[]>(eventKeys.log) ?? [], fresh.log ?? []);
    },
    refetchInterval,
  });
}

// ---------------------------------------------------------------------------
// Clients / Insights: connection tracking, on-demand WiFi scans, reconnect.

export const insightKeys = {
  conntrack: ['luci', 'getConntrackList'] as const,
  scan: (dev: string) => ['iwinfo', 'scan', dev] as const,
};

export const CONNTRACK_POLL_MS = 5_000;

/**
 * The router's connection table, polled every 5 s while a page that needs it
 * is mounted and visible. It can run to thousands of entries: no structural
 * sharing (each poll is consumed once by model/traffic.ts) and dropped soon
 * after the last observer goes.
 */
export const useConntrack = (enabled = true) =>
  useQuery({
    queryKey: insightKeys.conntrack,
    queryFn: async () => (await read<import('./types').ConntrackList>('luci', 'getConntrackList')).result ?? [],
    refetchInterval: CONNTRACK_POLL_MS,
    structuralSharing: false,
    gcTime: 30_000,
    enabled,
  });

/**
 * Neighbouring networks per radio. Scanning takes the radio off-channel for a
 * few seconds, so it never runs on its own: results stay cached in memory
 * until `scan()` is called again.
 */
export function useWifiScan(devices: string[]) {
  const qs = useQueries({
    queries: devices.map((device) => ({
      queryKey: insightKeys.scan(device),
      queryFn: async () =>
        (await call<import('./types').IwinfoScan>('iwinfo', 'scan', { device }, { timeoutMs: 30_000 })).results ?? [],
      enabled: false,
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
  });
  return {
    results: qs.map((q, i) => ({ ifname: devices[i]!, data: q.data, at: q.dataUpdatedAt, error: q.error })),
    scanning: qs.some((q) => q.isFetching),
    scan: () => Promise.all(qs.map((q) => q.refetch())),
  };
}

/**
 * Kick a WiFi client off so it reassociates (reason 5: AP busy; no ban).
 * Runtime action on hostapd, not config, so it bypasses the apply flow.
 */
export const reconnectClient = (ifname: string, mac: string, apMac?: string) => {
  const args = { addr: mac, reason: 5, deauth: true, ban_time: 0 };
  // A station on an adopted access point: ask that device's hostapd, through the gateway.
  return apMac ? relay(apMac, `hostapd.${ifname}`, 'del_client', args, true) : call(`hostapd.${ifname}`, 'del_client', args);
};

/**
 * Send a Wake-on-LAN packet out of `device` (the client's network bridge) with
 * etherwake. A runtime action, like reconnecting. Recorded on the DL-WRX36:
 * {code: 0} when sent, status NOT_FOUND without the package, code 1 + stderr
 * for a bad interface.
 */
export async function wakeClient(device: string, mac: string): Promise<void> {
  try {
    const r = await call<{ code?: number; stderr?: string }>(
      'file',
      'exec',
      { command: '/usr/bin/etherwake', params: ['-i', device, mac] },
      { permissionDeniedIsAuth: false },
    );
    if (r?.code) throw new Error(r.stderr?.trim() || `etherwake exited with ${r.code}`);
  } catch (e) {
    if (e instanceof UbusError && e.status === UbusStatus.NOT_FOUND) {
      throw new AddonMissingError('wol', 'Wake-on-LAN needs a small add-on on the router.');
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// --- Devices (adopted access points, via the gateway's netui.devices plugin)

export const deviceKeys = {
  list: ['netui.devices', 'list'] as const,
  pending: ['netui.devices', 'discover'] as const,
  system: (mac: string) => ['netui.devices', 'call', mac, 'system'] as const,
  radios: (mac: string) => ['netui.devices', 'call', mac, 'iwinfo'] as const,
};

/** Adopted access points with live online state. */
export const useManagedDevices = (refetchInterval: number | false = LIVE_MS) =>
  useQuery({ queryKey: deviceKeys.list, queryFn: listDevices, refetchInterval });

/** Access points waiting for adoption. Probing the LAN is cheap but not free: every 15 s. */
export const usePendingDevices = (enabled = true) =>
  useQuery({ queryKey: deviceKeys.pending, queryFn: discoverDevices, enabled, refetchInterval: 15_000 });

export interface DeviceSystem {
  info: SystemInfo;
  board: SystemBoard;
}

/** Uptime, load, memory and firmware of an adopted device. */
export const useDeviceSystem = (mac: string | undefined, enabled = true) =>
  useQuery({
    queryKey: deviceKeys.system(mac ?? ''),
    enabled: !!mac && enabled,
    refetchInterval: LIVE_MS,
    queryFn: async (): Promise<DeviceSystem> => {
      const [info, board] = await Promise.all([
        relay<SystemInfo>(mac!, 'system', 'info'),
        relay<SystemBoard>(mac!, 'system', 'board'),
      ]);
      return { info, board };
    },
  });

export interface DeviceRadio {
  ifname: string;
  info: IwinfoInfo;
  /** WiFi clients; 0 for the mesh interface, whose peers are routers. */
  clients: number;
  /** 802.11s backhaul rather than an access point. */
  mesh: boolean;
  /** Mesh peers (other routers) with signal and rates; empty for access points. */
  peers: AssocList['results'];
  /** WiFi clients with signal and rates; empty for the mesh interface. */
  stations: AssocList['results'];
}

/** iwinfo info and assoclist for every interface of an adopted device, through the relay. */
export async function fetchDeviceRadios(mac: string): Promise<DeviceRadio[]> {
  const { devices } = await relay<IwinfoDevices>(mac, 'iwinfo', 'devices');
  return Promise.all(
    devices.map(async (ifname) => {
      const [info, assoc] = await Promise.all([
        relay<IwinfoInfo>(mac, 'iwinfo', 'info', { device: ifname }),
        relay<AssocList>(mac, 'iwinfo', 'assoclist', { device: ifname }),
      ]);
      const mesh = info.mode === 'Mesh Point';
      // Only an access point's stations are clients (a client-mode interface lists the AP it joined).
      const ap = !info.mode || info.mode === 'Master';
      return {
        ifname,
        info,
        mesh,
        clients: ap ? assoc.results.length : 0,
        peers: mesh ? assoc.results : [],
        stations: ap ? assoc.results : [],
      };
    }),
  );
}

/** The device's radios: broadcasting WiFi and the mesh backhaul, with their clients. */
export const useDeviceRadios = (mac: string | undefined, enabled = true) =>
  useQuery({
    queryKey: deviceKeys.radios(mac ?? ''),
    enabled: !!mac && enabled,
    refetchInterval: LIVE_MS,
    queryFn: () => fetchDeviceRadios(mac!),
  });

/** Link state of the device's ports, to tell a wired uplink from a mesh one. */
export const useDeviceLinks = (mac: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...deviceKeys.system(mac ?? ''), 'links'] as const,
    enabled: !!mac && enabled,
    refetchInterval: LIVE_MS,
    queryFn: () => relay<DeviceStatusMap>(mac!, 'network.device', 'status'),
  });

/** An access point's own wireless config, through the relay. */
export const useDeviceWireless = (mac: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...deviceKeys.radios(mac ?? ''), 'uci'] as const,
    enabled: !!mac && enabled,
    queryFn: async () => (await relay<UciGet>(mac!, 'uci', 'get', { config: 'wireless' })).values,
  });

/** iwinfo info, freqlist and txpowerlist for one radio of an access point (by its UCI name). */
export const useDeviceRadioCaps = (mac: string | undefined, radio: string | undefined) =>
  useQuery({
    queryKey: [...deviceKeys.radios(mac ?? ''), 'caps', radio ?? ''] as const,
    enabled: !!mac && !!radio,
    staleTime: 60_000,
    queryFn: async () => {
      const [info, freqs, power] = await Promise.all([
        relay<IwinfoInfo>(mac!, 'iwinfo', 'info', { device: radio }),
        relay<import('./types').IwinfoFreqList>(mac!, 'iwinfo', 'freqlist', { device: radio }),
        relay<import('./types').IwinfoTxPowerList>(mac!, 'iwinfo', 'txpowerlist', { device: radio }),
      ]);
      return { info, freqs: freqs.results, power: power.results };
    },
  });
