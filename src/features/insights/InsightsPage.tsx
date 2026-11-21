import { useMemo, useRef, useState } from 'preact/hooks';
import { useSurvey, useWifiScan, useWifiState, type WifiDeviceState } from '../../api/queries';
import type { IwinfoSurveyEntry } from '../../api/types';
import { formatBitrate, formatBytes, formatPercent } from '../../lib/format';
import { clientAddresses, displayName, type Client } from '../../model/clients';
import { useClientDetails } from '../../model/hooks';
import { channelLoad } from '../../model/radio';
import {
  bandSlots,
  blockStart,
  channelOccupancy,
  normalizeScan,
  recommendChannel,
  type ChannelSlot,
  type Neighbor,
} from '../../model/rf';
import { topBytes, traffic } from '../../model/traffic';
import { BAND_LABEL, frequencyBand, type Band } from '../../model/wifi';
import { IconRefresh, SignalBars } from '../../components/icons';
import { Banner, Button, Card, Empty, Meter, Page, Pill, Segmented, Spinner, Stat, Tabs, cx } from '../../components/ui';

import { UsageInsights } from './Usage';

type Tab = 'rf' | 'traffic' | 'usage';

export function InsightsPage() {
  const [tab, setTab] = useState<Tab>('rf');
  return (
    <Page title="Insights" subtitle="WiFi environment and where the traffic goes">
      <div class="-mx-5 mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'rf', label: 'WiFi Environment' },
            { value: 'traffic', label: 'Traffic' },
            { value: 'usage', label: 'Usage history' },
          ]}
        />
      </div>
      {tab === 'rf' ? <WifiEnvironment /> : tab === 'traffic' ? <TrafficInsights /> : <UsageInsights />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// WiFi environment

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** One AP interface per phy: scanning and survey are per radio. */
function radiosOf(devices: WifiDeviceState[]): (WifiDeviceState & { band: Band })[] {
  const seen = new Set<string>();
  return devices.flatMap((d) => {
    const band = frequencyBand(d.info?.frequency);
    if (!band || !d.info || (d.info.mode ?? 'Master') !== 'Master' || seen.has(d.info.phy)) return [];
    seen.add(d.info.phy);
    return [{ ...d, band }];
  });
}

function WifiEnvironment() {
  const live = useWifiState();
  const radios = radiosOf(live.devices);
  const scan = useWifiScan(radios.map((r) => r.ifname));
  const [band, setBand] = useState<Band | 'all'>('all');
  const own = new Set(live.devices.map((d) => d.info?.bssid?.toLowerCase()));
  const neighbors = scan.results
    .flatMap((r) => (r.data ? normalizeScan(r.data, r.ifname) : []))
    .filter((n) => !own.has(n.bssid))
    .sort((a, b) => b.signal - a.signal);
  const scanned = scan.results.filter((r) => r.at).map((r) => r.at);
  const failed = scan.results.find((r) => r.error);

  if (live.isPending) return <Spinner />;
  if (!radios.length) return <Empty>No WiFi radio is up. Enable a WiFi network to see its environment.</Empty>;

  return (
    <div class="space-y-4">
      <Banner
        tone="accent"
        actions={
          <Button variant="primary" disabled={scan.scanning} onClick={() => void scan.scan()}>
            {scan.scanning ? <Spinner /> : <IconRefresh size={14} />} {scan.scanning ? 'Scanning…' : 'Scan'}
          </Button>
        }
      >
        <div class="text-[13px]">
          {scanned.length ? `Last scanned ${ago(Math.min(...scanned))}.` : 'Not scanned yet.'}{' '}
          <span class="text-muted">
            A scan takes each radio off its channel for a few seconds; connected devices may notice a short pause.
          </span>
        </div>
      </Banner>
      {failed?.error && (
        <Banner tone="bad" role="alert">
          Scan on {failed.ifname} failed: {failed.error.message}
        </Banner>
      )}
      <div class="grid gap-4 lg:grid-cols-2">
        {radios.map((r) => (
          <RadioCard key={r.ifname} radio={r} neighbors={neighbors.filter((n) => n.band === r.band)} scanned={!!scan.results.find((s) => s.ifname === r.ifname)?.at} />
        ))}
      </div>
      <Card
        flush
        title={`Neighbouring networks${neighbors.length ? ` (${neighbors.length})` : ''}`}
        actions={
          <Segmented
            label="Band"
            value={band}
            onChange={setBand}
            options={[
              { value: 'all', label: 'All' },
              ...[...new Set(radios.map((r) => r.band))].map((b) => ({ value: b, label: BAND_LABEL[b] })),
            ]}
          />
        }
      >
        <NeighborTable neighbors={neighbors.filter((n) => band === 'all' || n.band === band)} />
      </Card>
    </div>
  );
}

function RadioCard({ radio, neighbors, scanned }: { radio: WifiDeviceState & { band: Band }; neighbors: Neighbor[]; scanned: boolean }) {
  const survey = useSurvey(radio.ifname);
  const prev = useRef<{ at: number; data?: IwinfoSurveyEntry[]; last?: IwinfoSurveyEntry[] }>({ at: 0 });
  // Keep the poll before the current one to measure the interval between them.
  if (survey.data && survey.dataUpdatedAt !== prev.current.at) {
    prev.current = { at: survey.dataUpdatedAt, data: prev.current.last, last: survey.data };
  }
  const info = radio.info!;
  const load = channelLoad(survey.data, info.frequency, prev.current.data);
  const slots = useMemo(() => channelOccupancy(neighbors, bandSlots(radio.band, survey.data)), [neighbors, radio.band, survey.data]);
  const width = Number(/\d+$/.exec(info.htmode ?? '')?.[0] ?? 20);
  const rec = scanned && info.channel ? recommendChannel(radio.band, info.channel, width, slots, survey.data) : undefined;

  return (
    <Card title={`${BAND_LABEL[radio.band]} · ${info.ssid ?? radio.ifname}`} actions={<span class="text-muted">{radio.ifname}</span>}>
      <div class="grid grid-cols-3 gap-4">
        <Stat label="Channel" value={info.channel ?? '—'} hint={[info.htmode, info.frequency && `${info.frequency} MHz`].filter(Boolean).join(' · ')} />
        <div class="min-w-0">
          <div class="text-xs text-muted">Utilisation</div>
          <div class="text-xl font-semibold tabular-nums">{load ? formatPercent(load.busy) : '—'}</div>
          {load && <Meter value={load.busy} tone={load.busy > 0.6 ? 'bad' : load.busy > 0.3 ? 'warn' : 'ok'} />}
          {load?.tx !== undefined && <div class="mt-1 text-xs text-muted">{formatPercent(load.tx)} our own transmit</div>}
        </div>
        <Stat label="Noise floor" value={load?.noise !== undefined ? `${load.noise} dBm` : '—'} hint={scanned ? `${neighbors.length} networks nearby` : undefined} />
      </div>
      <OccupancyChart slots={slots} current={info.channel} width={width} band={radio.band} empty={!scanned} />
      {rec && (
        <p class="mt-3 text-xs" role="status">
          <Pill tone="warn">Suggestion</Pill> Consider channel {rec.channel}. {rec.reason}{' '}
          <a class="text-accent hover:underline" href="#/settings/wifi">
            WiFi settings
          </a>
        </p>
      )}
    </Card>
  );
}

/** Networks per 20 MHz channel, weighted by signal; the channels we use are highlighted. */
function OccupancyChart({ slots, current, width, band, empty }: { slots: ChannelSlot[]; current?: number; width: number; band: Band; empty: boolean }) {
  const max = Math.max(1, ...slots.map((s) => s.load));
  const curSlot = slots.find((s) => s.channel === current);
  const ours = (s: ChannelSlot) =>
    curSlot && (band === '2g' ? s.channel === current : blockStart(s.channel, width) === blockStart(current!, width));
  return (
    <div class="mt-4">
      <div class="flex h-24 items-end gap-px" role="img" aria-label="Channel occupancy">
        {slots.map((s) => (
          <div key={s.channel} class="flex h-full min-w-0 flex-1 flex-col justify-end" title={`Channel ${s.channel}: ${s.count} network${s.count === 1 ? '' : 's'}`}>
            <div
              class={cx('rounded-t-sm', ours(s) ? 'bg-accent' : 'bg-line-strong')}
              style={{ height: `${empty ? 2 : Math.max(2, (s.load / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div class="mt-1 flex gap-px text-[10px] text-muted tabular-nums">
        {slots.map((s) => (
          <div key={s.channel} class="min-w-0 flex-1 text-center">
            {s.channel}
          </div>
        ))}
      </div>
      {empty && <p class="mt-1 text-xs text-muted">Scan to see how busy each channel is.</p>}
    </div>
  );
}

function NeighborTable({ neighbors }: { neighbors: Neighbor[] }) {
  if (!neighbors.length) return <Empty>No scan results yet.</Empty>;
  return (
    <div class="overflow-x-auto">
      <table class="table">
        <thead>
          <tr>
            <th>Network</th>
            <th>BSSID</th>
            <th>Band</th>
            <th>Channel</th>
            <th>Width</th>
            <th>Signal</th>
            <th>Security</th>
          </tr>
        </thead>
        <tbody>
          {neighbors.map((n) => (
            <tr key={n.bssid + n.radio}>
              <td class="max-w-[240px] truncate">
                {n.ssid ?? <span class="text-faint italic">Hidden</span>}
                {n.mesh && (
                  <span class="ml-2">
                    <Pill>Mesh</Pill>
                  </span>
                )}
              </td>
              <td class="font-mono text-xs text-muted">{n.bssid}</td>
              <td>{BAND_LABEL[n.band]}</td>
              <td class="tabular-nums">{n.channel}</td>
              <td class="tabular-nums">{n.width} MHz</td>
              <td>
                <span class="inline-flex items-center gap-1.5">
                  <SignalBars dbm={n.signal} />
                  <span class="text-xs text-muted tabular-nums">{n.signal} dBm</span>
                </span>
              </td>
              <td class={n.security === 'Open' ? 'text-warn' : ''}>{n.security}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic

interface Usage {
  key: string;
  label: string;
  client?: Client;
  total: number;
  rate: number;
}

/** Per-host traffic grouped by client (a client may have IPv4 and IPv6 addresses). */
function usageByClient(clients: Client[]): Usage[] {
  const byIp = new Map<string, Client>();
  for (const c of clients) for (const ip of clientAddresses(c)) byIp.set(ip, c);
  const out = new Map<string, Usage>();
  for (const h of traffic.hosts.values()) {
    const c = byIp.get(h.ip);
    const key = c?.mac ?? h.ip;
    const u = out.get(key) ?? { key, label: c ? displayName(c) : h.ip, client: c, total: 0, rate: 0 };
    u.total += h.total;
    u.rate += h.rate ?? 0;
    out.set(key, u);
  }
  return [...out.values()].sort((a, b) => b.total - a.total || b.rate - a.rate);
}

function Bars({ rows, empty }: { rows: { key: string; label: preact.ComponentChildren; value: number; hint?: string }[]; empty: string }) {
  if (!rows.length || rows.every((r) => !r.value)) return <Empty>{empty}</Empty>;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <ul class="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div class="mb-1 flex items-baseline justify-between gap-3">
            <span class="min-w-0 truncate">{r.label}</span>
            <span class="shrink-0 text-xs text-muted tabular-nums">
              {r.hint && <span class="mr-2">{r.hint}</span>}
              {formatBytes(r.value)}
            </span>
          </div>
          <Meter value={r.value / max} />
        </li>
      ))}
    </ul>
  );
}

function TrafficInsights() {
  const { clients, subnets, conntrack } = useClientDetails();
  const usage = usageByClient(clients);
  const router = new Set(subnets.map((s) => s.gateway));
  const total = usage.reduce((a, u) => a + u.total, 0);
  const rate = usage.reduce((a, u) => a + u.rate, 0);

  if (conntrack.error) {
    return (
      <Banner tone="bad" role="alert">
        Could not read the connection table: {conntrack.error.message}
      </Banner>
    );
  }
  if (!conntrack.data) return <Spinner />;
  const { partial, total: tracked, entries } = conntrack.data;

  return (
    <div class="space-y-4">
      {partial && (
        <Banner tone="warn">
          The router tracks {tracked.toLocaleString()} connections, more than it can list quickly. netui reads the
          first {entries.length.toLocaleString()} each time so the router stays responsive; traffic on the others is
          not counted.
        </Banner>
      )}
      <Card>
        <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat
            label="Active connections"
            value={partial ? tracked : traffic.active}
            hint={partial ? `${entries.length.toLocaleString()} read` : undefined}
          />
          <Stat label="Active clients" value={usage.filter((u) => u.rate > 0).length} />
          <Stat label="Current throughput" value={formatBitrate(rate)} hint="Both directions" />
          <Stat label="Since opened" value={formatBytes(total)} />
        </div>
      </Card>
      <div class="grid gap-4 lg:grid-cols-3">
        <Card title="Top clients">
          <Bars
            empty="Collecting… numbers appear after the second poll."
            rows={usage.slice(0, 10).map((u) => ({
              key: u.key,
              value: u.total,
              hint: u.rate ? formatBitrate(u.rate, 0) : undefined,
              label: u.client ? (
                <a class="text-accent hover:underline" href={`#/clients/${u.client.mac}`}>
                  {u.label}
                </a>
              ) : (
                <span class="font-mono text-xs">{u.label}</span>
              ),
            }))}
          />
        </Card>
        <Card title="Top services">
          <Bars empty="No traffic yet." rows={topBytes(traffic.services, 10).map(([k, v]) => ({ key: k, label: k, value: v }))} />
        </Card>
        <Card title="Top destinations">
          <Bars
            empty="No traffic yet."
            rows={topBytes(traffic.remotes, 10).map(([k, v]) => ({
              key: k,
              value: v,
              label: router.has(k) ? 'This router' : <span class="font-mono text-xs">{k}</span>,
            }))}
          />
        </Card>
      </div>
      <p class="text-xs text-muted">
        From the router's connection table, polled every 5 seconds while this page is open; totals count from when netui was
        opened. Download and upload are not separated. Port-forwarded connections, and flows accelerated in hardware, may be
        missing or under-counted.
      </p>
    </div>
  );
}
