import { useMemo, useRef, useState } from 'preact/hooks';
import type { InterfaceDump, UciConfig, WgInstances } from '../../api/types';
import { useApply } from '../../api/useApply';
import { displayName } from '../../model/clients';
import { useClients } from '../../model/hooks';
import {
  clientDraft,
  createClientOps,
  deleteClientOps,
  editClientOps,
  normalizeVpnClient,
  parseWgConf,
  validateClient,
  type ClientDraft,
  type ClientMode,
  type VpnClient,
  type WgConf,
} from '../../model/vpnClient';
import { formatBytes, formatDuration } from '../../lib/format';
import { Drawer } from '../../components/overlay';
import { IconGlobe, IconTrash } from '../../components/icons';
import { Banner, Button, Card, Detail, Dot, Pill, Segmented, Stat, Toggle, ToggleRow } from '../../components/ui';
import { ConfirmModal, PLAN } from './ServerForms';

interface Props {
  network: UciConfig;
  firewall: UciConfig;
  dump?: InterfaceDump;
  wg?: WgInstances;
  /** luci.wireguard is missing: WireGuard is not installed. */
  noWireguard: boolean;
  nowS: number;
}

/** The router as a client of a VPN service: status, switch, and the set-up drawer. */
export function VpnClientSection({ network, firewall, dump, wg, noWireguard, nowS }: Props) {
  const apply = useApply();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const client = useMemo(
    () => normalizeVpnClient(network, firewall, dump, wg, nowS),
    [network, firewall, dump, wg, nowS],
  );
  const { clients } = useClients();
  const macOf = (ip: string) => clients.find((c) => c.ip === ip)?.mac;
  const label = (ip: string) => {
    const c = clients.find((x) => x.ip === ip);
    return c ? displayName(c) : ip;
  };

  const tone = !client?.enabled ? 'neutral' : client.live?.connected ? 'ok' : 'warn';
  const status = !client?.enabled ? 'Off' : client.live?.connected ? 'Connected' : 'Connecting';

  return (
    <>
      <h2 class="pt-2 text-[15px] font-semibold">VPN service</h2>
      {!client ? (
        <Card>
          <div class="flex flex-wrap items-center gap-4">
            <p class="min-w-0 flex-1 text-muted">
              Send your network’s internet traffic through a VPN provider, for privacy or to appear in another country.
              Your provider gives you a WireGuard configuration file.
              {noWireguard && (
                <>
                  {' '}
                  WireGuard is not installed: add the <span class="font-mono text-xs">wireguard-tools</span>,{' '}
                  <span class="font-mono text-xs">kmod-wireguard</span> and{' '}
                  <span class="font-mono text-xs">luci-proto-wireguard</span> packages, then restart the router.
                </>
              )}
            </p>
            <Button variant="primary" onClick={() => setOpen(true)} disabled={apply.busy || noWireguard}>
              Set Up
            </Button>
          </div>
        </Card>
      ) : (
        <Card
          title={
            <span class="inline-flex items-center gap-2">
              VPN service{' '}
              <Pill tone={tone}>
                <Dot tone={tone} /> {status}
              </Pill>
            </span>
          }
          actions={
            <>
              <Toggle
                label="VPN service on"
                checked={client.enabled}
                disabled={apply.busy}
                onChange={(enabled) =>
                  void apply.start(
                    editClientOps(client, { ...clientDraft(client, macOf), enabled }, { network, firewall }),
                    PLAN,
                  )
                }
              />
              <Button onClick={() => setOpen(true)} disabled={apply.busy}>
                Edit
              </Button>
            </>
          }
        >
          <div class="grid grid-cols-2 gap-4 pb-4 sm:grid-cols-4">
            <Stat label="Server" value={<span class="font-mono text-xs">{client.endpoint}</span>} />
            <Stat
              label="Last handshake"
              value={client.live?.handshake ? `${formatDuration(Math.max(0, nowS - client.live.handshake))} ago` : '—'}
            />
            <Stat label="Received" value={client.live ? formatBytes(client.live.rx) : '—'} />
            <Stat label="Sent" value={client.live ? formatBytes(client.live.tx) : '—'} />
          </div>
          <Detail
            rows={[
              ['Devices', client.mode === 'all' ? 'All devices' : client.devices.map(label).join(', ')],
              [
                'If the VPN is down',
                !client.enabled
                  ? 'Switched off: they go out directly'
                  : client.killSwitch
                    ? 'Their internet is blocked'
                    : 'They go out directly',
              ],
              ['Address in the VPN', client.address && <span class="font-mono text-xs">{client.address}</span>],
            ]}
          />
        </Card>
      )}
      {open && (
        <ClientDrawer
          client={client}
          network={network}
          firewall={firewall}
          clients={clients
            .filter((c) => c.ip)
            .map((c) => ({ ip: c.ip!, mac: c.mac, name: displayName(c), fixed: !!c.reservation?.ip }))}
          onRemove={() => {
            setOpen(false);
            setRemoving(true);
          }}
          onClose={() => setOpen(false)}
        />
      )}
      {removing && (
        <ConfirmModal
          title="Remove the VPN service?"
          action="Remove"
          onClose={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            void apply.start(deleteClientOps({ network, firewall }), PLAN);
          }}
        >
          <p class="text-muted">
            Devices go out to the internet directly again. The provider’s keys are deleted from the router.
          </p>
        </ConfirmModal>
      )}
    </>
  );
}

interface Choice {
  ip: string;
  mac: string;
  name: string;
  fixed: boolean;
}

function ClientDrawer({
  client,
  network,
  firewall,
  clients,
  onRemove,
  onClose,
}: {
  client?: VpnClient;
  network: UciConfig;
  firewall: UciConfig;
  clients: Choice[];
  onRemove: () => void;
  onClose: () => void;
}) {
  const apply = useApply();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<ClientDraft>(() =>
    client
      ? clientDraft(client, (ip) => clients.find((c) => c.ip === ip)?.mac)
      : { enabled: true, mode: 'all', devices: [], killSwitch: false },
  );
  const parsed = text.trim() ? parseWgConf(text) : undefined;
  const conf = parsed && !('error' in parsed) ? (parsed as WgConf) : undefined;
  const confError = parsed && 'error' in parsed ? parsed.error : undefined;
  const deviceError = validateClient(draft);
  const ctx = { network, firewall };
  const ops = conf ? createClientOps(conf, draft, ctx) : client ? editClientOps(client, draft, ctx) : [];
  const ready = !deviceError && !confError && (client ? ops.length > 0 : !!conf);

  const toggle = (c: Choice, on: boolean) =>
    setDraft((d) => ({
      ...d,
      devices: on ? [...d.devices, { ip: c.ip, mac: c.mac }] : d.devices.filter((x) => x.ip !== c.ip),
    }));
  const load = async (f: File | undefined) => {
    if (f) setText(await f.text());
    if (fileInput.current) fileInput.current.value = '';
  };
  // Chosen devices that are not in the client list any more stay listed.
  const choices: Choice[] = [
    ...clients,
    ...draft.devices
      .filter((d) => !clients.some((c) => c.ip === d.ip))
      .map((d) => ({ ip: d.ip, mac: d.mac ?? '', name: d.ip, fixed: true })),
  ];

  return (
    <Drawer
      title={client ? 'VPN service' : 'Set up a VPN service'}
      subtitle={client ? client.endpoint : 'With your provider’s WireGuard configuration file'}
      icon={<IconGlobe size={20} />}
      onClose={onClose}
      footer={
        <>
          {client && (
            <Button variant="danger" class="mr-auto" onClick={onRemove} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={onClose} disabled={apply.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready || apply.busy}
            onClick={() => void apply.start(ops, { ...PLAN, onConfirmed: onClose })}
          >
            {client ? 'Apply Changes' : 'Set Up'}
          </Button>
        </>
      }
    >
      <div class="space-y-4 px-5 py-4">
        <section class="space-y-2">
          <h3 class="font-medium">{client ? 'Replace the configuration file (optional)' : 'Configuration file'}</h3>
          <p class="text-xs text-muted">
            Download it from your VPN provider’s website (choose WireGuard, and a server location), then load or paste
            it here. It holds a private key: netui sends it to the router only.
          </p>
          <div class="flex gap-2">
            <Button onClick={() => fileInput.current?.click()}>Load File…</Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".conf,text/plain"
            class="hidden"
            aria-label="WireGuard configuration file"
            onChange={(e) => void load(e.currentTarget.files?.[0])}
          />
          <textarea
            class="input h-36 font-mono text-xs"
            aria-label="Configuration"
            placeholder={'[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\nPublicKey = …\nEndpoint = …'}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          {confError && (
            <p class="text-xs text-bad" role="alert">
              {confError}
            </p>
          )}
          {conf && (
            <Detail
              rows={[
                ['Server', <span class="font-mono text-xs">{`${conf.endpointHost}:${conf.endpointPort}`}</span>],
                ['Address', <span class="font-mono text-xs">{conf.addresses.join(', ')}</span>],
                ['IPv6 through the VPN', conf.ipv6 ? 'Yes' : 'No'],
              ]}
            />
          )}
        </section>
        <section class="space-y-2">
          <h3 class="font-medium">Which devices use it</h3>
          <Segmented<ClientMode>
            label="Which devices use it"
            value={draft.mode}
            onChange={(mode) => setDraft((d) => ({ ...d, mode }))}
            options={[
              { value: 'all', label: 'All devices' },
              { value: 'some', label: 'Chosen devices' },
            ]}
          />
          {draft.mode === 'all' ? (
            <p class="text-xs text-muted">Everything goes through the VPN, the router’s own traffic too.</p>
          ) : (
            <>
              <p class="text-xs text-muted">
                Only these devices go through the VPN. Give them fixed IP addresses (Client Devices → Settings) so they
                stay on it.
              </p>
              <ul class="max-h-60 divide-y divide-line overflow-auto rounded-md border border-line">
                {choices.map((c) => {
                  const on = draft.devices.some((d) => d.ip === c.ip);
                  return (
                    <li key={c.ip} class="flex h-10 items-center gap-3 px-3">
                      <input
                        type="checkbox"
                        id={`vpn-dev-${c.ip}`}
                        checked={on}
                        onChange={(e) => toggle(c, e.currentTarget.checked)}
                      />
                      <label for={`vpn-dev-${c.ip}`} class="min-w-0 flex-1 truncate">
                        {c.name}
                      </label>
                      {!c.fixed && <Pill tone="warn">No fixed IP</Pill>}
                      <span class="font-mono text-xs text-muted">{c.ip}</span>
                    </li>
                  );
                })}
              </ul>
              {deviceError && <p class="text-xs text-bad">{deviceError}</p>}
            </>
          )}
        </section>
        <ToggleRow
          label="Block the internet if the VPN is down"
          hint="Devices that use the VPN lose internet access while it is down, instead of going out directly."
          checked={draft.killSwitch}
          onChange={(killSwitch) => setDraft((d) => ({ ...d, killSwitch }))}
        />
        {client && !client.enabled && (
          <Banner tone="warn" role="status">
            The VPN service is switched off.
          </Banner>
        )}
      </div>
    </Drawer>
  );
}
