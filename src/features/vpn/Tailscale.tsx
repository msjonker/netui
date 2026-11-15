import { useEffect, useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import {
  tailscaleDown,
  tailscaleKeys,
  tailscaleLogin,
  tailscaleLogout,
  tailscaleSet,
  tailscaleUp,
  useTailscale,
} from '../../api/tailscale';
import type { Subnet } from '../../model/network';
import { zoneOfNetwork } from '../../model/policy';
import {
  hasTailscaleZone,
  normalizeTailscale,
  tailscaleFirewallOps,
  type TailscaleAccess,
} from '../../model/tailscale';
import { IconExternal } from '../../components/icons';
import { Banner, Button, Card, Detail, Dot, Pill, Spinner, Stat, ToggleRow } from '../../components/ui';
import { PLAN } from './ServerForms';

const ADMIN = 'https://login.tailscale.com/admin/machines';

function Ext({ href, children }: { href: string; children: string }) {
  return (
    <a class="inline-flex items-center gap-1 text-accent hover:underline" href={href} target="_blank" rel="noreferrer">
      {children} <IconExternal size={12} />
    </a>
  );
}

/** Remote access with Tailscale: works behind carrier-grade NAT, no open port. */
export function TailscaleCard({
  network,
  firewall,
  subnets,
}: {
  network: UciConfig;
  firewall: UciConfig;
  subnets: Subnet[];
}) {
  const apply = useApply();
  const qc = useQueryClient();
  const [fast, setFast] = useState(false);
  const [waitingFor, setWaitingFor] = useState(false);
  const q = useTailscale(fast || waitingFor ? 2_000 : 15_000);
  const ts = useMemo(() => normalizeTailscale(q.data), [q.data]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [access, setAccess] = useState<TailscaleAccess | null>(null);

  // Only the home networks (the lan zone), never a guest network.
  const lanZone = zoneOfNetwork(firewall, 'lan')?.name;
  const homeRoutes = subnets
    .filter((s) => zoneOfNetwork(firewall, s.network)?.name === lanZone)
    .map((s) => `${s.address}/${s.prefix}`);

  const run = async (fn: () => Promise<void>, watch = false) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      if (watch) setFast(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: tailscaleKeys.status });
    }
  };
  /** Stage the firewall first when it changes, then act on the daemon once confirmed. */
  const withFirewall = (want: TailscaleAccess, then: () => Promise<void>, watch = false) => {
    const ops = tailscaleFirewallOps(want, { network, firewall });
    if (ops.length) void apply.start(ops, { ...PLAN, onConfirmed: () => void run(then, watch) });
    else void run(then, watch);
  };

  // Poll quickly while a sign-in or connection is under way: for two minutes
  // after an action, or until connected.
  const waiting = !!ts && (ts.state === 'starting' || (ts.state === 'needs-login' && (ts.loggingIn || !!ts.authUrl)));
  useEffect(() => setWaitingFor(waiting), [waiting]);
  useEffect(() => {
    if (!fast) return;
    if (ts?.state === 'running') return setFast(false);
    const t = setTimeout(() => setFast(false), 120_000);
    return () => clearTimeout(t);
  }, [fast, ts?.state]);

  if (!ts) {
    return q.error ? null : (
      <Card title="Tailscale">
        <Spinner />
      </Card>
    );
  }

  const current: TailscaleAccess = { share: ts.routes.length > 0, exitNode: ts.exitNode };
  const draft = access ?? current;
  const dirty = draft.share !== current.share || draft.exitNode !== current.exitNode;
  const tone =
    ts.state === 'running' ? 'ok' : ts.state === 'needs-login' || ts.state === 'starting' ? 'warn' : 'neutral';
  const label = {
    running: 'Connected',
    starting: 'Connecting',
    'needs-login': 'Not signed in',
    stopped: 'Disconnected',
    'daemon-down': 'Not running',
    'not-installed': 'Not installed',
  }[ts.state];
  const online = ts.peers.filter((p) => p.online).length;

  return (
    <Card
      title={
        <span class="inline-flex items-center gap-2">
          Tailscale
          <Pill tone={tone}>
            <Dot tone={tone} /> {label}
          </Pill>
        </span>
      }
      actions={
        ts.state === 'running' || ts.state === 'stopped' ? (
          <>
            {ts.state === 'running' ? (
              <Button onClick={() => void run(tailscaleDown)} disabled={busy}>
                Disconnect
              </Button>
            ) : (
              <Button onClick={() => void run(tailscaleUp, true)} disabled={busy}>
                Connect
              </Button>
            )}
            <Button onClick={() => void run(tailscaleLogout)} disabled={busy}>
              Sign Out
            </Button>
          </>
        ) : undefined
      }
    >
      {ts.state === 'not-installed' ? (
        <p class="text-muted">
          Reach your home network from anywhere, even when your internet provider shares its public address
          (carrier-grade NAT), with no port to open. Needs the <span class="font-mono text-xs">tailscale</span> package
          (about 26 MB of storage) and a Tailscale account.{' '}
          <Ext href="/cgi-bin/luci/admin/system/package-manager">Install it in LuCI</Ext>
        </p>
      ) : ts.state === 'needs-login' || ts.state === 'daemon-down' ? (
        <div class="space-y-3">
          <p class="text-muted">
            Reach your home network from your other devices, even behind carrier-grade NAT, with no port to open. Sign
            in with your Tailscale account (free for personal use).
          </p>
          {/* The zone comes first, so that once signed in the router can be reached. */}
          {ts.authUrl && hasTailscaleZone(network, firewall) ? (
            <div class="flex flex-wrap items-center gap-3">
              <a
                class="inline-flex h-8 items-center rounded-md border border-transparent bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover"
                href={ts.authUrl}
                target="_blank"
                rel="noreferrer"
              >
                Sign in to Tailscale
              </a>
              <span class="text-xs text-muted">This page updates once you have signed in.</span>
            </div>
          ) : ts.loggingIn || fast ? (
            <p class="inline-flex items-center gap-2 text-muted">
              <Spinner /> Getting a sign-in link…
            </p>
          ) : (
            <Button
              variant="primary"
              disabled={busy || apply.busy}
              onClick={() => withFirewall(current, tailscaleLogin, true)}
            >
              Connect
            </Button>
          )}
        </div>
      ) : ts.state === 'starting' ? (
        <p class="inline-flex items-center gap-2 text-muted">
          <Spinner /> Connecting…
        </p>
      ) : (
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label="This router"
              value={<span class="font-mono text-xs">{ts.ip ?? '—'}</span>}
              hint={ts.hostName}
            />
            <Stat label="Tailnet" value={ts.tailnet ?? '—'} />
            <Stat label="Devices online" value={`${online} of ${ts.peers.length}`} />
          </div>
          {ts.peers.length > 0 && (
            <Detail
              rows={ts.peers.map((p) => [
                <span class="inline-flex items-center gap-2">
                  <Dot tone={p.online ? 'ok' : 'neutral'} /> {p.name}
                </span>,
                <span class="font-mono text-xs">{p.ip ?? ''}</span>,
              ])}
            />
          )}
          {ts.state === 'running' && (
            <>
              <ToggleRow
                label="Share my home network"
                hint={`Devices in your tailnet can reach ${homeRoutes.join(', ') || 'your home network'}, not just the router.`}
                checked={draft.share}
                onChange={(share) => setAccess({ ...draft, share })}
              />
              <ToggleRow
                label="Use this router as an exit node"
                hint="Your devices can send all their internet traffic through home, e.g. on public WiFi."
                checked={draft.exitNode}
                onChange={(exitNode) => setAccess({ ...draft, exitNode })}
              />
              {dirty && (
                <div class="flex justify-end gap-2">
                  <Button onClick={() => setAccess(null)}>Reset</Button>
                  <Button
                    variant="primary"
                    disabled={busy || apply.busy}
                    onClick={() =>
                      withFirewall(draft, async () => {
                        await tailscaleSet(draft.share ? homeRoutes : [], draft.exitNode);
                        setAccess(null);
                      })
                    }
                  >
                    Apply Changes
                  </Button>
                </div>
              )}
              {(current.share || current.exitNode) && (
                <p class="text-xs text-muted">
                  Approve shared networks and the exit node for this router in the{' '}
                  <Ext href={ADMIN}>Tailscale admin console</Ext>.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {ts.health.length > 0 && ts.state !== 'not-installed' && (
        <ul class="mt-3 space-y-0.5 text-xs text-warn">
          {ts.health.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {error && (
        <div class="mt-3">
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        </div>
      )}
    </Card>
  );
}
