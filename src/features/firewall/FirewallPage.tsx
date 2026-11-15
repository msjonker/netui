import { useMemo, useState } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import { displayName } from '../../model/clients';
import {
  newPortForward,
  normalizePortForwards,
  portForwardOps,
  removePortForwardOps,
  unblockOps,
  validatePortForward,
  zones,
  type PortForward,
  type PortForwardDraft,
} from '../../model/firewall';
import { useClients, useNetworks, useWanExposure } from '../../model/hooks';
import { NatNotice } from '../../components/NatNotice';
import type { Subnet } from '../../model/network';
import { zoneOfNetwork } from '../../model/policy';
import { inSubnet } from '../../lib/ip';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconBlock, IconExternal, IconPlus, IconShield, IconTrash } from '../../components/icons';
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
  Spinner,
  Tabs,
  ToggleRow,
} from '../../components/ui';
import { ContentFilterTab } from './ContentFilterTab';
import { PolicyTab } from './PolicyTab';
import { TrafficRulesTab } from './TrafficRulesTab';
import { LUCI_FIREWALL, LUCI_RULES, PLAN, PROTOCOLS, protoLabel, type Host } from './shared';
import { DmzCard } from './Dmz';

/** Zone that holds the destination address, so forwards to a guest network go to its zone. */
function zoneFor(ip: string, subnets: Subnet[], fw: UciConfig): string | undefined {
  const net = subnets.find((s) => inSubnet(ip, s.address, s.prefix))?.network;
  return net ? zones(fw).find((z) => z.networks.includes(net))?.name : undefined;
}

function PortForwardForm({
  pf,
  subnets,
  fw,
  hosts,
  onClose,
}: {
  pf?: PortForward;
  subnets: Subnet[];
  fw: UciConfig;
  hosts: Host[];
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo<PortForwardDraft>(() => {
    if (!pf) return newPortForward();
    const { section: _, ...rest } = pf;
    return rest;
  }, [pf]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [touched, setTouched] = useState(false);
  if (!draft) return null;

  const errors = validatePortForward(draft, subnets);
  const valid = Object.keys(errors).length === 0;
  const show = (k: keyof PortForwardDraft) => (touched || pf ? errors[k] : undefined);

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    const destZone = zoneFor(draft.destIp, subnets, fw) ?? draft.destZone;
    void apply.start(portForwardOps({ ...draft, destZone }, pf?.section, fw), { ...PLAN, onConfirmed: onClose });
  };

  return (
    <Drawer
      title={pf ? pf.name || 'Port forward' : 'Create Port Forward'}
      subtitle={pf ? `${protoLabel(String(pf.protocol))} ${pf.externalPort} → ${pf.destIp}:${pf.internalPort}` : undefined}
      icon={<IconShield size={20} />}
      onClose={onClose}
      footer={
        <>
          {pf && (
            <Button variant="danger" class="mr-auto" onClick={() => setConfirmDelete(true)} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || (!!pf && (!dirty || !valid))}>
            {pf ? 'Apply Changes' : 'Add'}
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This rule was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        <FormSection title="Rule">
          <Field label="Name" stacked error={show('name')}>
            {(id) => <input id={id} class="input" value={draft.name} onInput={(e) => update({ name: e.currentTarget.value })} />}
          </Field>
          <ToggleRow label="Enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
          <Field label="Protocol" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.protocol} onChange={(e) => update({ protocol: e.currentTarget.value })}>
                {!PROTOCOLS.some((p) => p.value === draft.protocol) && <option value={draft.protocol}>{draft.protocol}</option>}
                {PROTOCOLS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </FormSection>
        <FormSection title="From the internet">
          <Field label="External port" stacked error={show('externalPort')} hint="A port or range, e.g. 443 or 8000-8100.">
            {(id) => (
              <input
                id={id}
                class="input font-mono"
                inputMode="numeric"
                value={draft.externalPort}
                onInput={(e) => update({ externalPort: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
          <Field label="Only from" stacked error={show('srcIp')} hint="Optional. Restrict to one address or subnet.">
            {(id) => (
              <input
                id={id}
                class="input font-mono"
                placeholder="Anywhere"
                value={draft.srcIp ?? ''}
                onInput={(e) => update({ srcIp: e.currentTarget.value.trim() || undefined })}
              />
            )}
          </Field>
        </FormSection>
        <FormSection title="To this device">
          <Field label="Device IP" stacked error={show('destIp')}>
            {(id) => (
              <>
                <input
                  id={id}
                  class="input font-mono"
                  list="pf-hosts"
                  value={draft.destIp}
                  onInput={(e) => update({ destIp: e.currentTarget.value.trim() })}
                />
                <datalist id="pf-hosts">
                  {hosts.map((h) => (
                    <option key={h.ip} value={h.ip}>
                      {h.name}
                    </option>
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Device port" stacked error={show('internalPort')} hint="Leave empty to use the external port.">
            {(id) => (
              <input
                id={id}
                class="input font-mono"
                inputMode="numeric"
                placeholder={draft.externalPort || 'Same as external'}
                value={draft.internalPort === draft.externalPort ? '' : draft.internalPort}
                onInput={(e) => update({ internalPort: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
          {draft.destIp && !errors.destIp && !hosts.find((h) => h.ip === draft.destIp && h.fixed) && (
            <p class="pb-2 text-xs text-muted">
              Tip: give this device a fixed IP under Client Devices so the forward keeps working after its lease changes.
            </p>
          )}
        </FormSection>
      </div>
      {confirmDelete && pf && (
        <Modal
          title={`Remove "${pf.name || 'port forward'}"?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void apply.start(removePortForwardOps(pf.section, fw), PLAN);
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">
            {protoLabel(String(pf.protocol))} port {pf.externalPort} will no longer reach {pf.destIp}.
          </p>
        </Modal>
      )}
    </Drawer>
  );
}

type Tab = 'policies' | 'rules' | 'forwards' | 'filtering' | 'blocked';

const TABS: { value: Tab; label: string }[] = [
  { value: 'policies', label: 'Policies' },
  { value: 'rules', label: 'Traffic Rules' },
  { value: 'forwards', label: 'Port Forwarding' },
  { value: 'filtering', label: 'Ad Blocking & Filtering' },
  { value: 'blocked', label: 'Blocked Devices' },
];

function Loading() {
  return (
    <div class="flex justify-center py-10">
      <Spinner />
    </div>
  );
}

function PortForwards({ fw, subnets, hosts }: { fw: UciConfig; subnets: Subnet[]; hosts: Host[] }) {
  const [sel, setSel] = useState<string | 'new' | null>(null);
  const exposure = useWanExposure();
  const forwards = useMemo(() => normalizePortForwards(fw), [fw]);
  const current = forwards.find((p) => p.section === sel);
  return (
    <>
      {exposure && exposure.scope !== 'public' && (
        <div class="mb-4">
          <NatNotice exposure={exposure} />
        </div>
      )}
      <Card
        title="Port Forwarding"
        actions={
          <Button variant="primary" onClick={() => setSel('new')}>
            <IconPlus size={14} /> Create New
          </Button>
        }
        flush
      >
        {forwards.length === 0 ? (
          <Empty>No port forwards. Devices on your network are not reachable from the internet.</Empty>
        ) : (
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Protocol</th>
                  <th>External port</th>
                  <th>Forward to</th>
                  <th>Allowed from</th>
                </tr>
              </thead>
              <tbody>
                {forwards.map((p) => {
                  const host = hosts.find((h) => h.ip === p.destIp);
                  return (
                    <tr key={p.section} data-clickable aria-selected={sel === p.section} onClick={() => setSel(p.section)}>
                      <td class="font-medium">{p.name || <span class="text-muted">Unnamed</span>}</td>
                      <td>
                        <span class="inline-flex items-center gap-1.5">
                          <Dot tone={p.enabled ? 'ok' : 'neutral'} /> {p.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td>{protoLabel(String(p.protocol))}</td>
                      <td class="font-mono text-xs">{p.externalPort}</td>
                      <td class="font-mono text-xs">
                        {p.destIp}:{p.internalPort}
                        {host && <span class="ml-2 font-sans text-muted">{host.name}</span>}
                      </td>
                      <td class="font-mono text-xs text-muted">{p.srcIp ?? 'Anywhere'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div class="mt-4">
        <DmzCard fw={fw} hosts={hosts} zoneFor={(ip) => zoneFor(ip, subnets, fw)} />
      </div>
      {sel === 'new' && <PortForwardForm subnets={subnets} fw={fw} hosts={hosts} onClose={() => setSel(null)} />}
      {current && (
        <PortForwardForm key={current.section} pf={current} subnets={subnets} fw={fw} hosts={hosts} onClose={() => setSel(null)} />
      )}
    </>
  );
}

export function FirewallPage() {
  const { clients, subnets, firewall, dhcp, error } = useClients();
  const { networks } = useNetworks();
  const apply = useApply();
  const [tab, setTab] = useState<Tab>('policies');
  const fw = firewall.data;
  const blocked = clients.filter((c) => c.block?.enabled);
  const hosts = clients
    .filter((c) => c.ip)
    .map((c) => ({ ip: c.ip!, name: displayName(c), fixed: !!c.reservation?.ip }));
  // The zone the browser reaches the router through, when the page was
  // opened by one of the router's addresses.
  const uiNet = subnets.find((s) => s.gateway === location.hostname)?.network;
  const uiZone = fw && uiNet ? zoneOfNetwork(fw, uiNet)?.name : undefined;
  const networkIds = useMemo(() => (networks ?? []).map((n) => n.id), [networks]);

  return (
    <Page title="Firewall & Security" subtitle="Zone policies, traffic rules, port forwarding and content filtering">
      <LoadError error={error} />
      <div class="-mx-5 mb-4">
        <Tabs value={tab} onChange={setTab} tabs={TABS} />
      </div>
      {!fw ? (
        <Loading />
      ) : tab === 'policies' ? (
        <PolicyTab fw={fw} uiZone={uiZone} />
      ) : tab === 'rules' ? (
        <TrafficRulesTab fw={fw} subnets={subnets} clients={clients} />
      ) : tab === 'forwards' ? (
        <PortForwards fw={fw} subnets={subnets} hosts={hosts} />
      ) : tab === 'filtering' ? (
        dhcp.data && networks ? <ContentFilterTab networks={networkIds} dhcp={dhcp.data} fw={fw} subnets={subnets} /> : <Loading />
      ) : (
        <Card title="Blocked Devices" flush>
          {blocked.length === 0 ? (
            <Empty>No blocked devices. Block a device from its panel under Client Devices.</Empty>
          ) : (
            <ul class="divide-y divide-line">
              {blocked.map((c) => {
                const ops = c.block ? unblockOps(c.mac, c.block, fw) : null;
                return (
                  <li key={c.mac} class="flex h-12 items-center gap-3 px-4">
                    <IconBlock size={16} class="text-bad" />
                    <span class="min-w-0 flex-1 truncate font-medium">{displayName(c)}</span>
                    <span class="hidden font-mono text-xs text-muted sm:inline">{c.mac}</span>
                    {!c.block!.managed && <Pill>{c.block!.name || 'LuCI rule'}</Pill>}
                    {ops ? (
                      <Button disabled={apply.busy} onClick={() => apply.start(ops, PLAN)}>
                        Unblock
                      </Button>
                    ) : (
                      <a class="text-xs text-accent hover:underline" href={LUCI_RULES} target="_blank" rel="noreferrer">
                        Manage in LuCI
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
      <p class="mt-4 text-xs text-muted">
        NAT, IPv6 pinholes and advanced rule options are managed in LuCI.{' '}
        <a class="inline-flex items-center gap-1 text-accent hover:underline" href={LUCI_FIREWALL} target="_blank" rel="noreferrer">
          Open firewall in LuCI <IconExternal size={12} />
        </a>
      </p>
    </Page>
  );
}
