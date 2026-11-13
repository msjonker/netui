import { useMemo } from 'preact/hooks';
import {
  firstError,
  useBoardJson,
  useDevices,
  useHostHints,
  useInterfaces,
  useLeases,
  useUci,
  useWifiState,
} from '../api/queries';
import { mergeClients } from './clients';
import { normalizeBlockRules } from './firewall';
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
  const clients = useMemo(
    () =>
      mergeClients({
        leases: leases.data,
        hints: hints.data,
        dhcp: dhcp.data,
        assoc: wifi?.assoc,
        blocks,
        routerMacs: devices.data ? routerMacs(devices.data) : undefined,
        subnets,
      }),
    [leases.data, hints.data, dhcp.data, wifi, blocks, devices.data, subnets],
  );
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
    traffic.add(ct.data, ct.dataUpdatedAt, isLocal);
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
