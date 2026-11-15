import { useMemo, useState } from 'preact/hooks';
import { useMwanStatus, useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import type { MwanInterfaceStatus, UciConfig } from '../../api/types';
import { useSwitch } from '../../model/hooks';
import {
  multiWanDraft,
  multiWanOps,
  readMultiWan,
  removeMultiWanOps,
  validateMultiWan,
  wan2Ports,
  WAN1,
  WAN2,
  type MultiWanDraft,
  type MultiWanMode,
} from '../../model/multiwan';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconExternal, IconGlobe } from '../../components/icons';
import { Banner, Button, Card, Detail, Dot, Field, FormSection, Pill } from '../../components/ui';
import { AddonMissing } from '../../components/InstallAddon';

const PLAN = { returnTo: '/settings/internet', disruptive: true };

const MODE_TEXT: Record<MultiWanMode, { label: string; hint: string }> = {
  failover: { label: 'Failover', hint: 'Everything uses WAN1. WAN2 takes over when WAN1 stops answering, and hands back when it recovers.' },
  balance: { label: 'Load balance', hint: 'New connections are spread over both. Sites that care about your address (banking) stay on one; if either fails, the other carries everything.' },
};

function StatusPill({ s }: { s?: MwanInterfaceStatus }) {
  // mwan3 reports an enabled interface without link as "disabled" (tracking paused).
  const status = s?.enabled && !s.up && s.status !== 'connecting' ? 'down' : (s?.status ?? 'unknown');
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'warn' : status === 'disabled' || status === 'unknown' ? 'neutral' : 'bad';
  const label =
    status === 'online'
      ? 'Online'
      : status === 'offline'
        ? 'Offline'
        : status === 'down'
          ? 'No connection'
          : status === 'connecting'
            ? 'Connecting'
            : status === 'disabled'
              ? 'Off'
              : 'Not tracked';
  return (
    <span class="inline-flex items-center gap-1.5">
      {tone !== 'neutral' && <Dot tone={tone} />}
      {label}
    </span>
  );
}

function MultiWanDrawer({ mwan3, network, firewall, onClose }: { mwan3: UciConfig; network: UciConfig; firewall: UciConfig; onClose: () => void }) {
  const apply = useApply();
  const { sw } = useSwitch();
  const m = useMemo(() => readMultiWan(network, mwan3), [network, mwan3]);
  const ports = sw ? wan2Ports(sw, m.port) : [];
  const source = useMemo(() => (sw ? multiWanDraft(m, ports.filter((p) => !p.carrier).map((p) => p.name)) : undefined), [m, sw]);
  const { draft, dirty, update } = useDraft<MultiWanDraft | undefined>(source);
  if (!draft || !sw) return null;
  const errors = validateMultiWan(draft);
  const valid = Object.keys(errors).length === 0;
  const chosen = ports.find((p) => p.name === draft.port);
  const submit = () =>
    void apply.start(multiWanOps(draft, { network, firewall, mwan3, sw }), { ...PLAN, onConfirmed: onClose });
  const text = (key: 'address' | 'prefix' | 'gateway' | 'dns', label: string, hint?: string) => (
    <Field label={label} stacked error={errors[key]} hint={hint}>
      {(id) => <input id={id} class="input font-mono" value={draft[key]} onInput={(e) => update({ [key]: e.currentTarget.value.trim() })} />}
    </Field>
  );

  return (
    <Drawer
      title="Second internet connection (WAN2)"
      subtitle="Failover or load balancing with mwan3"
      icon={<IconGlobe size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={apply.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || !valid || (m.enabled && !dirty)}>
            Apply Changes
          </Button>
        </>
      }
    >
      <div class="px-5">
        <FormSection title="Port">
          <Field label="Port" stacked error={errors.port} hint="The port leaves the LAN and becomes an internet port. Plug the second modem or router into it.">
            {(id) => (
              <select id={id} class="input" value={draft.port} onChange={(e) => update({ port: e.currentTarget.value })}>
                {ports.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.name === m.port ? ' (WAN2 now)' : p.carrier ? ' (something is plugged in)' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {chosen?.carrier && chosen.name !== m.port && (
            <Banner tone="warn" role="status">
              Something is plugged into {chosen.name}. It loses its LAN connection; if that is this computer, use another port.
            </Banner>
          )}
        </FormSection>
        <FormSection title="Connection">
          <Field label="Connection type" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.proto} onChange={(e) => update({ proto: e.currentTarget.value as 'dhcp' | 'static' })}>
                <option value="dhcp">DHCP (automatic)</option>
                <option value="static">Static IP</option>
              </select>
            )}
          </Field>
          {draft.proto === 'static' && (
            <>
              {text('address', 'IP address')}
              {text('prefix', 'Prefix length', 'For example 24 for 255.255.255.0.')}
              {text('gateway', 'Gateway')}
              {text('dns', 'DNS servers', 'Separate with commas.')}
            </>
          )}
        </FormSection>
        <FormSection title="How to use it">
          <div role="radiogroup" aria-label="Mode" class="space-y-2 py-2">
            {(Object.keys(MODE_TEXT) as MultiWanMode[]).map((k) => (
              <label key={k} class="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3 has-[:checked]:border-accent">
                <input type="radio" name="mwan-mode" class="mt-1" checked={draft.mode === k} onChange={() => update({ mode: k })} />
                <span>
                  <span class="block">{MODE_TEXT[k].label}</span>
                  <span class="block text-xs text-muted">{MODE_TEXT[k].hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p class="pb-2 text-xs text-muted">
            Each connection is checked by pinging public DNS servers. IPv6 stays on WAN1.
          </p>
        </FormSection>
      </div>
    </Drawer>
  );
}

/**
 * WAN2 with mwan3. Shows the live state of both connections; set up, edit and
 * remove go through the apply flow (the port change moves LAN membership).
 */
export function MultiWanCard({ network, firewall }: { network: UciConfig; firewall?: UciConfig }) {
  const apply = useApply();
  const mwan3 = useUci('mwan3');
  const status = useMwanStatus(!!mwan3.data);
  const { sw } = useSwitch();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (mwan3.isPending) return null;
  if (!mwan3.data || !firewall) {
    return (
      <Card title="Multi-WAN">
        <AddonMissing addon="multiwan">Add a second internet connection for failover or load balancing.</AddonMissing>
      </Card>
    );
  }
  const m = readMultiWan(network, mwan3.data);
  if (!m.supported) {
    return (
      <Card title="Multi-WAN">
        <p class="text-muted">
          mwan3 has a custom setup here, so netui leaves it alone.{' '}
          <a class="inline-flex items-center gap-1 text-accent hover:underline" href="/cgi-bin/luci/admin/network/mwan3" target="_blank" rel="noreferrer">
            Manage it in LuCI <IconExternal size={12} />
          </a>
        </p>
      </Card>
    );
  }
  const live = status.data?.interfaces;

  return (
    <Card
      title="Multi-WAN"
      actions={
        m.enabled ? (
          <>
            <Button onClick={() => setRemoving(true)} disabled={apply.busy}>
              Remove WAN2
            </Button>
            <Button onClick={() => setEditing(true)} disabled={apply.busy}>
              Edit
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setEditing(true)} disabled={apply.busy || !sw}>
            Add WAN2
          </Button>
        )
      }
    >
      {m.enabled ? (
        <Detail
          rows={[
            ['Mode', m.mode === 'custom' ? <Pill>Custom policy</Pill> : MODE_TEXT[m.mode].label],
            ['WAN1', <StatusPill s={live?.[WAN1]} />],
            [`WAN2 (${m.port})`, <StatusPill s={live?.[WAN2]} />],
          ]}
        />
      ) : (
        <p class="text-muted">
          Add a second internet connection on a spare port. netui keeps you online through it when the primary one fails, or
          spreads traffic over both.
        </p>
      )}
      {editing && <MultiWanDrawer mwan3={mwan3.data} network={network} firewall={firewall} onClose={() => setEditing(false)} />}
      {removing && sw && (
        <Modal
          title="Remove WAN2?"
          onClose={() => setRemoving(false)}
          footer={
            <>
              <Button onClick={() => setRemoving(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRemoving(false);
                  void apply.start(removeMultiWanOps({ network, firewall, mwan3: mwan3.data!, sw }), PLAN);
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">Only WAN1 carries traffic afterwards, and {m.port} goes back to being a LAN port.</p>
        </Modal>
      )}
    </Card>
  );
}
