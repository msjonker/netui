import { useState } from 'preact/hooks';
import type { WgKeyPair, WgPsk } from '../../api/types';
import { call } from '../../api/ubus';
import type { Subnet } from '../../model/network';
import {
  clientAllowedIps,
  clientConfigText,
  confFileName,
  nextPeerAddress,
  validatePeer,
  type NewPeer,
  type Tunnel,
  type VpnServer,
} from '../../model/vpn';
import { Drawer, Modal } from '../../components/overlay';
import { QrCode } from '../../components/QrCode';
import { IconCopy, IconDownload, IconPlus } from '../../components/icons';
import { Banner, Button, Field, FormSection, Segmented } from '../../components/ui';

/**
 * A client whose keys exist only in this browser tab. The private key is
 * never staged: it is held here until the apply confirms (then shown once)
 * or fails (then dropped).
 */
export interface PendingClient extends NewPeer {
  iface: string;
  privateKey: string;
  serverPublicKey: string;
}

export function AddClientDrawer({
  server,
  onSubmit,
  onClose,
  busy,
}: {
  server: VpnServer;
  onSubmit: (c: PendingClient) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [keepalive, setKeepalive] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const address = nextPeerAddress(server);
  const errors = validatePeer({ name, keepalive });
  const show = (k: keyof typeof errors) => (touched ? errors[k] : undefined);

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length || !address || !server.publicKey) return;
    setWorking(true);
    setFailure(null);
    try {
      const [{ keys }, { psk }] = await Promise.all([
        call<WgKeyPair>('luci.wireguard', 'generateKeyPair'),
        call<WgPsk>('luci.wireguard', 'generatePsk'),
      ]);
      if (!keys?.priv || !keys.pub || !psk) throw new Error('The router returned no key.');
      onSubmit({
        iface: server.iface,
        name: name.trim(),
        keepalive: keepalive || undefined,
        address,
        publicKey: keys.pub,
        presharedKey: psk,
        privateKey: keys.priv,
        serverPublicKey: server.publicKey,
      });
    } catch (err) {
      setFailure(`Could not generate keys: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Drawer
      title="Add Client"
      subtitle={`WireGuard ${server.iface}`}
      icon={<IconPlus size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || working || !address || !server.publicKey}>
            Add
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
        {!address && (
          <div class="mt-4">
            <Banner tone="warn" role="status">
              No free addresses left.
            </Banner>
          </div>
        )}
        {!server.publicKey && (
          <div class="mt-4">
            <Banner tone="warn" role="status">
              The server is not running.
            </Banner>
          </div>
        )}
        <FormSection title="Client">
          <Field label="Name" stacked error={show('name')}>
            {(id) => <input id={id} class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} />}
          </Field>
          <Field label="IP address" stacked>
            {(id) => <input id={id} class="input font-mono" value={address ?? ''} readOnly disabled />}
          </Field>
          <Field
            label="Keepalive"
            stacked
            error={show('keepalive')}
            hint="Optional, seconds (e.g. 25)."
          >
            {(id) => (
              <input
                id={id}
                class="input font-mono"
                inputMode="numeric"
                placeholder="Off"
                value={keepalive}
                onInput={(e) => setKeepalive(e.currentTarget.value.trim())}
              />
            )}
          </Field>
        </FormSection>
        <p class="py-3 text-xs text-muted">The private key is shown once and never stored on the router.</p>
      </div>
    </Drawer>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ClientConfigModal({
  client,
  server,
  local,
  onClose,
}: {
  client: PendingClient;
  server: VpnServer | undefined;
  local: Subnet[];
  onClose: () => void;
}) {
  const [tunnel, setTunnel] = useState<Tunnel>('full');
  const [copied, setCopied] = useState(false);
  const text = clientConfigText({
    privateKey: client.privateKey,
    address: client.address,
    dns: server?.dns ?? [],
    serverPublicKey: server?.publicKey ?? client.serverPublicKey,
    presharedKey: client.presharedKey,
    endpoint: server?.endpoint ?? '',
    port: server?.listenPort ?? 51820,
    allowedIps: clientAllowedIps(tunnel, server ?? { access: 'internet' }, local),
    keepalive: client.keepalive,
  });

  return (
    <Modal
      title={`Client configuration: ${client.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => setCopied(true));
            }}
          >
            <IconCopy size={14} /> {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={() => download(confFileName(client.name), text)}>
            <IconDownload size={14} /> Download .conf
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div class="space-y-3 pb-2">
        <Banner tone="warn" role="alert">
          Save this now: the private key is not stored on the router and cannot be shown again.
        </Banner>
        <Segmented
          label="Tunnel"
          value={tunnel}
          onChange={setTunnel}
          options={[
            { value: 'full', label: 'All traffic' },
            { value: 'split', label: 'Home networks only' },
          ]}
        />
        <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div class="shrink-0 text-center">
            <QrCode value={text} size={208} label={`WireGuard QR code for ${client.name}`} />
            <p class="mt-1 text-xs text-muted">Scan with the WireGuard app</p>
          </div>
          <pre
            class="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-subtle p-3 font-mono text-xs leading-5 select-all"
            aria-label="Configuration file"
          >
            {text}
          </pre>
        </div>
      </div>
    </Modal>
  );
}
