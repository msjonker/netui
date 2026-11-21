import { useMemo } from 'preact/hooks';
import { useQueries } from '@tanstack/react-query';
import type { ManagedDevice } from '../api/types';
import {
  firstError,
  useBoardJson,
  useDevices,
  useHostHints,
  useInterfaces,
  useLeases,
  useManagedDevices,
  fetchDeviceRadios,
  deviceKeys,
  useUci,
  useWifiState,
} from '../api/queries';
import { mergeClients } from './clients';
import { normalizeWan, wanExposure } from './internet';
import { normalizeBlockRules } from './firewall';
import { normalizeLimits } from './speedLimit';
import { localSubnets, normalizeNetworks, routerMacs } from './network';
import { normalizeSwitch } from './ports';
import { normalizeWifi } from './wifi';

// Query + normalizer pairs shared by several features. Each is a thin memo
// over the TanStack queries, so mounting the same hook twice costs nothing.

export function useWifiModel(opts: { assoc?: boolean } = {}) {
  const wireless = useUci('wireless');
  const live = useWifiState({ assoc: opts.assoc });
  const model = useMemo(
    () => (wireless.data ? normalizeWifi(wireless.data, live.devices) : undefined),
    // live.devices is rebuilt each render; key it on content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wireless.data, JSON.stringify(live.devices)],
  );
  return { model, wireless, live };
}

export function useNetworks() {
  const network = useUci('network');
  const dhcp = useUci('dhcp');
  const firewall = useUci('firewall');
  const ifaces = useInterfaces();
  const networks = useMemo(
    () => (network.data && dhcp.data ? normalizeNetworks(network.data, dhcp.data, firewall.data, ifaces.data) : undefined),
    [network.data, dhcp.data, firewall.data, ifaces.data],
  );
  const subnets = useMemo(
    () => (network.data ? localSubnets(network.data, firewall.data, ifaces.data) : []),
    [network.data, firewall.data, ifaces.data],
  );
  return { networks, subnets, network, dhcp, firewall, ifaces, error: firstError(network, dhcp, firewall, ifaces) };
}

/** Ports and VLANs on the LAN bridge. Link state refreshes every 10 s. */
export function useSwitch() {
  const network = useUci('network');
  const firewall = useUci('firewall');
  const devices = useDevices(10_000);
  const board = useBoardJson();
  // board.json only refines the port list: wait for it, but carry on without
  // it if it fails (no luci-rpc).
  const ready = network.data && !board.isPending;
  const sw = useMemo(
    () => (ready ? normalizeSwitch(network.data!, firewall.data, devices.data, board.data) : undefined),
    [ready, network.data, firewall.data, devices.data, board.data],
  );
  return { sw, network, firewall, devices, error: firstError(network, firewall, devices) };
}

export function useClients() {
  const leases = useLeases();
  const hints = useHostHints();
  const devices = useDevices(false);
  const { subnets, dhcp, firewall } = useNetworks();
  const { model: wifi, wireless } = useWifiModel({ assoc: true });

  const blocks = useMemo(() => (firewall.data ? normalizeBlockRules(firewall.data) : undefined), [firewall.data]);
  const limits = useMemo(() => (firewall.data ? normalizeLimits(firewall.data) : undefined), [firewall.data]);
  // Adopted access points take a DHCP lease like anything else; they are
  // infrastructure, not clients.
  const managed = useManagedDevices();
  const apAssoc = useApAssoc(managed.data);
  const infra = useMemo(() => new Set((managed.data ?? []).map((d) => d.mac)), [managed.data]);
  const merged = useMemo(
    () =>
      mergeClients({
        leases: leases.data,
        hints: hints.data,
        dhcp: dhcp.data,
        assoc: [...(wifi?.assoc ?? []), ...apAssoc],
        blocks,
        limits,
        routerMacs: devices.data ? routerMacs(devices.data) : undefined,
        subnets,
      }),
    [leases.data, hints.data, dhcp.data, wifi, blocks, limits, devices.data, subnets, apAssoc],
  );
  const clients = useMemo(() => (infra.size ? merged.filter((c) => !infra.has(c.mac)) : merged), [merged, infra]);
  return {
    clients,
    subnets,
    wifi,
    dhcp,
    firewall,
    isPending: leases.isPending || dhcp.isPending,
    // No radios is not an error for the client list.
    error: firstError(leases, dhcp, firewall),
    wirelessError: wireless.error,
  };
}

// ---------------------------------------------------------------------------
// Events (system log), with names resolved from the merged client list.
// (Imports kept with this section so parallel edits to the header don't collide.)

import { useLog, useSystemInfo } from '../api/queries';
import { clockSkew, parseEvents, wifiIfnames } from './events';
import { wanNetworks } from './network';

export function useEvents(refetchInterval?: number | false) {
  const log = useLog(refetchInterval);
  const info = useSystemInfo();
  const { clients, wifi, firewall } = useClients();
  const { live } = useWifiModel({ assoc: true });
  const { sw } = useSwitch();
  const events = useMemo(
    () =>
      parseEvents(log.data ?? [], {
        clients,
        wifi: wifiIfnames(wifi, live.devices),
        wanNetworks: wanNetworks(firewall.data),
        ports: sw ? Object.fromEntries(sw.ports.map((p) => [p.name, p.role])) : undefined,
      }),
    // live.devices is rebuilt each render; key it on content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log.data, clients, wifi, firewall.data, sw, JSON.stringify(live.devices)],
  );
  // Recomputed per system.info poll; stable between them.
  const skew = useMemo(
    () => clockSkew(log.data ?? [], info.data, info.dataUpdatedAt),
    [log.data, info.data, info.dataUpdatedAt],
  );
  return { events, skew, log };
}

// --- Clients / Insights -----------------------------------------------------

import { useEffect as useEffectCI, useState as useStateCI } from 'preact/hooks';
import { useConntrack } from '../api/queries';
import { clientAddresses, withRadioInfo } from './clients';
import { localPredicate, traffic } from './traffic';

/**
 * useClients() plus live detail: radio channel/width per station, and
 * per-client traffic from the connection table (polled every 5 s while
 * mounted, unless `traffic` is false). Clients with live connections get
 * `active`, which keeps them out of the Offline filter.
 */
export function useClientDetails(opts: { traffic?: boolean } = {}) {
  const base = useClients();
  const live = useWifiState({ assoc: true });
  const ifaces = useInterfaces();
  const ct = useConntrack(opts.traffic ?? true);
  const [, bump] = useStateCI(0);

  const isLocal = useMemo(() => {
    const ifs = ifaces.data?.interface ?? [];
    return localPredicate({
      subnets: base.subnets,
      prefixes6: ifs.flatMap((i) => i['ipv6-prefix-assignment'] ?? []),
      router: ifs.flatMap((i) => [
        ...(i['ipv4-address'] ?? []).map((a) => a.address),
        ...(i['ipv6-prefix-assignment'] ?? []).flatMap((p) => p['local-address']?.address ?? []),
      ]),
      known: base.clients.flatMap((c) => c.ip6 ?? []),
    });
  }, [base.subnets, base.clients, ifaces.data]);

  useEffectCI(() => {
    if (!ct.data) return;
    traffic.add(ct.data.entries, ct.dataUpdatedAt, isLocal);
    bump((n) => n + 1);
    // Sample once per poll; isLocal changing alone must not re-add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ct.dataUpdatedAt]);

  const infoKey = live.devices.map((d) => `${d.ifname}:${d.info?.channel}:${d.info?.htmode}`).join();
  const clients = useMemo(() => {
    const busy = new Set(traffic.conns.map((c) => c.local));
    return withRadioInfo(base.clients, live.devices).map((c) =>
      clientAddresses(c).some((ip) => busy.has(ip)) ? { ...c, active: true } : c,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.clients, infoKey, traffic.version]);

  return { ...base, clients, live: live.devices, conntrack: ct, traffic };
}

const BAND_OF_MHZ = (mhz: number | undefined) =>
  !mhz ? undefined : mhz < 3000 ? '2.4 GHz' : mhz < 5925 ? '5 GHz' : '6 GHz';

/**
 * Stations on adopted access points, as client-merge input: each entry names
 * the access point and carries its radio's channel and width. Shares the
 * Devices page's cache of each device's radios.
 */
export function useApAssoc(devices: ManagedDevice[] | undefined) {
  const online = (devices ?? []).filter((d) => d.online);
  const radios = useQueries({
    queries: online.map((d) => ({
      queryKey: deviceKeys.radios(d.mac),
      queryFn: () => fetchDeviceRadios(d.mac),
      refetchInterval: 10_000,
    })),
  });
  const stamp = radios.map((q) => q.dataUpdatedAt).join();
  return useMemo(
    () =>
      online.flatMap((d, i) =>
        (radios[i]?.data ?? [])
          .filter((r) => !r.mesh && r.stations.length)
          .map((r) => ({
            ifname: r.ifname,
            ssid: r.info.ssid,
            band: BAND_OF_MHZ(r.info.frequency),
            stations: r.stations,
            ap: { mac: d.mac, name: d.name },
            channel: r.info.channel,
            htmode: r.info.htmode,
          })),
      ),
    // radios is rebuilt each render; the update stamps identify the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp, online.map((d) => `${d.mac}:${d.name}`).join()],
  );
}

/** How the internet sees the primary WAN (public, carrier-grade NAT or behind another router). */
export function useWanExposure() {
  const network = useUci('network');
  const firewall = useUci('firewall');
  const ifaces = useInterfaces();
  return useMemo(
    () => wanExposure(network.data && normalizeWan(network.data, firewall.data), ifaces.data),
    [network.data, firewall.data, ifaces.data],
  );
}
