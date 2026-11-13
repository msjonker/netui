import { useMemo, useState } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { firstError, useInterfaces, useUci } from '../../api/queries';
import { sectionsOfType, type UciOp } from '../../api/uci';
import { useApply } from '../../api/useApply';
import {
  dnsRecordOps,
  dnsSettingsOps,
  normalizeDnsRecords,
  normalizeDnsSettings,
  splitList,
  validateDnsRecord,
  validateDnsSettings,
  type DnsRecord,
  type DnsSettings,
} from '../../model/dns';
import { networkLabel } from '../../model/network';
import {
  activeRoutes,
  gatewayOnLink,
  newStaticRoute,
  normalizeStaticRoutes,
  staticRouteOps,
  validateStaticRoute,
  type StaticRoute,
} from '../../model/routing';
import { useDraft } from '../../lib/useDraft';
import type { ComponentChildren } from 'preact';
import { Drawer } from '../../components/overlay';
import { IconPlus, IconRoute, IconGlobe, IconTrash } from '../../components/icons';
import {
  Banner,
  Button,
  Card,
  Dot,
  Empty,
  Field,
  FormSection,
  LoadError,
  Page,
  Pill,
  Segmented,
  Spinner,
  ToggleRow,
} from '../../components/ui';

const PLAN = { returnTo: '/settings/routing' };

/** A create/edit drawer. Removal needs no extra prompt: the apply review is the confirmation. */
function EditDrawer({
  title,
  subtitle,
  icon,
  isNew,
  dirty,
  stale,
  valid,
  reset,
  onClose,
  onSubmit,
  onRemove,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ComponentChildren;
  isNew: boolean;
  dirty: boolean;
  stale: boolean;
  valid: boolean;
  reset: () => void;
  onClose: () => void;
  onSubmit: () => void;
  onRemove: () => void;
  children: ComponentChildren;
}) {
  const apply = useApply();
  return (
    <Drawer
      title={title}
      subtitle={subtitle}
      icon={icon}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" class="mr-auto" onClick={onRemove} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={onSubmit} disabled={apply.busy || (!isNew && (!dirty || !valid))}>
            {isNew ? 'Add' : 'Apply Changes'}
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        {children}
      </div>
    </Drawer>
  );
}

/** A card holding a table, with loading and empty states. */
function TableCard({
  title,
  rows,
  empty,
  onCreate,
  children,
}: {
  title: string;
  rows: unknown[] | undefined;
  empty: string;
  onCreate?: () => void;
  children: ComponentChildren;
}) {
  return (
    <Card
      title={title}
      flush
      actions={
        onCreate && (
          <Button variant="primary" onClick={onCreate} disabled={!rows}>
            <IconPlus size={14} /> Create New
          </Button>
        )
      }
    >
      {!rows ? (
        <div class="flex justify-center py-10">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div class="overflow-x-auto">{children}</div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Static routes

function RouteForm({
  route,
  routes,
  interfaces,
  network,
  onClose,
}: {
  route?: StaticRoute;
  routes: StaticRoute[];
  interfaces: string[];
  network: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const ifaces = useInterfaces();
  const source = useMemo(
    () => route ?? newStaticRoute(interfaces.includes('lan') ? 'lan' : interfaces[0]),
    [route, interfaces],
  );
  const { draft, dirty, stale, reset, update } = useDraft(source);
  const [touched, setTouched] = useState(false);
  if (!draft) return null;
  const errors = validateStaticRoute(draft, { interfaces, routes });
  const valid = Object.keys(errors).length === 0;
  const show = (k: keyof StaticRoute) => (touched || route ? errors[k] : undefined);
  const onLink =
    draft.gateway && !errors.gateway ? gatewayOnLink(draft.gateway, draft.interface, ifaces.data) : undefined;

  const submit = () => {
    setTouched(true);
    if (valid) void apply.start(staticRouteOps(draft, network), { ...PLAN, disruptive: true, onConfirmed: onClose });
  };

  return (
    <EditDrawer
      title={route ? route.name || route.target : 'Create Static Route'}
      subtitle={route ? `${route.target}${route.gateway ? ` via ${route.gateway}` : ''}` : undefined}
      icon={<IconRoute size={20} />}
      isNew={!route}
      {...{ dirty, stale, valid, reset, onClose }}
      onSubmit={submit}
      onRemove={() => void apply.start([{ op: 'delete', config: 'network', section: route!.section! }], PLAN)}
    >
      <FormSection title="Route">
        <Field label="Name" stacked error={show('name')} hint="Optional, for your reference.">
          {(id) => (
            <input id={id} class="input" value={draft.name} onInput={(e) => update({ name: e.currentTarget.value })} />
          )}
        </Field>
        <ToggleRow label="Enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
        <Field
          label="Destination network"
          stacked
          error={show('target')}
          hint="In CIDR form, e.g. 10.20.0.0/16. 0.0.0.0/0 is the default route."
        >
          {(id) => (
            <input
              id={id}
              class="input font-mono"
              placeholder="10.20.0.0/16"
              value={draft.target}
              onInput={(e) => update({ target: e.currentTarget.value.trim() })}
            />
          )}
        </Field>
        <Field label="Interface" stacked error={show('interface')}>
          {(id) => (
            <select
              id={id}
              class="input"
              value={draft.interface}
              onChange={(e) => update({ interface: e.currentTarget.value })}
            >
              {!interfaces.includes(draft.interface) && (
                <option value={draft.interface}>{draft.interface || 'Choose…'}</option>
              )}
              {interfaces.map((i) => (
                <option key={i} value={i}>
                  {networkLabel(i)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Next hop"
          stacked
          error={show('gateway')}
          hint="Leave empty to send the traffic straight out of the interface."
        >
          {(id) => (
            <input
              id={id}
              class="input font-mono"
              placeholder="Interface route"
              value={draft.gateway}
              onInput={(e) => update({ gateway: e.currentTarget.value.trim() })}
            />
          )}
        </Field>
        {onLink === false && (
          <div class="pb-2">
            <Banner tone="warn" role="status">
              {draft.gateway} is not on the {networkLabel(draft.interface)} subnet, so the router may not be able to
              reach it.
            </Banner>
          </div>
        )}
        <Field label="Metric" stacked error={show('metric')} hint="Lower wins when two routes match. Optional.">
          {(id) => (
            <input
              id={id}
              class="input font-mono"
              inputMode="numeric"
              placeholder="0"
              value={draft.metric}
              onInput={(e) => update({ metric: e.currentTarget.value.trim() })}
            />
          )}
        </Field>
      </FormSection>
    </EditDrawer>
  );
}

function RoutesTab({ network }: { network: UciConfig | undefined }) {
  const ifaces = useInterfaces();
  const [sel, setSel] = useState<string | null>(null);
  const routes = useMemo(() => (network ? normalizeStaticRoutes(network) : undefined), [network]);
  const interfaces = useMemo(
    () =>
      network
        ? sectionsOfType(network, 'interface')
            .map((s) => s['.name'])
            .filter((n) => n !== 'loopback')
        : [],
    [network],
  );
  const active = useMemo(() => (ifaces.data ? activeRoutes(ifaces.data) : undefined), [ifaces.data]);
  const current = routes?.find((r) => r.section === sel);

  return (
    <div class="space-y-4">
      <TableCard
        title="Static Routes"
        rows={routes}
        empty="No static routes. Add one to reach networks behind another router."
        onCreate={() => setSel('new')}
      >
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Destination</th>
              <th>Next hop</th>
              <th>Interface</th>
              <th>Metric</th>
            </tr>
          </thead>
          <tbody>
            {routes?.map((r) => (
              <tr key={r.section} data-clickable aria-selected={sel === r.section} onClick={() => setSel(r.section!)}>
                <td class="font-medium">{r.name || <span class="text-muted">Unnamed</span>}</td>
                <td>
                  <span class="inline-flex items-center gap-1.5">
                    <Dot tone={r.enabled ? 'ok' : 'neutral'} /> {r.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td class="font-mono text-xs">{r.target}</td>
                <td class="font-mono text-xs">{r.gateway || <span class="font-sans text-muted">Interface</span>}</td>
                <td>{networkLabel(r.interface)}</td>
                <td class="text-muted tabular-nums">{r.metric || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <TableCard title="Active Routes" rows={active} empty="No interfaces are up.">
        <table class="table" aria-label="Active routes">
          <thead>
            <tr>
              <th>Destination</th>
              <th>Next hop</th>
              <th>Interface</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {active?.map((r, i) => (
              <tr key={i}>
                <td class="font-mono text-xs">
                  {r.target === '0.0.0.0/0' || r.target === '::/0' ? `${r.target} (default)` : r.target}
                </td>
                <td class="font-mono text-xs">{r.via || <span class="font-sans text-muted">Direct</span>}</td>
                <td>
                  {networkLabel(r.interface)} <span class="font-mono text-xs text-muted">{r.device}</span>
                </td>
                <td>{r.kind === 'connected' ? <Pill>Connected</Pill> : <Pill tone="accent">Route</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      {network && sel === 'new' && (
        <RouteForm routes={routes ?? []} interfaces={interfaces} network={network} onClose={() => setSel(null)} />
      )}
      {network && current && (
        <RouteForm
          key={current.section}
          route={current}
          routes={routes ?? []}
          interfaces={interfaces}
          network={network}
          onClose={() => setSel(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DNS

function RecordForm({
  record,
  records,
  dhcp,
  onClose,
}: {
  record?: DnsRecord;
  records: DnsRecord[];
  dhcp: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo<DnsRecord>(() => record ?? { kind: 'A', name: '', value: '' }, [record]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  const [touched, setTouched] = useState(false);
  if (!draft) return null;
  const errors = validateDnsRecord(draft, records);
  const valid = Object.keys(errors).length === 0;
  const show = (k: 'name' | 'value') => (touched || record ? errors[k] : undefined);
  const submit = () => {
    setTouched(true);
    if (valid) void apply.start(dnsRecordOps(draft, record, dhcp), { ...PLAN, onConfirmed: onClose });
  };

  return (
    <EditDrawer
      title={record ? record.name : 'Create DNS Record'}
      subtitle={record ? `${record.kind === 'A' ? 'Host' : 'Alias'} → ${record.value}` : undefined}
      icon={<IconGlobe size={20} />}
      isNew={!record}
      {...{ dirty, stale, valid, reset, onClose }}
      onSubmit={submit}
      onRemove={() => void apply.start([{ op: 'delete', config: 'dhcp', section: record!.section! }], PLAN)}
    >
      <FormSection title="Record">
        <div class="py-2">
          <Segmented
            label="Record type"
            value={draft.kind}
            onChange={(kind) => update({ kind })}
            options={[
              { value: 'A', label: 'Host (A/AAAA)' },
              { value: 'CNAME', label: 'Alias (CNAME)' },
            ]}
          />
        </div>
        <Field
          label="Host name"
          stacked
          error={show('name')}
          hint="Resolved by the router for every device on your networks."
        >
          {(id) => (
            <input
              id={id}
              class="input"
              placeholder="nas.lan"
              value={draft.name}
              onInput={(e) => update({ name: e.currentTarget.value.trim() })}
            />
          )}
        </Field>
        <Field label={draft.kind === 'A' ? 'IP address' : 'Points to'} stacked error={show('value')}>
          {(id) => (
            <input
              id={id}
              class="input font-mono"
              placeholder={draft.kind === 'A' ? '192.168.1.10' : 'nas.lan'}
              value={draft.value}
              onInput={(e) => update({ value: e.currentTarget.value.trim() })}
            />
          )}
        </Field>
        {draft.kind === 'CNAME' && (
          <p class="pb-2 text-xs text-muted">
            The target must be a name the router itself knows, such as a host record or a DHCP client.
          </p>
        )}
      </FormSection>
    </EditDrawer>
  );
}

type SettingsDraft = Omit<DnsSettings, 'servers' | 'rebindAllowed'> & {
  custom: boolean;
  servers: string;
  rebindAllowed: string;
};

function DnsSettingsCard({ dhcp }: { dhcp: UciConfig }) {
  const apply = useApply();
  const settings = useMemo(() => normalizeDnsSettings(dhcp), [dhcp]);
  const source = useMemo<SettingsDraft | undefined>(
    () =>
      settings && {
        ...settings,
        custom: settings.servers.length > 0,
        servers: settings.servers.join(' '),
        rebindAllowed: settings.rebindAllowed.join(' '),
      },
    [settings],
  );
  const { draft, dirty, stale, reset, update } = useDraft(source);
  if (!settings || !draft) {
    return (
      <Card title="DNS Settings">
        <p class="text-muted">dnsmasq is not configured on this router.</p>
      </Card>
    );
  }
  const { custom, ...rest } = draft;
  const next: DnsSettings = {
    ...rest,
    servers: custom ? splitList(draft.servers) : [],
    rebindAllowed: draft.rebindProtection ? splitList(draft.rebindAllowed) : settings.rebindAllowed,
  };
  const errors = validateDnsSettings(next);
  if (custom && next.servers.length === 0) errors.servers = 'Enter at least one server, or use your ISP’s.';
  const ops: UciOp[] = dirty ? dnsSettingsOps(next, dhcp) : [];
  const valid = Object.keys(errors).length === 0;

  return (
    <Card
      title="DNS Settings"
      actions={
        <>
          {dirty && (
            <Button onClick={reset} disabled={apply.busy}>
              Reset
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!valid || ops.length === 0 || apply.busy}
            onClick={() => void apply.start(ops, PLAN)}
          >
            Apply Changes
          </Button>
        </>
      }
    >
      {stale && (
        <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
          These settings were changed on the router while you were editing.
        </Banner>
      )}
      <Field label="Upstream DNS">
        {() => (
          <Segmented
            label="Upstream DNS"
            value={custom ? 'custom' : 'auto'}
            onChange={(v) => update({ custom: v === 'custom' })}
            options={[
              { value: 'auto', label: 'Auto (ISP)' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
        )}
      </Field>
      {custom && (
        <Field
          label="DNS servers"
          error={errors.servers}
          hint="Separate with spaces, e.g. 1.1.1.1 9.9.9.9. The ISP's servers are no longer used."
        >
          {(id) => (
            <input
              id={id}
              class="input font-mono"
              value={draft.servers}
              placeholder="1.1.1.1 9.9.9.9"
              onInput={(e) => update({ servers: e.currentTarget.value })}
            />
          )}
        </Field>
      )}
      <Field label="Local domain" error={errors.domain} hint="Devices are reachable as name.domain, e.g. laptop.lan.">
        {(id) => (
          <input
            id={id}
            class="input"
            value={draft.domain}
            onInput={(e) => update({ domain: e.currentTarget.value.trim() })}
          />
        )}
      </Field>
      <ToggleRow
        label="DNS rebind protection"
        hint="Block upstream answers that point at private addresses."
        checked={draft.rebindProtection}
        onChange={(rebindProtection) => update({ rebindProtection })}
      />
      {draft.rebindProtection && (
        <Field
          label="Allow rebinding for"
          error={errors.rebindAllowed}
          hint="Optional. Domains that may resolve to private addresses, e.g. plex.direct."
        >
          {(id) => (
            <input
              id={id}
              class="input"
              value={draft.rebindAllowed}
              onInput={(e) => update({ rebindAllowed: e.currentTarget.value })}
            />
          )}
        </Field>
      )}
    </Card>
  );
}

function DnsTab({ dhcp }: { dhcp: UciConfig | undefined }) {
  const [sel, setSel] = useState<string | null>(null);
  const records = useMemo(() => (dhcp ? normalizeDnsRecords(dhcp) : undefined), [dhcp]);
  const current = records?.find((r) => r.section === sel);
  return (
    <div class="space-y-4">
      <TableCard
        title="Local DNS Records"
        rows={records}
        empty="No local DNS records. Add one to reach a device by name."
        onCreate={() => setSel('new')}
      >
        <table class="table">
          <thead>
            <tr>
              <th>Host name</th>
              <th>Type</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {records?.map((r) => (
              <tr key={r.section} data-clickable aria-selected={sel === r.section} onClick={() => setSel(r.section!)}>
                <td class="font-medium">{r.name}</td>
                <td>
                  <Pill tone={r.kind === 'A' ? 'accent' : 'neutral'}>{r.kind === 'A' ? 'Host' : 'Alias'}</Pill>
                </td>
                <td class="font-mono text-xs">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {dhcp && <DnsSettingsCard dhcp={dhcp} />}
      {dhcp && sel === 'new' && <RecordForm records={records ?? []} dhcp={dhcp} onClose={() => setSel(null)} />}
      {dhcp && current && (
        <RecordForm
          key={current.section}
          record={current}
          records={records ?? []}
          dhcp={dhcp}
          onClose={() => setSel(null)}
        />
      )}
    </div>
  );
}

export function RoutingPage() {
  const network = useUci('network');
  const dhcp = useUci('dhcp');
  const [tab, setTab] = useState<'routes' | 'dns'>('routes');
  return (
    <Page
      title="Routing & DNS"
      subtitle="Static routes, local DNS records and DNS settings"
      actions={
        <Segmented
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'routes', label: 'Routing' },
            { value: 'dns', label: 'DNS' },
          ]}
        />
      }
    >
      <LoadError error={firstError(network, dhcp)} />
      {tab === 'routes' ? <RoutesTab network={network.data} /> : <DnsTab dhcp={dhcp.data} />}
    </Page>
  );
}
