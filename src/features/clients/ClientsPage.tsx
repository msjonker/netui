import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { useLocation, useParams } from 'wouter-preact';
import { reconnectClient, stationRate, useInterfaces, useUci, wakeClient } from '../../api/queries';
import { useUsage } from '../../api/usage';
import { AddonMissingError } from '../../api/packages';
import { AddonMissing } from '../../components/InstallAddon';
import { normalizeUsage } from '../../model/usage';
import { useApply } from '../../api/useApply';
import {
  clientAddresses,
  clientKind,
  clientSettings,
  clientSettingsOps,
  displayName,
  isOffline,
  matchesFilter,
  validateClientSettings,
  type Client,
  type ClientFilter,
} from '../../model/clients';
import { clientExperience } from '../../model/experience';
import { blockOps, unblockOps } from '../../model/firewall';
import { useClientDetails } from '../../model/hooks';
import { networkLabel, type Subnet } from '../../model/network';
import { traffic } from '../../model/traffic';
import type { UciConfig } from '../../api/types';
import { formatBitrate, formatBytes, formatDuration } from '../../lib/format';
import { normalizeMac } from '../../lib/mac';
import { vendorLabel, type DeviceKind } from '../../lib/oui';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { TimeSeriesChart } from '../../components/TimeSeriesChart';
import {
  IconBlock,
  IconCamera,
  IconChip,
  IconEthernet,
  IconGamepad,
  IconLaptop,
  IconPhone,
  IconPrinter,
  IconRouter,
  IconSearch,
  IconServer,
  IconSpeaker,
  IconTv,
  IconWifi,
  SignalBars,
} from '../../components/icons';
import {
  Banner,
  Button,
  Card,
  Detail,
  Dot,
  Empty,
  Field,
  FormSection,
  LoadError,
  Page,
  Pill,
  Segmented,
  Spinner,
  Tabs,
  ToggleRow,
} from '../../components/ui';
import { ConnectionsTable } from './ConnectionsTable';

const path = (c: Client) => `/clients/${c.mac}`;

function lease(c: Client): string | undefined {
  if (c.leaseExpires === false) return 'Static';
  if (c.leaseExpires === undefined) return undefined;
  return c.leaseExpires > 0 ? `${formatDuration(c.leaseExpires)} left` : 'Expired';
}

function connection(c: Client): string {
  if (c.block?.enabled) return 'Blocked';
  const w = c.wireless;
  if (w) return [w.ssid ?? w.ifname, w.band, w.channel && `Ch ${w.channel}`, w.ap?.name].filter(Boolean).join(' · ');
  return isOffline(c) ? 'Offline' : 'Wired';
}

const KIND_ICON: Record<DeviceKind, (p: { size?: number; class?: string }) => preact.JSX.Element> = {
  phone: IconPhone,
  computer: IconLaptop,
  tv: IconTv,
  console: IconGamepad,
  speaker: IconSpeaker,
  iot: IconChip,
  camera: IconCamera,
  printer: IconPrinter,
  network: IconRouter,
  nas: IconServer,
};

function ClientIcon({ c, size = 16 }: { c: Client; size?: number }) {
  if (c.block?.enabled) return <IconBlock size={size} class="text-bad" />;
  const kind = clientKind(c);
  const Icon = kind ? KIND_ICON[kind] : c.wireless ? IconWifi : IconEthernet;
  return <Icon size={size} class={c.wireless ? 'text-accent' : isOffline(c) ? 'text-faint' : 'text-muted'} />;
}

const experienceOf = clientExperience;

function Experience({ c }: { c: Client }) {
  const e = experienceOf(c);
  if (!e) return <span class="text-faint">—</span>;
  return (
    <span class="inline-flex items-center gap-1.5 tabular-nums" title={[e.label, ...e.reasons].join('\n')}>
      <Dot tone={e.tone} /> {e.score}%
    </span>
  );
}

const rate = (r: number | null | undefined) => formatBitrate(r ?? 0, r && r < 125_000 ? 0 : 1);

/** WiFi: down/up from the station counters. Wired: both directions from the connection table. */
function Activity({ c }: { c: Client }) {
  const st = c.wireless && stationRate(c.mac);
  if (st && (st.down != null || st.up != null)) {
    return (
      <span class="tabular-nums">
        <span class="text-accent">↓</span> {rate(st.down)} <span class="ml-1 text-violet">↑</span> {rate(st.up)}
      </span>
    );
  }
  const t = traffic.host(clientAddresses(c));
  if (t?.rate == null) return <span class="text-faint">—</span>;
  return (
    <span class="tabular-nums" title="Download and upload combined">
      <span class="text-accent">⇅</span> {rate(t.rate)}
    </span>
  );
}

function usage(c: Client): string | undefined {
  const t = traffic.host(clientAddresses(c));
  return t ? formatBytes(t.total) : undefined;
}

function ClientRow({ c, selected, onSelect }: { c: Client; selected: boolean; onSelect: () => void }) {
  const vendor = vendorLabel(c.mac);
  return (
    <tr data-clickable aria-selected={selected} onClick={onSelect}>
      <td>
        <span class="flex items-center gap-2.5">
          <ClientIcon c={c} />
          <span class={`max-w-[220px] truncate font-medium ${isOffline(c) ? 'text-muted' : ''}`}>{displayName(c)}</span>
          {c.reservation?.ip && <Pill>Fixed IP</Pill>}
        </span>
      </td>
      <td class={c.randomMac ? 'text-faint' : 'text-muted'}>{vendor ?? '—'}</td>
      <td class="text-muted">{connection(c)}</td>
      <td>{c.network ? networkLabel(c.network) : <span class="text-faint">—</span>}</td>
      <td class="font-mono text-xs">{c.ip ?? <span class="text-faint">—</span>}</td>
      <td class="font-mono text-xs text-muted">{c.mac}</td>
      <td class="text-xs">
        <Experience c={c} />
      </td>
      <td class="text-xs">
        <Activity c={c} />
      </td>
      <td class="text-xs text-muted tabular-nums">{usage(c) ?? '—'}</td>
      <td class="text-xs text-muted">{c.wireless?.connectedTime != null ? formatDuration(c.wireless.connectedTime) : '—'}</td>
      <td class="text-xs text-muted">{lease(c) ?? '—'}</td>
    </tr>
  );
}

function TrafficChart({ c }: { c: Client }) {
  const t = traffic.host(clientAddresses(c));
  const data = useMemo(
    (): [number[], (number | null)[]] => [t?.points.map((p) => p.t) ?? [], t?.points.map((p) => p.v) ?? []],
    // traffic.version changes once per poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c.mac, traffic.version],
  );
  return (
    <div>
      <div class="mb-1 flex items-baseline justify-between text-xs text-muted">
        <span>Traffic (both directions)</span>
        <span class="tabular-nums">{t ? `${rate(t.rate)} · ${formatBytes(t.total)} total` : 'No connections seen yet'}</span>
      </div>
      <TimeSeriesChart data={data} height={110} series={[{ label: 'Traffic', color: '--accent' }]} formatValue={(v) => formatBitrate(v, 0)} />
    </div>
  );
}

function Reconnect({ c }: { c: Client }) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  const w = c.wireless!;
  const run = async () => {
    setState({ busy: true });
    try {
      await reconnectClient(w.ifname, c.mac, w.ap?.mac);
      setState({ done: true });
      setConfirming(false);
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return (
    <div class="flex items-center justify-between gap-4 py-2.5">
      <p class="text-muted">
        {state.done ? 'Disconnected. The device should rejoin within a few seconds.' : 'Disconnect the device so it joins again.'}
      </p>
      <Button onClick={() => setConfirming(true)}>Reconnect</Button>
      {confirming && (
        <Modal
          title={`Reconnect ${displayName(c)}?`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" disabled={state.busy} onClick={run}>
                Reconnect
              </Button>
            </>
          }
        >
          <p>
            The device is disconnected from {w.ssid ?? w.ifname} and normally reconnects on its own within a few seconds. Its
            open connections may drop.
          </p>
          {state.error && (
            <p class="mt-2 text-xs text-bad" role="alert">
              {state.error}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

/** Wake-on-LAN, for a device that is not on WiFi right now (most wake only over a cable). */
function Wake({ c }: { c: Client }) {
  const ifaces = useInterfaces(false);
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string; missing?: boolean }>({});
  const live = ifaces.data?.interface.find((i) => i.interface === (c.network ?? 'lan'));
  const device = live?.l3_device ?? live?.device;
  const run = async () => {
    setState({ busy: true });
    try {
      await wakeClient(device!, c.mac);
      setState({ done: true });
    } catch (e) {
      setState({ error: (e as Error).message, missing: e instanceof AddonMissingError });
    }
  };
  if (state.missing) {
    return (
      <div class="py-2.5">
        <AddonMissing addon="wol">{state.error}</AddonMissing>
      </div>
    );
  }
  return (
    <div class="flex items-center justify-between gap-4 py-2.5">
      <p class={state.error ? 'text-bad' : 'text-muted'} role={state.error ? 'alert' : undefined}>
        {state.error ?? (state.done ? 'Wake-up sent. A sleeping device takes a moment to come online.' : 'Turn on a sleeping or switched-off device that supports Wake-on-LAN.')}
      </p>
      <Button onClick={run} disabled={!device || state.busy}>
        Wake
      </Button>
    </div>
  );
}

/** This period's bytes for one client from nlbwmon, when it is installed. */
function usePeriodUsage(mac: string): string | undefined {
  const installed = !!useUci('nlbwmon').data;
  const usage = useUsage('', installed);
  const host = useMemo(() => (usage.data ? normalizeUsage(usage.data) : undefined), [usage.data])?.hosts.find(
    (h) => h.mac === mac.toLowerCase(),
  );
  if (!installed || !usage.data) return undefined;
  return host ? `↓ ${formatBytes(host.rx)} / ↑ ${formatBytes(host.tx)}` : 'None counted';
}

function Overview({ c }: { c: Client }) {
  const w = c.wireless;
  const period = usePeriodUsage(c.mac);
  const e = experienceOf(c);
  const vendor = vendorLabel(c.mac);
  return (
    <div class="px-5 py-3">
      <Detail
        rows={[
          [
            'Status',
            c.block?.enabled ? (
              <Pill tone="bad">Blocked</Pill>
            ) : w ? (
              <Pill tone="ok">Connected</Pill>
            ) : isOffline(c) ? (
              <Pill>Offline</Pill>
            ) : (
              <Pill tone="ok">Wired</Pill>
            ),
          ],
          ['Vendor', vendor],
          ['Connection', connection(c)],
          ['Network', c.network && networkLabel(c.network)],
          ['IP address', c.ip && <span class="font-mono text-xs">{c.ip}</span>],
          ...(c.otherAddresses ?? []).map((o): [string, ComponentChildren] => [
            `Also on ${o.network ? networkLabel(o.network) : 'another network'}`,
            <span class="font-mono text-xs">{o.ip}</span>,
          ]),
          ...(c.ip6 ?? []).map((ip): [string, ComponentChildren] => ['IPv6 address', <span class="font-mono text-xs">{ip}</span>]),
          [
            'MAC address',
            <span class="inline-flex items-center gap-2">
              {c.randomMac && <Pill tone="accent">Private</Pill>}
              <span class="font-mono text-xs">{c.mac}</span>
            </span>,
          ],
          ['DHCP lease', lease(c)],
          ['Activity', <Activity c={c} />],
          ...(period ? ([['Usage this period', period]] as [string, ComponentChildren][]) : []),
          ...(w
            ? ([
                [
                  'WiFi experience',
                  e && (
                    <span class="inline-flex items-center gap-1.5">
                      <Dot tone={e.tone} /> {e.score}% · {e.label}
                    </span>
                  ),
                ],
                [
                  'Signal',
                  <span class="inline-flex items-center gap-1.5">
                    <SignalBars dbm={w.signal} /> {w.signal} dBm
                  </span>,
                ],
                ['Link rate', `↓ ${w.txRate.toFixed(0)} / ↑ ${w.rxRate.toFixed(0)} Mbps`],
                ['Channel', w.channel && `${w.channel}${w.htmode ? ` · ${w.htmode}` : ''}`],
                ['Access point', w.ap ? w.ap.name : 'This router'],
                ['Connected for', w.connectedTime != null ? formatDuration(w.connectedTime) : undefined],
                [
                  'Data this session',
                  w.rxBytes != null && w.txBytes != null
                    ? `↓ ${formatBytes(w.txBytes)} / ↑ ${formatBytes(w.rxBytes)}`
                    : undefined,
                ],
              ] as [string, ComponentChildren][])
            : []),
        ]}
      />
      {e && e.reasons.length > 0 && (
        <ul class="mt-2 space-y-0.5 text-xs text-muted">
          {e.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div class="mt-4">
        <TrafficChart c={c} />
      </div>
      <FormSection title="Actions">{w ? <Reconnect c={c} /> : <Wake c={c} />}</FormSection>
      {c.randomMac && (
        <p class="mt-3 text-xs text-muted">
          This device uses a private (randomized) MAC address. Settings tied to it stop applying if the device rotates its
          address.
        </p>
      )}
    </div>
  );
}

function Settings({ c, subnets, dhcp, fw }: { c: Client; subnets: Subnet[]; dhcp: UciConfig; fw?: UciConfig }) {
  const apply = useApply();
  const source = useMemo(() => clientSettings(c), [c]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  if (!draft) return null;
  const error = validateClientSettings(draft, c, subnets, dhcp);
  const name = displayName(c);
  const block = c.block;
  const unblock = block && fw ? unblockOps(c.mac, block, fw) : null;

  return (
    <div class="px-5">
      <FormSection title="Client settings">
        <Field label="Alias" stacked hint="Shown here and used as the device's DNS name.">
          {(id) => (
            <input
              id={id}
              class="input"
              placeholder={c.name && c.name !== c.reservation?.name ? c.name : 'e.g. living-room-tv'}
              value={draft.alias}
              onInput={(e) => update({ alias: e.currentTarget.value.trim() })}
            />
          )}
        </Field>
        <ToggleRow
          label="Fixed IP address"
          hint="Always hand out the same address to this device."
          checked={draft.fixedIp}
          onChange={(fixedIp) => update({ fixedIp })}
        />
        {draft.fixedIp && (
          <Field label="IP address" stacked>
            {(id) => (
              <input
                id={id}
                class="input font-mono"
                value={draft.ip}
                onInput={(e) => update({ ip: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
        )}
        {stale && (
          <div class="my-2">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This client's settings changed on the router.
            </Banner>
          </div>
        )}
        {dirty && error && (
          <p class="py-1 text-xs text-bad" role="alert">
            {error}
          </p>
        )}
        <div class="flex justify-end gap-2 py-3">
          <Button onClick={reset} disabled={!dirty || apply.busy}>
            Reset
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !!error || apply.busy}
            onClick={() => apply.start(clientSettingsOps(draft, c, dhcp), { returnTo: path(c) })}
          >
            Apply Changes
          </Button>
        </div>
        {draft.fixedIp && dirty && (
          <p class="pb-3 text-xs text-muted">The device picks up a new address when it next renews its lease or reconnects.</p>
        )}
      </FormSection>

      <FormSection title="Access">
        {block?.enabled ? (
          <div class="space-y-3 py-2.5">
            <p class="text-muted">
              Blocked by firewall rule <span class="text-fg">"{block.name || block.section}"</span>. The device can still join
              the network but cannot reach the internet or other networks.
            </p>
            {unblock ? (
              <Button disabled={apply.busy} onClick={() => apply.start(unblock, { returnTo: path(c) })}>
                Unblock
              </Button>
            ) : (
              <a class="text-accent hover:underline" href="/cgi-bin/luci/admin/network/firewall/rules" target="_blank" rel="noreferrer">
                This rule was not created by netui. Manage it in LuCI.
              </a>
            )}
          </div>
        ) : (
          <div class="flex items-center justify-between gap-4 py-2.5">
            <p class="text-muted">Stop this device from reaching the internet and other networks.</p>
            <Button
              variant="danger"
              disabled={apply.busy}
              onClick={() => apply.start(blockOps(c.mac, name, block), { returnTo: path(c) })}
            >
              <IconBlock size={14} /> Block
            </Button>
          </div>
        )}
      </FormSection>
    </div>
  );
}

type DrawerTab = 'overview' | 'connections' | 'settings';

function ClientDrawer({
  c,
  subnets,
  dhcp,
  fw,
  onClose,
}: {
  c: Client;
  subnets: Subnet[];
  dhcp?: UciConfig;
  fw?: UciConfig;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('overview');
  return (
    <Drawer
      title={displayName(c)}
      subtitle={[c.ip, c.mac].filter(Boolean).join(' · ')}
      icon={<ClientIcon c={c} size={20} />}
      onClose={onClose}
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'connections', label: 'Connections' },
          { value: 'settings', label: 'Settings' },
        ]}
      />
      {tab === 'overview' ? (
        <Overview c={c} />
      ) : tab === 'connections' ? (
        <ConnectionsTable ips={clientAddresses(c)} />
      ) : dhcp ? (
        <Settings key={c.mac} c={c} subnets={subnets} dhcp={dhcp} fw={fw} />
      ) : (
        <Spinner class="m-5" />
      )}
    </Drawer>
  );
}

const FILTERS: [ClientFilter, string][] = [
  ['all', 'All'],
  ['wired', 'Wired'],
  ['wireless', 'WiFi'],
  ['offline', 'Offline'],
  ['blocked', 'Blocked'],
];

export function ClientsPage() {
  const { clients, subnets, dhcp, firewall, isPending, error } = useClientDetails();
  const [filter, setFilter] = useState<ClientFilter>('all');
  const [query, setQuery] = useState('');
  const params = useParams<{ mac?: string }>();
  const [, navigate] = useLocation();
  const selected = params.mac ? normalizeMac(decodeURIComponent(params.mac)) : null;

  const q = query.trim().toLowerCase();
  const visible = clients.filter(
    (c) =>
      matchesFilter(c, filter) &&
      (!q || [c.name, c.ip, c.mac, c.wireless?.ssid, vendorLabel(c.mac)].some((v) => v?.toLowerCase().includes(q))),
  );
  const count = (f: ClientFilter) => clients.filter((c) => matchesFilter(c, f)).length;
  const current = selected ? clients.find((c) => c.mac === selected) : undefined;
  const online = clients.length - count('offline');

  return (
    <Page title="Client Devices" subtitle={`${online} online · ${clients.length} known`}>
      <LoadError error={error} />
      {params.mac && !current && !isPending && (
        <div class="mb-3">
          <Banner tone="warn" role="status" actions={<Button onClick={() => navigate('/clients')}>Dismiss</Button>}>
            No known client has the MAC address {params.mac}.
          </Banner>
        </div>
      )}
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <Segmented
          label="Filter clients"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map(([f, label]) => ({
            value: f,
            label: (
              <>
                {label} <span class="text-faint tabular-nums">{count(f)}</span>
              </>
            ),
          }))}
        />
        <label class="relative ml-auto w-full max-w-xs">
          <IconSearch size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input
            type="search"
            aria-label="Search clients"
            placeholder="Search name, IP, MAC or vendor"
            class="input pl-8"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      </div>
      <Card flush>
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Vendor</th>
                <th>Connection</th>
                <th>Network</th>
                <th>IP Address</th>
                <th>MAC Address</th>
                <th>Experience</th>
                <th>Activity</th>
                <th>Usage</th>
                <th>Uptime</th>
                <th>Lease</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <ClientRow
                  key={c.mac}
                  c={c}
                  selected={c.mac === selected}
                  onSelect={() => navigate(c.mac === selected ? '/clients' : path(c))}
                />
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 &&
          (isPending ? (
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <Empty>{q || filter !== 'all' ? 'No clients match.' : 'No clients yet.'}</Empty>
          ))}
      </Card>
      <p class="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <Dot tone="neutral" /> Wired means "not associated to this router's WiFi right now". Clients behind another switch or
        AP show as wired. Usage counts from when this page was first opened, from the router's connection table.
      </p>
      {current && (
        <ClientDrawer c={current} subnets={subnets} dhcp={dhcp.data} fw={firewall.data} onClose={() => navigate('/clients')} />
      )}
    </Page>
  );
}
