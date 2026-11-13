import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { deleteUpnpRule, internetKeys, useDdnsStatus, useUpnpStatus } from '../../api/queries';
import type { UciConfig, UpnpRule } from '../../api/types';
import { useApply } from '../../api/useApply';
import { normalizeSqm, sqmDraft, sqmOps, validateSqm, type SqmDraft } from '../../model/sqm';
import { normalizeUpnp, upnpOps, type UpnpDraft } from '../../model/upnp';
import {
  CUSTOM,
  DDNS_PROVIDERS,
  ddnsDraft,
  ddnsOps,
  ddnsState,
  normalizeDdns,
  providerLabel,
  validateDdns,
  type DdnsDraft,
  type DdnsService,
} from '../../model/ddns';
import { formatDuration } from '../../lib/format';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconGlobe, IconPlus, IconTrash } from '../../components/icons';
import { Banner, Button, Card, Dot, Empty, Field, FormSection, Pill, Spinner, ToggleRow } from '../../components/ui';
import { PLAN, Secret } from './Wan';

/** Reset / Apply for an inline card form, shown once it is edited. */
function SaveRow({ dirty, valid, onReset, onApply }: { dirty: boolean; valid: boolean; onReset: () => void; onApply: () => void }) {
  const apply = useApply();
  if (!dirty) return null;
  return (
    <div class="flex justify-end gap-2 border-t border-line pt-3">
      <Button onClick={onReset} disabled={apply.busy}>
        Reset
      </Button>
      <Button variant="primary" onClick={onApply} disabled={apply.busy || !valid}>
        Apply Changes
      </Button>
    </div>
  );
}

function Mbps({ label, value, error, onInput }: { label: string; value: string; error?: string; onInput: (v: string) => void }) {
  return (
    <Field label={label} stacked error={error}>
      {(id) => (
        <div class="relative">
          <input
            id={id}
            class="input pr-12 font-mono"
            inputMode="decimal"
            value={value}
            onInput={(e) => onInput(e.currentTarget.value.trim())}
          />
          <span class="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">Mbps</span>
        </div>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Smart Queues

export function SqmCard({ cfg, wanL3 }: { cfg: UciConfig; wanL3: string }) {
  const apply = useApply();
  const q = useMemo(() => normalizeSqm(cfg, wanL3), [cfg, wanL3]);
  const source = useMemo(() => sqmDraft(q), [q]);
  const { draft, dirty, reset, update } = useDraft<SqmDraft>(source);
  if (!draft) return null;
  const errors = validateSqm(draft);
  const misplaced = q?.enabled && q.interface !== wanL3;
  return (
    <Card title="Smart Queues">
      <ToggleRow
        label="Smart Queues"
        hint="Keeps latency low while the line is busy by shaping traffic just below its speed. Set the limits to about 90% of a measured speed test."
        checked={draft.enabled}
        onChange={(enabled) => update({ enabled })}
      />
      {draft.enabled && (
        <div class="grid grid-cols-2 gap-3">
          <Mbps label="Download limit" value={draft.down} error={errors.down} onInput={(down) => update({ down })} />
          <Mbps label="Upload limit" value={draft.up} error={errors.up} onInput={(up) => update({ up })} />
        </div>
      )}
      {misplaced && (
        <p class="pb-2 text-xs text-warn">
          The queue is attached to {q.interface || 'no device'}, not the WAN ({wanL3}). Applying moves it.
        </p>
      )}
      <SaveRow
        dirty={dirty || (!!misplaced && draft.enabled)}
        valid={Object.keys(errors).length === 0}
        onReset={reset}
        onApply={() => void apply.start(sqmOps(draft, q, cfg, wanL3), PLAN)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// UPnP

function expires(s?: number): string {
  return s && s > 0 ? formatDuration(s) : '—';
}

export function UpnpCard({ cfg }: { cfg: UciConfig }) {
  const apply = useApply();
  const qc = useQueryClient();
  const u = useMemo(() => normalizeUpnp(cfg), [cfg]);
  const source = useMemo<UpnpDraft | undefined>(() => {
    if (!u) return undefined;
    const { section: _, ...rest } = u;
    return rest;
  }, [u]);
  const { draft, dirty, reset, update } = useDraft(source);
  const status = useUpnpStatus(!!u?.enabled);
  const [remove, setRemove] = useState<UpnpRule | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  if (!u || !draft) return null;

  const doRemove = async (r: UpnpRule) => {
    setRemove(null);
    setRemoveError(null);
    try {
      const res = await deleteUpnpRule(r.num);
      if ((res as { result?: string } | undefined)?.result !== 'OK') throw new Error('the router refused the request');
    } catch (err) {
      setRemoveError(`Could not remove the mapping: ${err instanceof Error ? err.message : String(err)}`);
    }
    await qc.invalidateQueries({ queryKey: internetKeys.upnp });
  };

  const rules = status.data ?? [];
  return (
    <Card title="UPnP" flush>
      <div class="px-4 pb-1">
        <ToggleRow
          label="UPnP"
          hint="Lets games, consoles and other devices open ports on the router automatically."
          checked={draft.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        {draft.enabled && (
          <>
            <ToggleRow label="NAT-PMP / PCP" hint="Also accept port requests from Apple devices and PCP clients." checked={draft.natpmp} onChange={(natpmp) => update({ natpmp })} />
            <ToggleRow
              label="Secure mode"
              hint="Devices may only open ports to themselves."
              checked={draft.secure}
              onChange={(secure) => update({ secure })}
            />
          </>
        )}
        <SaveRow dirty={dirty} valid onReset={reset} onApply={() => void apply.start(upnpOps(draft, u, cfg), PLAN)} />
        {removeError && (
          <div class="pb-3">
            <Banner tone="bad" role="alert">
              {removeError}
            </Banner>
          </div>
        )}
      </div>
      {u.enabled && (
        <div class="border-t border-line">
          <h3 class="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Active port mappings</h3>
          {status.isPending ? (
            <div class="flex justify-center py-6">
              <Spinner />
            </div>
          ) : rules.length === 0 ? (
            <Empty>No active port mappings.</Empty>
          ) : (
            <div class="overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Protocol</th>
                    <th>External port</th>
                    <th>Forward to</th>
                    <th>Description</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.num}>
                      <td class="font-medium">{r.host_hint ?? <span class="text-muted">Unknown</span>}</td>
                      <td>{r.proto}</td>
                      <td class="font-mono text-xs">{r.extport}</td>
                      <td class="font-mono text-xs">
                        {r.intaddr}:{r.intport}
                      </td>
                      <td class="text-muted">{r.descr || '—'}</td>
                      <td class="text-muted">{expires(r.expires)}</td>
                      <td class="text-right">
                        <Button variant="ghost" aria-label={`Remove mapping ${r.proto} ${r.extport}`} onClick={() => setRemove(r)}>
                          <IconTrash size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {remove && (
        <Modal
          title="Remove port mapping?"
          onClose={() => setRemove(null)}
          footer={
            <>
              <Button onClick={() => setRemove(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => void doRemove(remove)}>
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">
            {remove.proto} port {remove.extport} will stop reaching {remove.host_hint ?? remove.intaddr}. The device may request it
            again. The UPnP service restarts briefly.
          </p>
        </Modal>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dynamic DNS

function DdnsDrawer({
  svc,
  cfg,
  wan,
  wan6,
  onClose,
}: {
  svc?: DdnsService;
  cfg: UciConfig;
  wan: string;
  wan6?: string;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo(() => ddnsDraft(svc), [svc]);
  const { draft, dirty, reset, update } = useDraft<DdnsDraft>(source);
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!draft) return null;
  const errors = validateDdns(draft, svc);
  const valid = Object.keys(errors).length === 0;
  const show = (k: keyof DdnsDraft) => (touched || (svc && !svc.placeholder) ? errors[k] : undefined);
  const keepPw = svc && !svc.placeholder && svc.hasPassword;

  const submit = () => {
    setTouched(true);
    if (valid) void apply.start(ddnsOps(draft, svc, cfg, wan, wan6), { ...PLAN, onConfirmed: onClose });
  };

  const input = (k: 'hostname' | 'domain' | 'username', label: string, hint?: string, placeholder?: string) => (
    <Field label={label} stacked error={show(k)} hint={hint}>
      {(id) => (
        <input id={id} class="input" placeholder={placeholder} value={draft[k]} onInput={(e) => update({ [k]: e.currentTarget.value })} />
      )}
    </Field>
  );

  return (
    <Drawer
      title={svc ? svc.section : 'Create Dynamic DNS'}
      subtitle={svc && !svc.placeholder ? svc.hostname : undefined}
      icon={<IconGlobe size={20} />}
      onClose={onClose}
      footer={
        <>
          {svc && (
            <Button variant="danger" class="mr-auto" onClick={() => setConfirmDelete(true)} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || (!!svc && !dirty)}>
            {svc ? 'Apply Changes' : 'Add'}
          </Button>
        </>
      }
    >
      <div class="px-5">
        {svc?.placeholder && (
          <div class="mt-4">
            <Banner tone="warn">This is the example service from the factory config. Fill it in to use it.</Banner>
          </div>
        )}
        <FormSection title="Service">
          <ToggleRow label="Enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
          <Field label="Provider" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.provider} onChange={(e) => update({ provider: e.currentTarget.value })}>
                {svc?.provider === CUSTOM && !svc.placeholder && <option value={CUSTOM}>Custom URL</option>}
                {svc && svc.provider !== CUSTOM && !DDNS_PROVIDERS.some((p) => p.value === svc.provider) && (
                  <option value={svc.provider}>{svc.provider}</option>
                )}
                {DDNS_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {input('hostname', 'Hostname', 'The full name to keep pointed at this router.', 'myhome.duckdns.org')}
          {input('domain', 'Domain', 'Only if your provider wants a different form, e.g. host@zone for Cloudflare.', 'Same as hostname')}
          {input('username', 'Username', 'Leave empty if your provider only uses a token.')}
          <Secret
            label="Password or token"
            value={draft.password}
            error={show('password')}
            keep={keepPw}
            onInput={(password) => update({ password })}
          />
        </FormSection>
        <FormSection title="Address">
          <Field label="IP version" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.ipv6 ? '6' : '4'} onChange={(e) => update({ ipv6: e.currentTarget.value === '6' })}>
                <option value="4">IPv4 ({wan})</option>
                {(wan6 || draft.ipv6) && <option value="6">IPv6 ({wan6 ?? wan})</option>}
              </select>
            )}
          </Field>
          <Field label="Address source" stacked hint="Use a public lookup when the router sits behind another router or carrier NAT.">
            {(id) => (
              <select id={id} class="input" value={draft.source} onChange={(e) => update({ source: e.currentTarget.value })}>
                <option value="network">WAN interface address</option>
                <option value="web">Public IP lookup</option>
              </select>
            )}
          </Field>
        </FormSection>
        <p class="py-3 text-xs text-muted">The service restarts after applying and updates once the WAN has an address.</p>
      </div>
      {confirmDelete && svc && (
        <Modal
          title={`Remove "${svc.section}"?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void apply.start([{ op: 'delete', config: 'ddns', section: svc.section }], PLAN);
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">{svc.placeholder ? 'The example service is removed.' : `${svc.hostname} will stop being updated.`}</p>
        </Modal>
      )}
    </Drawer>
  );
}

export function DdnsCard({ cfg, wan, wan6 }: { cfg: UciConfig; wan: string; wan6?: string }) {
  const services = useMemo(() => normalizeDdns(cfg), [cfg]);
  const status = useDdnsStatus();
  const [sel, setSel] = useState<string | 'new' | null>(null);
  const current = services.find((s) => s.section === sel);
  const cell = (v: ComponentChildren) => v || <span class="text-faint">—</span>;
  return (
    <Card
      title="Dynamic DNS"
      flush
      actions={
        <Button variant="primary" onClick={() => setSel('new')}>
          <IconPlus size={14} /> Create New
        </Button>
      }
    >
      {services.length === 0 ? (
        <Empty>No dynamic DNS services. Add one to reach this router by name while its public IP changes.</Empty>
      ) : (
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Registered IP</th>
                <th>Last update</th>
                <th>Next update</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => {
                const st = status.data?.[s.section];
                const state = ddnsState(s, st);
                const next = st?.next_update && !['Stopped', 'Disabled'].includes(st.next_update) ? st.next_update : '';
                return (
                  <tr key={s.section} data-clickable aria-selected={sel === s.section} onClick={() => setSel(s.section)}>
                    <td class="font-medium">
                      {s.placeholder ? <span class="text-muted">{s.section} (example)</span> : s.hostname}
                      {s.ipv6 && (
                        <span class="ml-2">
                          <Pill>IPv6</Pill>
                        </span>
                      )}
                    </td>
                    <td>{s.placeholder ? cell('') : providerLabel(s.provider)}</td>
                    <td>
                      <span class="inline-flex items-center gap-1.5">
                        <Dot tone={state.tone} /> {state.label}
                      </span>
                    </td>
                    <td class="font-mono text-xs">{cell(s.placeholder ? '' : st?.ip?.replace(/<br\/>/g, ', '))}</td>
                    <td class="text-muted">{cell(st?.last_update)}</td>
                    <td class="text-muted">{cell(next)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sel === 'new' && <DdnsDrawer cfg={cfg} wan={wan} wan6={wan6} onClose={() => setSel(null)} />}
      {current && <DdnsDrawer key={current.section} svc={current} cfg={cfg} wan={wan} wan6={wan6} onClose={() => setSel(null)} />}
    </Card>
  );
}

