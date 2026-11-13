import { useMemo, useState } from 'preact/hooks';
import type { UciConfig, UciSection } from '../../api/types';
import { list, str } from '../../api/uci';
import { useApply } from '../../api/useApply';
import { displayName, type Client } from '../../model/clients';
import { networkLabel, type Subnet } from '../../model/network';
import { zoneList } from '../../model/policy';
import {
  DAYS,
  newTrafficRule,
  normalizeTrafficRules,
  scheduleLabel,
  trafficRuleOps,
  validateTrafficRule,
  type TrafficRule,
  type TrafficRuleDraft as D,
} from '../../model/trafficRules';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconExternal, IconPlus, IconShield, IconTrash } from '../../components/icons';
import { Banner, Button, Card, Dot, Empty, Field, FormSection, Pill, Segmented, ToggleRow, cx } from '../../components/ui';
import { zoneLabel } from './PolicyTab';
import { LUCI_RULES, PLAN, protoLabel } from './shared';

interface Ctx {
  fw: UciConfig;
  subnets: Subnet[];
  clients: Client[];
}

type Opts = [string, string][];

/** A labelled select over [value, label] pairs. */
function Choice({ label, value, options, onChange, error }: { label: string; value: string; options: Opts; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label={label} stacked error={error}>
      {(id) => (
        <select id={id} class="input" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function Text({ label, value, onInput, error, hint }: { label: string; value: string; onInput: (v: string) => void; error?: string; hint?: string }) {
  return (
    <Field label={label} stacked error={error} hint={hint}>
      {(id) => <input id={id} class="input font-mono" value={value} onInput={(e) => onInput(e.currentTarget.value)} />}
    </Field>
  );
}

const PROTOS: Opts = [
  ['all', 'Any'],
  ['tcp udp', 'TCP and UDP'],
  ['tcp', 'TCP'],
  ['udp', 'UDP'],
  ['icmp', 'ICMP (ping)'],
];

function sourceLabel(d: D, clients: Client[]): string {
  if (d.source === 'network') return networkLabel(d.srcNetwork);
  if (d.source === 'ip') return d.srcIp;
  return d.macs
    .map((m) => {
      const c = clients.find((x) => x.mac === m);
      return c ? displayName(c) : m;
    })
    .join(', ');
}

function destLabel(d: D): string {
  const where = d.dest === 'internet' ? 'Internet' : d.dest === 'network' ? networkLabel(d.destNetwork) : d.destIp;
  return d.proto === 'all' ? where : `${where} · ${protoLabel(d.proto)} ${d.port}`.trim();
}

/** Plain description of a rule netui cannot edit. */
function rawLabels(s: UciSection, fw: UciConfig) {
  const zones = zoneList(fw);
  const side = (z: unknown, ...extra: unknown[]) =>
    [str(z) === '*' ? 'Any' : zoneLabel(str(z), zones), ...extra.flatMap(list)].join(' · ');
  const days = [...list(s.weekdays), [str(s.start_time), str(s.stop_time)].filter(Boolean).join('-')].join(' ').trim();
  return {
    src: side(s.src, s.src_ip, s.src_mac),
    dest: `${side(s.dest, s.dest_ip)} · ${protoLabel(list(s.proto).join(' ') || 'tcp udp')} ${list(s.dest_port).join(' ')}`.trim(),
    schedule: days || 'Always',
  };
}

function TrafficRuleForm({ rule, ctx, onClose }: { rule?: TrafficRule; ctx: Ctx; onClose: () => void }) {
  const apply = useApply();
  const source = useMemo(() => rule?.draft ?? newTrafficRule(ctx.subnets[0]?.network), [rule]);
  const { draft: d, dirty, stale, reset, update } = useDraft(source);
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!d) return null;

  const errors = validateTrafficRule(d, ctx);
  const valid = Object.keys(errors).length === 0;
  const show = (k: keyof D) => (touched || rule ? errors[k] : undefined);
  const nets: Opts = ctx.subnets.map((s) => [s.network, networkLabel(s.network)]);
  const pickable = [
    ...ctx.clients,
    ...d.macs.filter((m) => !ctx.clients.some((c) => c.mac === m)).map((mac) => ({ mac, randomMac: false })),
  ];
  const submit = () => {
    setTouched(true);
    if (!valid) return;
    // Closing on confirm (not before): a new rule's form would add a duplicate if left open.
    void apply.start(trafficRuleOps(d, rule?.section, ctx), { ...PLAN, onConfirmed: onClose });
  };
  const err = (k: keyof D) =>
    show(k) && (
      <p class="pt-1 text-xs text-bad" role="alert">
        {show(k)}
      </p>
    );

  return (
    <Drawer
      title={rule ? rule.name : 'Create Traffic Rule'}
      icon={<IconShield size={20} />}
      onClose={onClose}
      footer={
        <>
          {rule && (
            <Button variant="danger" class="mr-auto" onClick={() => setConfirmDelete(true)} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || (!!rule && (!dirty || !valid))}>
            {rule ? 'Apply Changes' : 'Add'}
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
            {(id) => <input id={id} class="input" value={d.name} onInput={(e) => update({ name: e.currentTarget.value })} />}
          </Field>
          <ToggleRow label="Enabled" checked={d.enabled} onChange={(enabled) => update({ enabled })} />
          <div class="py-2.5">
            <Segmented
              label="Action"
              value={d.action}
              onChange={(action) => update({ action })}
              options={[
                { value: 'block', label: 'Block' },
                { value: 'allow', label: 'Allow' },
              ]}
            />
          </div>
        </FormSection>
        <FormSection title="Source">
          <Choice
            label="Source"
            value={d.source}
            onChange={(v) => update({ source: v as D['source'] })}
            options={[
              ['network', 'A network'],
              ['devices', 'Client devices'],
              ['ip', 'IP addresses'],
            ]}
          />
          {d.source === 'network' && (
            <Choice label="Source network" value={d.srcNetwork} options={nets} onChange={(srcNetwork) => update({ srcNetwork })} error={show('srcNetwork')} />
          )}
          {d.source === 'devices' && (
            <fieldset class="py-2.5">
              <legend class="pb-1.5 text-muted">Devices (matched by MAC address)</legend>
              <div class="max-h-52 divide-y divide-line overflow-y-auto rounded-md border border-line">
                {pickable.map((c) => (
                  <label key={c.mac} class="flex h-9 cursor-pointer items-center gap-2 px-3 hover:bg-hover">
                    <input
                      type="checkbox"
                      checked={d.macs.includes(c.mac)}
                      onChange={(e) => update({ macs: e.currentTarget.checked ? [...d.macs, c.mac] : d.macs.filter((m) => m !== c.mac) })}
                    />
                    <span class="min-w-0 flex-1 truncate">{displayName(c)}</span>
                    <span class="font-mono text-[11px] text-muted">{c.mac}</span>
                  </label>
                ))}
              </div>
              {err('macs')}
            </fieldset>
          )}
          {d.source === 'ip' && (
            <Text label="Source addresses" value={d.srcIp} onInput={(srcIp) => update({ srcIp })} error={show('srcIp')} hint="Separate several with spaces." />
          )}
        </FormSection>
        <FormSection title="Destination">
          <Choice
            label="Destination"
            value={d.dest}
            onChange={(v) => update({ dest: v as D['dest'] })}
            options={[
              ['internet', 'Internet'],
              ['network', 'A local network'],
              ['ip', 'IP addresses'],
            ]}
          />
          {d.dest === 'network' && (
            <Choice
              label="Destination network"
              value={d.destNetwork}
              options={[['', 'Choose…'], ...nets]}
              onChange={(destNetwork) => update({ destNetwork })}
              error={show('destNetwork')}
            />
          )}
          {d.dest === 'ip' && (
            <Text label="Destination addresses" value={d.destIp} onInput={(destIp) => update({ destIp })} error={show('destIp')} hint="Separate several with spaces." />
          )}
          <Choice label="Protocol" value={d.proto} options={PROTOS} onChange={(v) => update({ proto: v as D['proto'] })} />
          {d.proto.startsWith('tcp') || d.proto === 'udp' ? (
            <Text label="Ports" value={d.port} onInput={(port) => update({ port })} error={show('port')} hint="Optional, e.g. 443 or 8000-8100." />
          ) : null}
        </FormSection>
        <FormSection title="Schedule">
          <Choice
            label="Schedule"
            value={d.schedule}
            onChange={(v) => update({ schedule: v as D['schedule'] })}
            options={[
              ['always', 'Always'],
              ['custom', 'Custom'],
            ]}
          />
          {d.schedule === 'custom' && (
            <>
              <div role="group" aria-label="Days" class="flex flex-wrap gap-1 py-2.5">
                {DAYS.map((x) => (
                  <button
                    key={x}
                    type="button"
                    aria-pressed={d.days.includes(x)}
                    onClick={() => update({ days: DAYS.filter((y) => (y === x) !== d.days.includes(y)) })}
                    class={cx('h-7 w-11 rounded-md border text-xs', d.days.includes(x) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted')}
                  >
                    {x}
                  </button>
                ))}
              </div>
              {err('days')}
              <div class="grid grid-cols-2 gap-3">
                <Field label="From" stacked error={show('start')}>
                  {(id) => <input id={id} type="time" class="input" value={d.start} onInput={(e) => update({ start: e.currentTarget.value })} />}
                </Field>
                <Field label="Until" stacked error={show('stop')}>
                  {(id) => <input id={id} type="time" class="input" value={d.stop} onInput={(e) => update({ stop: e.currentTarget.value })} />}
                </Field>
              </div>
              <p class="pb-2 text-xs text-muted">
                {scheduleLabel(d)}, router time. No days means every day. 22:00 until 06:00 runs past midnight. Connections
                open when a block starts may last until they close.
              </p>
            </>
          )}
        </FormSection>
      </div>
      {confirmDelete && rule && (
        <Modal
          title={`Remove "${rule.name}"?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void apply.start([{ op: 'delete', config: 'firewall', section: rule.section }], PLAN);
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">Matching traffic falls back to the zone policy.</p>
        </Modal>
      )}
    </Drawer>
  );
}

export function TrafficRulesTab(ctx: Ctx) {
  const { fw, subnets, clients } = ctx;
  const rules = useMemo(() => normalizeTrafficRules({ fw, subnets }), [fw, subnets]);
  const [sel, setSel] = useState<string | null>(null);
  const current = rules.find((r) => r.section === sel && r.draft);

  return (
    <>
      <Card
        title="Traffic Rules"
        actions={
          <Button variant="primary" onClick={() => setSel('new')}>
            <IconPlus size={14} /> Create New
          </Button>
        }
        flush
      >
        {rules.length === 0 ? (
          <Empty>No traffic rules. Zone policies decide what is allowed.</Empty>
        ) : (
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  {['Name', 'Action', 'Source', 'Destination', 'Schedule', 'Status'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const l = r.draft
                    ? { src: sourceLabel(r.draft, clients), dest: destLabel(r.draft), schedule: scheduleLabel(r.draft) }
                    : rawLabels(r.raw, fw);
                  const allow = r.target === 'ACCEPT';
                  return (
                    <tr
                      key={r.section}
                      data-clickable={r.draft ? '' : undefined}
                      aria-selected={sel === r.section}
                      onClick={r.draft ? () => setSel(r.section) : undefined}
                    >
                      <td class="font-medium">
                        {r.name}{' '}
                        {!r.draft && (
                          <a class="inline-flex items-center gap-1 align-middle" href={LUCI_RULES} target="_blank" rel="noreferrer">
                            <Pill>{r.managed ? 'Edited in LuCI' : 'LuCI'}</Pill>
                            <IconExternal size={12} class="text-accent" />
                          </a>
                        )}
                      </td>
                      <td>
                        <Pill tone={allow ? 'ok' : 'bad'}>{allow ? 'Allow' : 'Block'}</Pill>
                      </td>
                      <td class="max-w-56 truncate">{l.src}</td>
                      <td class="max-w-56 truncate">{l.dest}</td>
                      <td>{l.schedule}</td>
                      <td>
                        <Dot tone={r.enabled ? 'ok' : 'neutral'} /> {r.enabled ? 'Active' : 'Disabled'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {sel === 'new' && <TrafficRuleForm ctx={ctx} onClose={() => setSel(null)} />}
      {current && <TrafficRuleForm key={current.section} rule={current} ctx={ctx} onClose={() => setSel(null)} />}
    </>
  );
}
