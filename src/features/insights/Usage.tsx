import { useMemo, useState } from 'preact/hooks';
import { useDevices, useManagedDevices, useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { usePeriods, useUsage } from '../../api/usage';
import type { UciConfig } from '../../api/types';
import type { UciOp } from '../../api/uci';
import { displayName } from '../../model/clients';
import { useClients } from '../../model/hooks';
import { mergeHosts, normalizeUsage, periodLabel } from '../../model/usage';
import { formatBytes } from '../../lib/format';
import { Banner, Card, Empty, Meter, Spinner, Stat, ToggleRow } from '../../components/ui';
import { AddonMissing } from '../../components/InstallAddon';

/** Where nlbwmon keeps its database: RAM (the default) or flash. */
const RAM_DIR = '/var/lib/nlbwmon';
const FLASH_DIR = '/etc/nlbwmon';
const ROUTER = 'router';

function nlbwSection(cfg: UciConfig) {
  return Object.values(cfg).find((s) => s['.type'] === 'nlbwmon');
}

function keepOps(cfg: UciConfig, keep: boolean): UciOp[] {
  const s = nlbwSection(cfg);
  return s ? [{ op: 'set', config: 'nlbwmon', section: s['.name'], values: { database_directory: keep ? FLASH_DIR : RAM_DIR } }] : [];
}

function Rows({ rows }: { rows: { key: string; label: preact.ComponentChildren; rx: number; tx: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.rx + r.tx));
  return (
    <ul class="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div class="mb-1 flex items-baseline justify-between gap-3">
            <span class="min-w-0 truncate">{r.label}</span>
            <span class="shrink-0 text-xs text-muted tabular-nums">
              {formatBytes(r.rx)} down · {formatBytes(r.tx)} up
            </span>
          </div>
          <Meter value={(r.rx + r.tx) / max} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Usage history from nlbwmon: bytes per device and application for the
 * current accounting period (a month by default) and the stored earlier ones.
 */
export function UsageInsights() {
  const apply = useApply();
  const config = useUci('nlbwmon');
  const periods = usePeriods(!!config.data);
  const [period, setPeriod] = useState('');
  const usage = useUsage(period, !!config.data);
  const { clients } = useClients();
  const devices = useDevices(false);
  const aps = useManagedDevices(false);
  const data = useMemo(() => (usage.data ? normalizeUsage(usage.data) : undefined), [usage.data]);

  if (config.isPending) return <Spinner />;
  if (!config.data) {
    return (
      <Card title="Usage history">
        <AddonMissing addon="usage">Keep per-device and per-application usage by month.</AddonMissing>
      </Card>
    );
  }
  const own = new Set(Object.values(devices.data ?? {}).flatMap((d) => (d.macaddr ? [d.macaddr.toLowerCase()] : [])));
  const byMac = new Map(clients.map((c) => [c.mac.toLowerCase(), c]));
  const apName = new Map((aps.data ?? []).map((d) => [d.mac.toLowerCase(), d.name]));
  const hosts = data ? mergeHosts(data.hosts, own, ROUTER) : [];
  const dir = String(nlbwSection(config.data)?.database_directory ?? RAM_DIR);
  const kept = dir !== RAM_DIR && !dir.startsWith('/tmp/') && !dir.startsWith('/var/');

  return (
    <div class="space-y-4">
      <Card>
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div class="grid flex-1 grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Downloaded" value={data ? formatBytes(data.rx) : '—'} />
            <Stat label="Uploaded" value={data ? formatBytes(data.tx) : '—'} />
            <Stat label="Devices" value={data ? hosts.length : '—'} />
            <Stat label="Applications" value={data?.apps.length ?? '—'} />
          </div>
          <label class="text-xs text-muted">
            Period
            <select class="input mt-1 w-44" value={period} onChange={(e) => setPeriod(e.currentTarget.value)} aria-label="Period">
              <option value="">This period</option>
              {periods.data?.map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>
      {usage.error && (
        <Banner tone="bad" role="alert">
          Could not read the usage database: {usage.error.message}
        </Banner>
      )}
      {!data ? (
        !usage.error && <Spinner />
      ) : (
        <div class="grid gap-4 lg:grid-cols-2">
          <Card title="Top devices">
            {hosts.length === 0 ? (
              <Empty>No traffic counted in this period yet.</Empty>
            ) : (
              <Rows
                rows={hosts.slice(0, 15).map((h) => {
                  const c = byMac.get(h.mac);
                  return {
                    key: h.mac,
                    rx: h.rx,
                    tx: h.tx,
                    label: c ? (
                      <a class="text-accent hover:underline" href={`#/clients/${c.mac}`}>
                        {displayName(c)}
                      </a>
                    ) : h.mac === ROUTER || own.has(h.mac) ? (
                      'This router'
                    ) : apName.has(h.mac) ? (
                      apName.get(h.mac)
                    ) : (
                      <span class="font-mono text-xs">{h.mac}</span>
                    ),
                  };
                })}
              />
            )}
          </Card>
          <Card title="Top applications">
            {data.apps.length === 0 ? (
              <Empty>No traffic counted in this period yet.</Empty>
            ) : (
              <Rows rows={data.apps.slice(0, 15).map((a) => ({ key: a.name, label: a.name, rx: a.rx, tx: a.tx }))} />
            )}
          </Card>
        </div>
      )}
      <Card title="Settings">
        <ToggleRow
          label="Keep history across restarts"
          hint={
            kept
              ? `Stored in ${dir} on the router's flash, written about once a day.`
              : 'History is kept in memory and starts over when the router restarts. On flash it is written about once a day; history from before the switch is not carried over.'
          }
          checked={kept}
          disabled={apply.busy}
          onChange={(on) => void apply.start(keepOps(config.data!, on), { returnTo: '/insights' })}
        />
        <p class="text-xs text-muted">
          Applications are recognised by port (HTTPS, DNS, …). Traffic the router itself sends, like speed tests and updates,
          counts as "This router".
        </p>
      </Card>
    </div>
  );
}
