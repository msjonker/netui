import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { firstError, useDeviceLinks, useDeviceRadios, useInterfaces, useManagedDevices, useSystemBoard, useSystemInfo } from '../../api/queries';
import { uplinkLabel, uplinkOf } from '../../model/mesh';
import type { ManagedDevice } from '../../api/types';
import { useClients, useSwitch } from '../../model/hooks';
import { displayName } from '../../model/clients';
import { findUplink, normalizeSystem } from '../../model/network';
import { buildTopology, type TopoClient, type TopoRadio } from '../../model/topology';
import { formatDuration } from '../../lib/format';
import { IconAccessPoint, IconEthernet, IconGlobe, IconRouter, IconWifi, SignalBars } from '../../components/icons';
import { PortTile } from '../../components/PortTile';
import { Dot, LoadError, Page, Pill, Spinner, cx } from '../../components/ui';

// Topology: Internet -> Gateway -> wired ports / radios ->
// clients, drawn with HTML boxes and 1px CSS connectors.

function Node({
  icon,
  title,
  subtitle,
  href,
  label,
  status,
  children,
  class: cls,
}: {
  icon: ComponentChildren;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  href?: string;
  /** Accessible name for the link. */
  label?: string;
  status?: ComponentChildren;
  children?: ComponentChildren;
  class?: string;
}) {
  const head = (
    <div class="flex items-center gap-3">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">{icon}</span>
      <div class="min-w-0 flex-1">
        <div class="truncate font-semibold">{title}</div>
        {subtitle && <div class="truncate text-xs text-muted">{subtitle}</div>}
      </div>
      {status}
    </div>
  );
  return (
    <div class={cx('w-64 rounded-lg border border-line bg-surface p-3 shadow-sm', cls)}>
      {href ? (
        <Link href={href} aria-label={label} class="-m-1 block rounded-md p-1 hover:bg-hover">
          {head}
        </Link>
      ) : (
        head
      )}
      {children && <div class="mt-3">{children}</div>}
    </div>
  );
}

const Stem = () => <div class="mx-auto h-6 w-px bg-line-strong" aria-hidden="true" />;

/** Children hanging off one horizontal bus, org-chart style. */
function Branches({ children }: { children: ComponentChildren[] }) {
  const n = children.length;
  return (
    <div class="flex justify-center">
      {children.map((c, i) => (
        <div key={i} class="relative flex flex-col items-center px-3 pt-6">
          <span class="absolute top-0 left-1/2 h-6 w-px bg-line-strong" aria-hidden="true" />
          {n > 1 && (
            <span
              class="absolute top-0 h-px bg-line-strong"
              style={{ left: i === 0 ? '50%' : 0, right: i === n - 1 ? '50%' : 0 }}
              aria-hidden="true"
            />
          )}
          {c}
        </div>
      ))}
    </div>
  );
}

function ClientList({ clients, empty }: { clients: TopoClient[]; empty: string }) {
  if (clients.length === 0) return <p class="px-1 text-xs text-faint">{empty}</p>;
  return (
    <ul class="space-y-1">
      {clients.map((c) => (
        <li key={c.mac}>
          <Link
            href={`/clients/${c.mac}`}
            class="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2 hover:border-accent hover:bg-hover"
          >
            {c.signal != null ? <SignalBars dbm={c.signal} /> : <IconEthernet size={14} class="text-muted" />}
            <span class="min-w-0 flex-1 truncate">{c.name}</span>
            {c.ip && <span class="font-mono text-[11px] text-muted">{c.ip}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** An adopted access point: its WiFi and client count, live through the gateway. */
function AccessPointNode({ d, clients }: { d: ManagedDevice; clients: TopoClient[] }) {
  const radios = useDeviceRadios(d.mac, d.online);
  const links = useDeviceLinks(d.mac, d.online);
  const uplink = uplinkOf(links.data, radios.data);
  const ssids = [...new Set((radios.data ?? []).filter((r) => !r.mesh).map((r) => r.info.ssid).filter((s): s is string => !!s))];
  return (
    <div class="flex flex-col items-center">
      <Node
        icon={<IconAccessPoint size={18} class={d.online ? 'text-accent' : 'text-faint'} />}
        title={d.name}
        label={`${d.name} details`}
        subtitle={d.online && uplink.kind !== 'unknown' ? uplinkLabel(uplink) : [d.model, d.ip].filter(Boolean).join(' · ')}
        href={`/devices/${d.mac}`}
        status={d.online ? <Pill>{clients.length}</Pill> : <Pill tone="bad">Offline</Pill>}
      >
        {!d.online ? (
          <p class="text-xs text-faint">Not reachable.</p>
        ) : ssids.length > 0 ? (
          <div class="flex flex-wrap gap-1">
            {ssids.map((s) => (
              <Pill key={s} tone="accent">
                {s}
              </Pill>
            ))}
          </div>
        ) : (
          <p class="text-xs text-faint">No WiFi broadcasting.</p>
        )}
      </Node>
      <Stem />
      <div class="w-64">
        <ClientList clients={clients} empty="No clients connected." />
      </div>
    </div>
  );
}

function RadioNode({ r }: { r: TopoRadio }) {
  return (
    <div class="flex flex-col items-center">
      <Node
        icon={<IconWifi size={18} class={r.enabled ? 'text-accent' : 'text-faint'} />}
        title={`${r.band} radio`}
        label={`${r.band} radio settings`}
        subtitle={r.enabled ? [r.channel && `Channel ${r.channel}`, r.width].filter(Boolean).join(' · ') : 'Disabled'}
        href="/settings/wifi"
        status={<Pill>{r.clients.length}</Pill>}
      >
        {r.ssids.length > 0 ? (
          <div class="flex flex-wrap gap-1">
            {r.ssids.map((s) => (
              <Pill key={s} tone="accent">
                {s}
              </Pill>
            ))}
          </div>
        ) : (
          <p class="text-xs text-faint">No WiFi network on this radio.</p>
        )}
      </Node>
      <Stem />
      <div class="w-64">
        <ClientList clients={r.clients} empty="No clients connected." />
      </div>
    </div>
  );
}

export function TopologyPage() {
  const ifaces = useInterfaces();
  const board = useSystemBoard();
  const info = useSystemInfo();
  const { sw, error: swError } = useSwitch();
  const { clients, wifi } = useClients();
  const aps = useManagedDevices();

  const topo = useMemo(
    () =>
      buildTopology({
        system: board.data && info.data ? normalizeSystem(board.data, info.data) : undefined,
        uplink: ifaces.data ? findUplink(ifaces.data) : undefined,
        sw,
        wifi,
        clients,
      }),
    [board.data, info.data, ifaces.data, sw, wifi, clients],
  );

  const loading = !board.data || !ifaces.data;
  const wiredCount = topo.wired.reduce((n, g) => n + g.clients.length, 0);
  const { internet, gateway } = topo;

  return (
    <Page title="Topology" subtitle="How the gateway, its ports, radios and clients connect">
      <LoadError error={firstError(ifaces, board, info) ?? swError} />
      {loading ? (
        <div class="flex justify-center p-10">
          <Spinner />
        </div>
      ) : (
        <div class="overflow-x-auto pb-4">
          <div class="mx-auto flex w-max min-w-full flex-col items-center py-2">
            <Node
              icon={<IconGlobe size={18} />}
              title="Internet"
              subtitle={
                internet.online
                  ? `${internet.address ?? ''}${internet.gateway ? ` via ${internet.gateway}` : ''}`
                  : internet.iface
                    ? `No connection on ${internet.iface.toUpperCase()}`
                    : 'No uplink configured'
              }
              href="/settings/internet"
              label="Internet settings"
              status={
                <Pill tone={internet.online ? 'ok' : 'bad'}>
                  <Dot tone={internet.online ? 'ok' : 'bad'} /> {internet.online ? 'Online' : 'Offline'}
                </Pill>
              }
            />
            <Stem />
            <Node
              icon={<IconRouter size={18} />}
              title={gateway.name ?? 'Gateway'}
              subtitle={[gateway.model, gateway.firmware && `OpenWrt ${gateway.firmware}`].filter(Boolean).join(' · ')}
              href="/"
              label="Gateway dashboard"
              class="w-72"
            >
              {gateway.uptime != null && <div class="text-xs text-muted">Up {formatDuration(gateway.uptime)}</div>}
            </Node>
            <Branches>
              {[
                <div key="wired" class="flex flex-col items-center">
                  <Node
                    icon={<IconEthernet size={18} />}
                    title="Wired"
                    subtitle={`${topo.ports.filter((p) => p.carrier).length} of ${topo.ports.length} ports linked`}
                    status={<Pill>{wiredCount}</Pill>}
                  >
                    {topo.ports.length > 0 ? (
                      <div class="flex flex-wrap gap-1.5" aria-label="Ports">
                        {topo.ports.map((p) => (
                          <PortTile key={p.name} p={p} />
                        ))}
                      </div>
                    ) : (
                      <p class="text-xs text-faint">No ports reported.</p>
                    )}
                  </Node>
                  <Stem />
                  <div class="w-64 space-y-3">
                    {topo.wired.length === 0 && <ClientList clients={[]} empty="No wired clients." />}
                    {topo.wired.map((g) => (
                      <section key={g.network} aria-label={`${g.label} clients`}>
                        <h3 class="mb-1 px-1 text-xs font-semibold text-muted">{g.label}</h3>
                        <ClientList clients={g.clients} empty="No clients." />
                      </section>
                    ))}
                    <p class="px-1 text-[11px] leading-snug text-faint">
                      Wired clients are grouped by network: the router does not report which port each one is on.
                    </p>
                  </div>
                </div>,
                ...topo.radios.map((r) => <RadioNode key={r.section} r={r} />),
                ...(aps.data ?? []).map((d) => (
                  <AccessPointNode
                    key={d.mac}
                    d={d}
                    clients={clients
                      .filter((c) => c.wireless?.ap?.mac === d.mac)
                      .map((c) => ({ mac: c.mac, name: displayName(c), ip: c.ip, signal: c.wireless!.signal, ssid: c.wireless!.ssid }))}
                  />
                )),
                ...(topo.otherWireless.length
                  ? [
                      <div key="other" class="flex flex-col items-center">
                        <Node icon={<IconWifi size={18} />} title="Other wireless" status={<Pill>{topo.otherWireless.length}</Pill>} />
                        <Stem />
                        <div class="w-64">
                          <ClientList clients={topo.otherWireless} empty="" />
                        </div>
                      </div>,
                    ]
                  : []),
              ]}
            </Branches>
          </div>
        </div>
      )}
    </Page>
  );
}
