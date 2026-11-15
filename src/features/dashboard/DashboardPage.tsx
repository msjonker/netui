import { useMemo } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { firstError, useInterfaces, useSystemBoard, useSystemInfo, useThroughput } from '../../api/queries';
import { findUplink, networkLabel, normalizeSystem, uplinkOnline } from '../../model/network';
import { clientAddresses, displayName } from '../../model/clients';
import { averageExperience } from '../../model/experience';
import { topClientsByUsage } from '../../model/traffic';
import { collapseRepeats, relativeTime, type NetEvent } from '../../model/events';
import { useSpeedTest } from '../../api/speedtest';
import { useClientDetails, useClients, useEvents, useSwitch } from '../../model/hooks';
import { buildTopology } from '../../model/topology';
import type { SwitchPort } from '../../model/ports';
import { formatBitrate, formatBytes, formatDuration, formatPercent } from '../../lib/format';
import { TimeSeriesChart } from '../../components/TimeSeriesChart';
import { EventRow } from '../../components/EventRow';
import { IconArrowDown, IconArrowUp, IconWifi, SignalBars } from '../../components/icons';
import { PortTile } from '../../components/PortTile';
import { Card, Dot, Empty, LoadError, Meter, Page, Pill, Spinner, Stat } from '../../components/ui';
import { SetupBanner } from './SetupBanner';

const SERIES = [
  { label: 'Download', color: '--accent' },
  { label: 'Upload', color: '--violet' },
];

function rate(v: number | null | undefined) {
  return v == null ? '—' : formatBitrate(v);
}

/** Bytes/s as a tile-sized bit rate: "0", "840K", "12M", "1.2G". */
export function compactRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null) return '—';
  const bits = bytesPerSecond * 8;
  if (bits < 1000) return '0';
  const [v, unit] = bits >= 1e9 ? [bits / 1e9, 'G'] : bits >= 1e6 ? [bits / 1e6, 'M'] : [bits / 1e3, 'K'];
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${unit}`;
}

// ---------------------------------------------------------------------------
// Gateway health strip

function HealthStrip() {
  const board = useSystemBoard();
  const info = useSystemInfo();
  const sys = board.data && info.data ? normalizeSystem(board.data, info.data) : undefined;
  const load = info.data?.load.map((l) => (l / 65536).toFixed(2));
  const root = info.data?.root;

  return (
    <Card class="lg:col-span-3">
      {!sys ? (
        <Spinner />
      ) : (
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" aria-label="Gateway health">
          <Stat label="Gateway" value={<span class="text-base">{sys.hostname}</span>} hint={sys.model} />
          <Stat label="CPU load" value={load?.[0]} hint={load && `${load[1]} · ${load[2]} (5 / 15 min)`} />
          <div class="min-w-0">
            <div class="text-xs text-muted">Memory</div>
            <div class="text-xl font-semibold tabular-nums">{formatPercent(sys.memoryUsed)}</div>
            <div class="mt-1 w-full max-w-32">
              <Meter value={sys.memoryUsed} tone={sys.memoryUsed > 0.85 ? 'warn' : 'accent'} />
            </div>
          </div>
          <Stat label="Uptime" value={formatDuration(sys.uptime)} />
          <Stat
            label="Firmware"
            value={<span class="text-base">OpenWrt {sys.version}</span>}
            hint={root ? `${formatBytes(root.avail * 1024)} free on overlay` : sys.target}
          />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Internet

function InternetCard() {
  const ifaces = useInterfaces();
  const uplink = ifaces.data ? findUplink(ifaces.data) : undefined;
  // From the router's view the WAN port receives downloads.
  const tp = useThroughput(uplink?.device);
  const online = uplinkOnline(uplink, tp.query.data);
  const speed = useSpeedTest().status.data?.history[0];

  return (
    <Card
      class="lg:col-span-2"
      title="Internet"
      actions={
        ifaces.data && (
          <Pill tone={online ? 'ok' : 'bad'}>
            <Dot tone={online ? 'ok' : 'bad'} /> {online ? 'Online' : 'Offline'}
          </Pill>
        )
      }
    >
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Download"
          value={
            <span class="inline-flex items-center gap-1 text-accent">
              <IconArrowDown size={16} />
              {rate(tp.latest?.rx)}
            </span>
          }
        />
        <Stat
          label="Upload"
          value={
            <span class="inline-flex items-center gap-1 text-violet">
              <IconArrowUp size={16} />
              {rate(tp.latest?.tx)}
            </span>
          }
        />
        <Stat label="WAN IP" value={<span class="text-base">{uplink?.address ?? '—'}</span>} hint={uplink?.proto} />
        <Stat
          label="Uptime"
          value={<span class="text-base">{uplink?.uptime != null ? formatDuration(uplink.uptime) : '—'}</span>}
          hint={uplink?.gateway ? `via ${uplink.gateway}` : undefined}
        />
      </div>
      <div class="mt-4">
        <TimeSeriesChart data={tp.data} series={SERIES} height={170} formatValue={(v) => formatBitrate(v, 0)} />
        {tp.data[0].length < 2 && (
          <p class="-mt-24 mb-20 text-center text-xs text-muted">Collecting throughput… (updates every 3 s)</p>
        )}
      </div>
      {speed && (
        <Link href="/settings/internet" class="mt-2 block text-xs text-muted hover:text-accent">
          Speed test {relativeTime(speed.at * 1000, Date.now())}: {formatBitrate(speed.download / 8, 0)} down,{' '}
          {formatBitrate(speed.upload / 8, 0)} up, {Math.round(speed.ping)} ms
        </Link>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Gateway ports with live rates

function LivePort({ p }: { p: SwitchPort }) {
  // rx on a port is traffic from the device behind it.
  const r = useThroughput(p.name).latest;
  const total = r && r.rx != null && r.tx != null ? r.rx + r.tx : null;
  return (
    <PortTile
      p={p}
      title={`${p.name}: ${p.carrier ? `${p.speed ?? '?'} Mbps ${p.duplex ?? ''}` : 'no link'}${
        r ? ` · in ${rate(r.rx)}, out ${rate(r.tx)}` : ''
      }`}
    >
      {p.carrier && <span class="text-fg/70 tabular-nums">{compactRate(total)}</span>}
    </PortTile>
  );
}

function GatewayCard() {
  const { sw } = useSwitch();
  const ports = [...(sw?.ports ?? [])].sort((a, b) => (a.role === 'wan' ? -1 : b.role === 'wan' ? 1 : 0));
  const ifaces = useInterfaces();
  const lan = ifaces.data?.interface.find((i) => i.interface === 'lan')?.['ipv4-address']?.[0];

  return (
    <Card title="Ports" actions={<Link href="/topology" class="text-accent hover:underline">Topology</Link>}>
      {!sw ? (
        <Spinner />
      ) : (
        <div class="space-y-3">
          <div class="flex flex-wrap gap-1.5" aria-label="Ports">
            {ports.map((p) => (
              <LivePort key={p.name} p={p} />
            ))}
          </div>
          <p class="text-xs text-muted">
            {ports.filter((p) => p.carrier).length} of {ports.length} ports linked
            {lan && (
              <>
                {' '}
                · LAN {lan.address}/{lan.mask}
              </>
            )}
            . Live rate is in + out.
          </p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Clients, WiFi, networks

function ClientsAndWifi() {
  const { clients, subnets, wifi, wirelessError } = useClients();
  const exp = useMemo(() => averageExperience(clients), [clients]);
  const wireless_ = clients.filter((c) => c.wireless);
  const top = [...wireless_].sort((a, b) => b.wireless!.signal - a.wireless!.signal).slice(0, 5);
  const radios = useMemo(() => buildTopology({ wifi, clients }).radios, [wifi, clients]);

  return (
    <>
      <Card title="Clients" actions={<Link href="/clients" class="text-accent hover:underline">View all</Link>}>
        <div class="grid grid-cols-3 gap-4">
          <Stat label="Total" value={clients.length} />
          <Stat label="Wired" value={clients.length - wireless_.length} />
          <Stat label="WiFi" value={wireless_.length} />
        </div>
        {top.length > 0 && (
          <ul class="mt-4 divide-y divide-line">
            {top.map((c) => (
              <li key={c.mac}>
                <Link href={`/clients/${c.mac}`} class="flex h-9 items-center gap-2 hover:text-accent">
                  <SignalBars dbm={c.wireless!.signal} />
                  <span class="min-w-0 flex-1 truncate">{displayName(c)}</span>
                  <span class="text-xs text-muted">{c.wireless!.ssid}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="WiFi" actions={<Link href="/settings/wifi" class="text-accent hover:underline">Manage</Link>}>
        {wirelessError ? (
          <p class="text-muted">No wireless radios on this router.</p>
        ) : !wifi ? (
          <Spinner />
        ) : (
          <div class="space-y-3">
            <ul class="divide-y divide-line" aria-label="Radios">
              {radios.map((r) => (
                <li key={r.section} class="flex h-10 items-center gap-2.5">
                  <IconWifi size={16} class={r.enabled ? 'text-accent' : 'text-faint'} />
                  <span class="w-16 font-medium">{r.band}</span>
                  <span class="min-w-0 flex-1 truncate text-xs text-muted">
                    {r.enabled ? [r.channel && `Ch ${r.channel}`, r.width].filter(Boolean).join(' · ') : 'Disabled'}
                  </span>
                  <Pill>{r.clients.length}</Pill>
                </li>
              ))}
            </ul>
            {wifi.wlans.length === 0 ? (
              <p class="text-muted">No WiFi networks configured.</p>
            ) : (
              <div class="flex flex-wrap gap-1.5">
                {wifi.wlans.map((w) => (
                  <Pill key={w.id} tone={w.enabled ? 'accent' : 'neutral'}>
                    {w.ssid}
                  </Pill>
                ))}
              </div>
            )}
            {exp && (
              <div class="flex items-center justify-between border-t border-line pt-3">
                <span class="text-muted">WiFi experience</span>
                <Pill tone={exp.tone}>
                  {exp.score} · {exp.label}
                </Pill>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Networks" actions={<Link href="/settings/networks" class="text-accent hover:underline">Manage</Link>}>
        {subnets.length === 0 ? (
          <Spinner />
        ) : (
          <ul class="divide-y divide-line">
            {subnets.map((s) => (
              <li key={s.network} class="flex h-10 items-center gap-2.5">
                <span class="min-w-0 flex-1 truncate font-medium">{networkLabel(s.network)}</span>
                <span class="font-mono text-xs text-muted">
                  {s.address}/{s.prefix}
                </span>
                <Pill>{clients.filter((c) => c.network === s.network).length}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Recent events

const NOTEWORTHY: NetEvent['kind'][] = ['client-connected', 'client-disconnected', 'wrong-password', 'dhcp-refused'];

/** Recognized events worth a dashboard line: important ones, warnings, client comings and goings. */
export function recentEvents(events: NetEvent[], n = 6) {
  return collapseRepeats(
    events.filter((e) => !e.raw && (e.important || e.severity === 'warning' || e.severity === 'error' || NOTEWORTHY.includes(e.kind))),
  ).slice(0, n);
}

function RecentEvents() {
  const { events, skew, log } = useEvents();
  const rows = useMemo(() => recentEvents(events), [events]);
  const now = Date.now();
  return (
    <Card
      class="lg:col-span-2"
      title="Recent events"
      flush
      actions={<Link href="/logs" class="text-accent hover:underline">System Log</Link>}
    >
      {log.isPending ? (
        <div class="p-4">
          <Spinner />
        </div>
      ) : log.error ? (
        <Empty>Could not read the router's log.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No notable events in the router's log.</Empty>
      ) : (
        <ul class="divide-y divide-line" aria-label="Recent events">
          {rows.map(({ event, count }) => (
            <EventRow key={event.id} event={event} count={count} skew={skew} now={now} relative />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The most active clients: usage since netui was opened, from the connection table. */
function TopClients() {
  const { clients, traffic } = useClientDetails({ traffic: true });
  const top = useMemo(
    () => topClientsByUsage(clients, clientAddresses, traffic.hosts, 5),
    // traffic mutates in place; its version marks a new sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clients, traffic.version],
  );
  return (
    <Card title="Top clients" actions={<Link href="/insights" class="text-accent hover:underline">Insights</Link>}>
      {top.length === 0 ? (
        <Empty>Collecting usage from the connection table…</Empty>
      ) : (
        <ul class="divide-y divide-line" aria-label="Top clients">
          {top.map(({ client: c, total, rate: r }) => (
            <li key={c.mac}>
              <Link href={`/clients/${c.mac}`} class="flex h-9 items-center gap-2 hover:text-accent">
                <span class="min-w-0 flex-1 truncate">{displayName(c)}</span>
                <span class="text-xs text-muted">{formatBitrate(r, 0)}</span>
                <span class="w-20 text-right font-mono text-xs">{formatBytes(total)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DashboardPage() {
  const ifaces = useInterfaces();
  const board = useSystemBoard();
  return (
    <Page title="Dashboard">
      <LoadError error={firstError(ifaces, board)} />
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SetupBanner />
        <HealthStrip />
        <InternetCard />
        <GatewayCard />
        <ClientsAndWifi />
        <RecentEvents />
        <TopClients />
      </div>
    </Page>
  );
}
