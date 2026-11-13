import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { UciConfig, WgKeyPair } from '../../api/types';
import { call } from '../../api/ubus';
import { useApply } from '../../api/useApply';
import {
  createServerOps,
  deleteServerOps,
  editServerOps,
  serverDraft,
  validateNewServer,
  validateServerEdit,
  type ServerDraft,
  type VpnAccess,
  type VpnServer,
} from '../../model/vpn';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconTrash, IconVpn } from '../../components/icons';
import { Banner, Button, Field, FormSection, cx } from '../../components/ui';

export const PLAN = { disruptive: true, returnTo: '/settings/vpn' };

const ACCESS: { value: VpnAccess; label: string; hint: string }[] = [
  {
    value: 'full',
    label: 'Full network access',
    hint: 'Internet and every device on your LAN.',
  },
  {
    value: 'internet',
    label: 'Internet only',
    hint: 'Internet only; no access to the router or LAN.',
  },
];

function AccessChoice({ value, onChange }: { value: VpnAccess; onChange: (v: VpnAccess) => void }) {
  return (
    <fieldset class="space-y-2 py-2.5">
      <legend class="pb-1.5 text-muted">Access</legend>
      {ACCESS.map((a) => (
        <label
          key={a.value}
          class={cx(
            'flex cursor-pointer items-start gap-3 rounded-md border p-3',
            value === a.value ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong',
          )}
        >
          <input
            type="radio"
            name="vpn-access"
            class="mt-0.5 accent-accent"
            checked={value === a.value}
            onChange={() => onChange(a.value)}
          />
          <span>
            <span class="block font-medium">{a.label}</span>
            <span class="block text-xs text-muted">{a.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

type Common = Omit<ServerDraft, 'name' | 'cidr'>;

/** Port, DNS, endpoint and access: shared by create and edit. */
function CommonFields({
  d,
  update,
  show,
  dnsDefault,
  accessEditable = true,
}: {
  d: Common;
  update: (p: Partial<Common>) => void;
  show: (k: keyof ServerDraft) => string | undefined;
  dnsDefault?: string;
  accessEditable?: boolean;
}) {
  return (
    <>
      <Field label="Port" stacked error={show('port')} hint="UDP, opened on the WAN.">
        {(id) => (
          <input id={id} class="input font-mono" inputMode="numeric" value={d.port} onInput={(e) => update({ port: e.currentTarget.value.trim() })} />
        )}
      </Field>
      <Field
        label="DNS server"
        stacked
        error={show('dns')}
        hint="Empty: this router."
      >
        {(id) => (
          <input
            id={id}
            class="input font-mono"
            placeholder={dnsDefault ?? ''}
            value={d.dns}
            onInput={(e) => update({ dns: e.currentTarget.value })}
          />
        )}
      </Field>
      <Field
        label="Endpoint"
        stacked
        error={show('endpoint')}
        hint="Public hostname or IP clients connect to."
      >
        {(id) => (
          <input
            id={id}
            class="input font-mono"
            placeholder="vpn.example.com"
            value={d.endpoint}
            onInput={(e) => update({ endpoint: e.currentTarget.value.trim() })}
          />
        )}
      </Field>
      {accessEditable ? (
        <AccessChoice value={d.access} onChange={(access) => update({ access })} />
      ) : (
        <p class="py-2.5 text-xs text-muted">Firewall managed in LuCI.</p>
      )}
    </>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CreateServerDrawer({
  initial,
  network,
  firewall,
  taken,
  onClose,
}: {
  initial: ServerDraft;
  network: UciConfig;
  firewall: UciConfig;
  taken: { address: string; prefix: number; network: string }[];
  onClose: () => void;
}) {
  const apply = useApply();
  const [d, setD] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const errors = validateNewServer(d, { network, firewall, taken });
  const show = (k: keyof ServerDraft) => (touched ? errors[k] : undefined);
  const update = (p: Partial<ServerDraft>) => setD((x) => ({ ...x, ...p }));
  const serverIp = d.cidr.split('/')[0];

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setWorking(true);
    setFailure(null);
    try {
      // Not a config write: the router generates the key, the apply flow writes it.
      const { keys } = await call<WgKeyPair>('luci.wireguard', 'generateKeyPair');
      if (!keys?.priv) throw new Error('The router returned no key. Is wireguard-tools installed?');
      onClose();
      await apply.start(createServerOps(d, keys.priv, { network, firewall }), PLAN);
    } catch (err) {
      setFailure(`Could not generate the server key: ${errorText(err)}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Drawer
      title="Create VPN Server"
      subtitle="WireGuard"
      icon={<IconVpn size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={apply.busy || working}>
            Create
          </Button>
        </>
      }
    >
      <div class="px-5">
        {failure && (
          <div class="mt-4">
            <Banner tone="bad" role="alert">
              {failure}
            </Banner>
          </div>
        )}
        <FormSection title="Server">
          <Field label="Name" stacked error={show('name')}>
            {(id) => <input id={id} class="input font-mono" value={d.name} onInput={(e) => update({ name: e.currentTarget.value.trim() })} />}
          </Field>
          <Field label="Gateway IP/Subnet" stacked error={show('cidr')}>
            {(id) => <input id={id} class="input font-mono" value={d.cidr} onInput={(e) => update({ cidr: e.currentTarget.value.trim() })} />}
          </Field>
        </FormSection>
        <FormSection title="Clients">
          <CommonFields d={d} update={update} show={show} dnsDefault={serverIp} />
        </FormSection>
      </div>
    </Drawer>
  );
}

export function EditServerDrawer({
  server,
  network,
  firewall,
  onClose,
}: {
  server: VpnServer;
  network: UciConfig;
  firewall: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo(() => serverDraft(server), [server]);
  const { draft, dirty, stale, reset, update } = useDraft<Common>(source);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!draft) return null;
  const errors = validateServerEdit(draft, server, { network, firewall });
  const valid = Object.keys(errors).length === 0;
  const show = (k: keyof ServerDraft) => errors[k];

  return (
    <Drawer
      title={`WireGuard Server ${server.iface}`}
      subtitle={server.address && `${server.address}/${server.prefix}`}
      icon={<IconVpn size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" class="mr-auto" onClick={() => setConfirmDelete(true)} disabled={apply.busy}>
            <IconTrash size={14} /> Delete
          </Button>
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={apply.busy || !dirty || !valid}
            onClick={() => void apply.start(editServerOps(server, draft, { network, firewall }), { ...PLAN, onConfirmed: onClose })}
          >
            Apply Changes
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This server was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        <FormSection title="Server">
          <CommonFields
            d={draft}
            update={update}
            show={show}
            dnsDefault={server.address}
            accessEditable={server.managed && server.access !== 'custom'}
          />
          <p class="pb-2 text-xs text-muted">Existing clients need a new configuration after a port, endpoint or DNS change.</p>
        </FormSection>
      </div>
      {confirmDelete && (
        <ConfirmModal
          title={`Delete VPN server ${server.iface}?`}
          action="Delete"
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onClose();
            void apply.start(deleteServerOps(server, { network, firewall }), PLAN);
          }}
        >
          <p class="text-muted">
            Removes the interface, {server.peers.length === 1 ? 'its client' : `all ${server.peers.length} clients`}
            {server.managed ? ' and its firewall rules' : ''}.
          </p>
        </ConfirmModal>
      )}
    </Drawer>
  );
}

export function ConfirmModal({
  title,
  action,
  children,
  onClose,
  onConfirm,
}: {
  title: string;
  action: string;
  children: ComponentChildren;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            {action}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
