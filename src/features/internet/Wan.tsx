import { useMemo, useState } from 'preact/hooks';
import type { DeviceStatus, InterfaceStatus, UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import { validateWan, wanDraft, wanOps, type Wan, type WanDraft } from '../../model/internet';
import { formatDuration } from '../../lib/format';
import { useDraft } from '../../lib/useDraft';
import { Drawer } from '../../components/overlay';
import { IconGlobe } from '../../components/icons';
import { Banner, Button, Card, Detail, Dot, Field, FormSection, Pill, Stat, ToggleRow } from '../../components/ui';

export const PLAN = { returnTo: '/settings/internet' };

export const PROTO_LABEL: Record<string, string> = {
  dhcp: 'DHCP',
  static: 'Static IP',
  pppoe: 'PPPoE',
  dhcpv6: 'DHCPv6',
  none: 'Unmanaged',
};

const hasDefaultRoute = (i?: InterfaceStatus) => !!i?.route?.some((r) => r.target === '0.0.0.0' && r.mask === 0);

function speed(dev?: DeviceStatus): string | undefined {
  if (!dev) return undefined;
  if (!dev.carrier) return 'No cable';
  const m = /^(\d+)([FH])$/.exec(dev.speed ?? '');
  if (!m) return 'Connected';
  const mbps = Number(m[1]);
  return `${mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`}${m[2] === 'H' ? ' half duplex' : ''}`;
}

/** Live WAN status: headline stats, then the details. */
export function WanStatusCard({
  wan,
  live,
  live6,
  port,
  onEdit,
}: {
  wan: Wan;
  live?: InterfaceStatus;
  live6?: InterfaceStatus;
  port?: DeviceStatus;
  onEdit: () => void;
}) {
  // Static interfaces stay up without a cable (netifd force_link).
  const online = !!live?.up && hasDefaultRoute(live) && port?.carrier !== false;
  const v4 = live?.['ipv4-address']?.[0];
  const v6 = live6?.['ipv6-address']?.[0] ?? live?.['ipv6-address']?.[0];
  const gateway = live?.route?.find((r) => r.target === '0.0.0.0' && r.mask === 0)?.nexthop;
  const tone = online ? 'ok' : live?.pending ? 'warn' : 'bad';
  return (
    <Card
      title={
        <span class="inline-flex items-center gap-2">
          <IconGlobe size={16} class="text-muted" /> Primary (WAN1)
        </span>
      }
      actions={
        <>
          <Pill tone={tone}>
            <Dot tone={tone} /> {online ? 'Online' : live?.pending ? 'Connecting' : 'Offline'}
          </Pill>
          <Button onClick={onEdit}>Edit</Button>
        </>
      }
    >
      <div class="grid grid-cols-2 gap-4 pb-4 sm:grid-cols-4">
        <Stat label="IPv4 address" value={v4 ? v4.address : '—'} hint={v4 && `/${v4.mask}`} />
        <Stat label="Gateway" value={gateway ?? '—'} />
        <Stat label="Uptime" value={online && live?.uptime != null ? formatDuration(live.uptime) : '—'} />
        <Stat label="Connection" value={PROTO_LABEL[wan.proto] ?? wan.proto} hint={wan.vlan ? `VLAN ${wan.vlan}` : undefined} />
      </div>
      <Detail
        rows={[
          ['Port', <span class="font-mono text-xs">{wan.port || '—'}</span>],
          ['Link', speed(port)],
          ['MAC address', <span class="font-mono text-xs">{wan.mac ?? port?.macaddr ?? '—'}</span>],
          ['DNS servers', live?.['dns-server']?.length ? live['dns-server'].join(', ') : undefined],
          [
            'IPv6',
            !wan.v6 && wan.proto !== 'pppoe' ? (
              'Not configured'
            ) : v6 ? (
              <span class="font-mono text-xs">
                {v6.address}/{v6.mask}
              </span>
            ) : wanDraft(wan).ipv6 ? (
              'Enabled, no address'
            ) : (
              'Disabled'
            ),
          ],
        ]}
      />
    </Card>
  );
}

/** Write-only secret: the stored value is never shown, empty keeps it. */
export function Secret(p: { label: string; value: string; error?: string; keep?: boolean; onInput: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={p.label} stacked error={p.error} hint={p.keep ? 'Leave empty to keep the current one.' : undefined}>
      {(id) => (
        <div class="relative">
          <input
            id={id}
            class="input pr-14"
            type={show ? 'text' : 'password'}
            autocomplete="new-password"
            placeholder={p.keep ? 'Unchanged' : ''}
            value={p.value}
            onInput={(e) => p.onInput(e.currentTarget.value)}
          />
          <button
            type="button"
            class="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-accent hover:underline"
            onClick={() => setShow(!show)}
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
    </Field>
  );
}

export function WanDrawer({
  wan,
  network,
  sqm,
  portMac,
  onClose,
}: {
  wan: Wan;
  network: UciConfig;
  sqm?: UciConfig;
  portMac?: string;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo(() => wanDraft(wan), [wan]);
  const { draft, dirty, stale, reset, update } = useDraft<WanDraft>(source);
  if (!draft) return null;
  const errors = validateWan(draft, wan);
  const valid = Object.keys(errors).length === 0;
  const isStatic = draft.proto === 'static';
  const keepPw = wan.proto === 'pppoe' && wan.hasPassword;

  const submit = () => {
    if (!valid) return;
    void apply.start(wanOps(draft, wan, network, sqm), { ...PLAN, disruptive: true, onConfirmed: onClose });
  };

  const text = (key: keyof WanDraft, label: string, opts: { hint?: string; placeholder?: string; mono?: boolean } = {}) => (
    <Field label={label} stacked error={errors[key]} hint={opts.hint}>
      {(id) => (
        <input
          id={id}
          class={opts.mono === false ? 'input' : 'input font-mono'}
          placeholder={opts.placeholder}
          value={draft[key] as string}
          onInput={(e) => update({ [key]: e.currentTarget.value.trim() })}
        />
      )}
    </Field>
  );

  return (
    <Drawer
      title="Primary (WAN1)"
      subtitle={`Internet connection on port ${wan.port}`}
      icon={<IconGlobe size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || !dirty || !valid}>
            Apply Changes
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              The WAN was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        <FormSection title="Connection">
          <Field label="Connection type" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.proto} onChange={(e) => update({ proto: e.currentTarget.value })}>
                {!['dhcp', 'static', 'pppoe'].includes(wan.proto) && (
                  <option value={wan.proto}>{PROTO_LABEL[wan.proto] ?? wan.proto}</option>
                )}
                <option value="dhcp">DHCP</option>
                <option value="static">Static IP</option>
                <option value="pppoe">PPPoE</option>
              </select>
            )}
          </Field>
          {isStatic && (
            <>
              <div class="grid grid-cols-[1fr_88px] gap-3">
                {text('address', 'IP address')}
                {text('prefix', 'Prefix', { placeholder: '24' })}
              </div>
              {text('gateway', 'Gateway')}
            </>
          )}
          {draft.proto === 'pppoe' && (
            <>
              {text('username', 'Username', { mono: false })}
              <Secret
                label="Password"
                value={draft.password}
                error={errors.password}
                keep={keepPw}
                onInput={(password) => update({ password })}
              />
            </>
          )}
        </FormSection>
        <FormSection title="DNS">
          {!isStatic && (
            <ToggleRow
              label="Auto DNS"
              hint="Use the DNS servers your ISP provides."
              checked={draft.autoDns}
              onChange={(autoDns) => update({ autoDns })}
            />
          )}
          {(isStatic || !draft.autoDns) && text('dns', 'DNS servers', { placeholder: '1.1.1.1, 9.9.9.9', hint: 'Separate several with commas.' })}
        </FormSection>
        <FormSection title="Advanced">
          {text('vlan', 'VLAN ID', { placeholder: 'None', hint: 'Only if your ISP requires a tagged connection (e.g. fibre).' })}
          {text('mac', 'MAC address clone', {
            placeholder: portMac ?? 'Default',
            hint: 'Leave empty for the port’s own address.',
          })}
          <ToggleRow
            label="IPv6"
            hint={wan.v6 || draft.proto === 'pppoe' ? 'Request an IPv6 address and prefix from your ISP.' : 'No IPv6 interface is configured; set one up in LuCI.'}
            checked={draft.ipv6}
            disabled={!wan.v6 && draft.proto !== 'pppoe'}
            onChange={(ipv6) => update({ ipv6 })}
          />
        </FormSection>
        <p class="py-3 text-xs text-muted">
          Applying briefly drops the internet connection. If the router cannot be reached afterwards it reverts on its own.
        </p>
      </div>
    </Drawer>
  );
}
