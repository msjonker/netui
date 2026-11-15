import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { firstError, useUci, useWgInstances } from '../../api/queries';
import type { UciConfig } from '../../api/types';
import { sectionsOfType } from '../../api/uci';
import { useApply } from '../../api/useApply';
import { useNetworks, useWanExposure } from '../../model/hooks';
import { NatNotice } from '../../components/NatNotice';
import { attachedSubnets } from '../../model/network';
import {
  addPeerOps,
  newServerDraft,
  normalizeVpn,
  peerType,
  removePeerOps,
  setPeerEnabledOps,
  takenSubnets,
  type VpnPeer,
  type VpnServer,
} from '../../model/vpn';
import { formatBytes, formatDuration } from '../../lib/format';
import { IconCopy, IconExternal, IconPlus, IconTrash, IconVpn } from '../../components/icons';
import { Banner, Button, Card, Detail, Dot, Empty, LoadError, Page, Spinner, Stat, Toggle } from '../../components/ui';
import { AddClientDrawer, ClientConfigModal, type PendingClient } from './ClientForms';
import { ConfirmModal, CreateServerDrawer, EditServerDrawer, PLAN } from './ServerForms';

// The router as a VPN client: loaded on demand, few set one up.
const VpnClientSection = lazy(() => import('./VpnClient').then((m) => ({ default: m.VpnClientSection })));

type Panel = { kind: 'create' } | { kind: 'edit'; iface: string } | { kind: 'client'; iface: string } | null;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={done ? 'Copied' : label}
      class="rounded p-1 text-muted hover:bg-hover hover:text-fg"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true))}
    >
      <IconCopy size={14} />
    </button>
  );
}

const ACCESS_LABEL = { full: 'Full network access', internet: 'Internet only', custom: 'Custom (LuCI)' };

function ServerCard({ server, onEdit }: { server: VpnServer; onEdit: () => void }) {
  const connected = server.peers.filter((p) => p.live?.connected).length;
  return (
    <Card
      title={
        <span class="inline-flex items-center gap-2">
          WireGuard VPN Server <span class="font-mono text-xs font-normal text-muted">{server.iface}</span>
        </span>
      }
      actions={<Button onClick={onEdit}>Edit</Button>}
    >
      <div class="grid grid-cols-2 gap-4 pb-4 sm:grid-cols-4">
        <Stat
          label="Status"
          value={
            <span class="inline-flex items-center gap-2">
              <Dot tone={server.up ? 'ok' : 'bad'} /> {server.up ? 'Running' : 'Down'}
            </span>
          }
        />
        <Stat label="Connected clients" value={`${connected} / ${server.peers.length}`} />
        <Stat label="Port" value={server.listenPort ?? '—'} hint="UDP" />
        <Stat label="Endpoint" value={<span class="text-base">{server.endpoint || '—'}</span>} />
      </div>
      <Detail
        rows={[
          [
            'Public key',
            server.publicKey ? (
              <span class="inline-flex max-w-full items-center gap-1">
                <span class="truncate font-mono text-xs">{server.publicKey}</span>
                <CopyButton text={server.publicKey} label="Copy public key" />
              </span>
            ) : (
              null
            ),
          ],
          ['Gateway IP/Subnet', server.address && <span class="font-mono">{`${server.address}/${server.prefix}`}</span>],
          ['DNS for clients', server.dns.length ? <span class="font-mono">{server.dns.join(', ')}</span> : null],
          ['Access', ACCESS_LABEL[server.access]],
        ]}
      />
    </Card>
  );
}

function peerStatus(p: VpnPeer, nowS: number) {
  if (!p.enabled) return <span class="text-muted">Disabled</span>;
  if (p.live?.connected) {
    return (
      <span class="inline-flex items-center gap-1.5">
        <Dot tone="ok" /> Connected
      </span>
    );
  }
  if (p.live?.handshake) {
    return (
      <span class="inline-flex items-center gap-1.5 text-muted">
        <Dot tone="neutral" /> Last seen {formatDuration(Math.max(0, nowS - p.live.handshake))} ago
      </span>
    );
  }
  return (
    <span class="inline-flex items-center gap-1.5 text-muted">
      <Dot tone="neutral" /> Never connected
    </span>
  );
}

function ClientsCard({
  server,
  nowS,
  busy,
  onAdd,
  onToggle,
  onRemove,
}: {
  server: VpnServer;
  nowS: number;
  busy: boolean;
  onAdd: () => void;
  onToggle: (p: VpnPeer, enabled: boolean) => void;
  onRemove: (p: VpnPeer) => void;
}) {
  return (
    <Card
      title={`Clients (${server.peers.length})`}
      actions={
        <Button variant="primary" onClick={onAdd} disabled={busy}>
          <IconPlus size={14} /> Add Client
        </Button>
      }
      flush
    >
      {server.peers.length === 0 ? (
        <Empty>No clients yet.</Empty>
      ) : (
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>IP address</th>
                <th>Connected from</th>
                <th>Download / Upload</th>
                <th>Enabled</th>
                <th>
                  <span class="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {server.peers.map((p) => (
                <tr key={p.section}>
                  <td class="font-medium">{p.name || <span class="text-muted">Unnamed</span>}</td>
                  <td>{peerStatus(p, nowS)}</td>
                  <td class="font-mono text-xs">{p.address ?? p.allowedIps.join(', ')}</td>
                  <td class="font-mono text-xs text-muted">{p.live?.endpoint ?? '—'}</td>
                  <td class="text-xs tabular-nums">
                    {p.live ? `${formatBytes(p.live.tx)} / ${formatBytes(p.live.rx)}` : '—'}
                  </td>
                  <td>
                    <Toggle
                      label={`Enable ${p.name || p.section}`}
                      checked={p.enabled}
                      disabled={busy}
                      onChange={(v) => onToggle(p, v)}
                    />
                  </td>
                  <td class="text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${p.name || p.section}`}
                      class="rounded p-1 text-muted hover:bg-bad-soft hover:text-bad disabled:opacity-50"
                      disabled={busy}
                      onClick={() => onRemove(p)}
                    >
                      <IconTrash size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function EmptyState({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return (
    <Card>
      <div class="flex flex-col items-center gap-3 py-10 text-center">
        <div class="flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
          <IconVpn size={28} />
        </div>
        <h2 class="text-[15px] font-semibold">WireGuard VPN Server</h2>
        <p class="max-w-md text-muted">Reach your home network from anywhere. Set up phones by scanning a QR code.</p>
        <Button variant="primary" onClick={onCreate} disabled={disabled}>
          <IconPlus size={14} /> Create VPN Server
        </Button>
      </div>
    </Card>
  );
}

/**
 * Hold a new client's keys until the apply that adds it is over: confirmed
 * (the router's config, re-read after apply, has the peer) shows them once;
 * anything else (discard, rollback, staging error) drops them.
 */
function usePendingClient(network: { data?: UciConfig; isFetching: boolean }, busy: boolean) {
  const [pending, setPending] = useState<PendingClient | null>(null);
  const [ready, setReady] = useState(false);
  const [dropped, setDropped] = useState(false);
  const sawBusy = useRef(false);

  useEffect(() => {
    if (!pending || ready) return;
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current || network.isFetching) return;
    sawBusy.current = false;
    const cfg = network.data;
    const added = cfg && sectionsOfType(cfg, peerType(pending.iface)).some((s) => s.public_key === pending.publicKey);
    if (added) setReady(true);
    else {
      setPending(null);
      setDropped(true);
    }
  }, [pending, ready, busy, network.data, network.isFetching]);

  return {
    pending,
    ready,
    dropped,
    begin(c: PendingClient) {
      sawBusy.current = false;
      setDropped(false);
      setReady(false);
      setPending(c);
    },
    clear() {
      setPending(null);
      setReady(false);
      setDropped(false);
    },
  };
}

export function VpnPage() {
  const { network, firewall, ifaces, subnets } = useNetworks();
  const wg = useWgInstances();
  // DDNS is optional (ddns-scripts may not be installed): only a default for the endpoint.
  const ddns = useUci('ddns');
  const apply = useApply();
  const [panel, setPanel] = useState<Panel>(null);
  const [removing, setRemoving] = useState<{ server: VpnServer; peer: VpnPeer } | null>(null);
  const client = usePendingClient(network, apply.busy);
  const exposure = useWanExposure();

  const nowS = Math.floor(Date.now() / 1000);
  const model = useMemo(
    () => (network.data ? normalizeVpn(network.data, firewall.data, ifaces.data, wg.data, nowS) : undefined),
    // nowS changes every second; recompute on data, which polls every 10 s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network.data, firewall.data, ifaces.data, wg.data],
  );
  const taken = useMemo(
    () => (network.data ? takenSubnets(attachedSubnets(subnets, ifaces.data), network.data) : []),
    [network.data, subnets, ifaces.data],
  );
  const net = network.data;
  const fw = firewall.data;
  const error = firstError(network, firewall);
  const find = (iface: string) => model?.servers.find((s) => s.iface === iface);

  const openCreate = () => setPanel({ kind: 'create' });
  const editing = panel?.kind === 'edit' ? find(panel.iface) : undefined;
  const adding = panel?.kind === 'client' ? find(panel.iface) : undefined;

  return (
    <Page
      title="VPN"
      subtitle="Reach home from anywhere, or send your traffic through a VPN service"
      actions={
        model?.servers.length ? (
          <Button onClick={openCreate} disabled={!net || !fw || apply.busy}>
            <IconPlus size={14} /> Create VPN Server
          </Button>
        ) : undefined
      }
    >
      <LoadError error={error} />
      {wg.error && (
        <div class="mb-4">
          <Banner tone="warn" role="status">
            Live status unavailable: {wg.error.message}
          </Banner>
        </div>
      )}
      {exposure && exposure.scope !== 'public' && (
        <div class="mb-4">
          <NatNotice exposure={exposure} />
        </div>
      )}
      {client.dropped && (
        <div class="mb-4">
          <Banner tone="warn" role="status" actions={<Button onClick={client.clear}>Dismiss</Button>}>
            The client was not added, so its keys were discarded.
          </Banner>
        </div>
      )}
      {!model ? (
        <div class="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div class="space-y-4">
          {model.servers.length === 0 && <EmptyState onCreate={openCreate} disabled={!fw || apply.busy} />}
          {model.servers.map((s) => (
            <div key={s.iface} class="space-y-4">
              <ServerCard server={s} onEdit={() => setPanel({ kind: 'edit', iface: s.iface })} />
              <ClientsCard
                server={s}
                nowS={nowS}
                busy={apply.busy}
                onAdd={() => setPanel({ kind: 'client', iface: s.iface })}
                onToggle={(p, enabled) => net && void apply.start(setPeerEnabledOps(s.iface, p.section, enabled, net), PLAN)}
                onRemove={(p) => setRemoving({ server: s, peer: p })}
              />
            </div>
          ))}
          {net && fw && (
            <Suspense fallback={null}>
              <VpnClientSection
                network={net}
                firewall={fw}
                dump={ifaces.data}
                wg={wg.data}
                noWireguard={!!wg.error && /not found/i.test(wg.error.message)}
                nowS={nowS}
              />
            </Suspense>
          )}
          {model.others.length > 0 && (
            <Card title="Other WireGuard Interfaces">
              <p class="text-muted">
                {model.others.join(', ')}{' '}
                <a
                  class="inline-flex items-center gap-1 text-accent hover:underline"
                  href="/cgi-bin/luci/admin/network/network"
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage in LuCI <IconExternal size={12} />
                </a>
              </p>
            </Card>
          )}
        </div>
      )}

      {panel?.kind === 'create' && net && fw && (
        <CreateServerDrawer
          initial={newServerDraft({ network: net, taken, ddns: ddns.data, dump: ifaces.data })}
          network={net}
          firewall={fw}
          taken={taken}
          onClose={() => setPanel(null)}
        />
      )}
      {editing && net && fw && (
        <EditServerDrawer key={editing.iface} server={editing} network={net} firewall={fw} onClose={() => setPanel(null)} />
      )}
      {adding && net && (
        <AddClientDrawer
          server={adding}
          busy={apply.busy}
          onClose={() => setPanel(null)}
          onSubmit={(c) => {
            setPanel(null);
            client.begin(c);
            // Only the public half goes to the router.
            const { privateKey: _secret, serverPublicKey: _server, iface, ...peer } = c;
            void apply.start(addPeerOps(iface, peer, net), PLAN);
          }}
        />
      )}
      {removing && net && (
        <ConfirmModal
          title={`Remove "${removing.peer.name || 'client'}"?`}
          action="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const { server, peer } = removing;
            setRemoving(null);
            void apply.start(removePeerOps(server.iface, peer.section, net), PLAN);
          }}
        >
          <p class="text-muted">Its key stops working and the device can no longer connect.</p>
        </ConfirmModal>
      )}
      {client.pending && client.ready && (
        <ClientConfigModal client={client.pending} server={find(client.pending.iface)} local={subnets} onClose={client.clear} />
      )}
    </Page>
  );
}
