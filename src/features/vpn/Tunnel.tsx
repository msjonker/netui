import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTunnel } from '../../api/tunnel';
import type { TunnelStatus } from '../../api/types';
import { getSession } from '../../api/ubus';
import { useApply } from '../../api/useApply';
import type { Subnet } from '../../model/network';
import { normalizeTunnel, parseTunnelToken, removeTunnelOps, tunnelOps, type TunnelState } from '../../model/tunnel';
import { IconExternal } from '../../components/icons';
import { AddonMissing } from '../../components/InstallAddon';
import { Banner, Button, Card, Dot, Field, Pill, Spinner, Stat } from '../../components/ui';
import { ConfirmModal } from './ServerForms';

const DASHBOARD = 'https://one.dash.cloudflare.com/';
/** How long after a confirmed change "not running" still means "starting". */
const STARTING_MS = 60_000;

function Ext({ href, children }: { href: string; children: string }) {
  return (
    <a class="inline-flex items-center gap-1 text-accent hover:underline" href={href} target="_blank" rel="noreferrer">
      {children} <IconExternal size={12} />
    </a>
  );
}

const LABEL: Record<TunnelState, string> = {
  'not-installed': 'Not installed',
  'not-set-up': 'Not set up',
  off: 'Off',
  connecting: 'Connecting',
  connected: 'Connected',
  failed: 'Not working',
};

const TONE = { connected: 'ok', connecting: 'warn', failed: 'bad' } as const;

/** Paste field for a tunnel's install command or token. */
function TokenForm({
  example,
  busy,
  action,
  onSubmit,
  onCancel,
}: {
  example: string;
  busy: boolean;
  action: string;
  onSubmit: (token: string) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parseTunnelToken(text), [text]);
  const error = touched && 'error' in parsed ? parsed.error : null;
  return (
    <form
      class="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if ('token' in parsed) onSubmit(parsed.token);
      }}
    >
      <Field
        label="Tunnel token"
        stacked
        error={error}
        hint={
          'token' in parsed ? (
            <>
              Tunnel <span class="font-mono">{parsed.tunnelId}</span>
            </>
          ) : (
            <>
              Paste the install command shown for the tunnel’s connector; netui keeps only the token. Then add a public
              hostname for each website or app, with the device’s address here, e.g.{' '}
              <span class="font-mono">{example}</span>.
            </>
          )
        }
      >
        {(id) => (
          <textarea
            id={id}
            rows={3}
            class="input font-mono text-xs break-all"
            spellcheck={false}
            autocomplete="off"
            placeholder="cloudflared service install eyJhIjoi…"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
            onBlur={() => text && setTouched(true)}
          />
        )}
      </Field>
      <div class="flex justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={busy}>
          {action}
        </Button>
      </div>
    </form>
  );
}

/** Publish websites and apps at home under your own domain, with no open port. */
export function TunnelCard({ subnets }: { subnets: Subnet[] }) {
  const apply = useApply();
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const starting = now - startedAt < STARTING_MS;
  const q = useTunnel(starting ? 2_000 : 15_000);
  const t = useMemo(() => normalizeTunnel(q.data), [q.data]);
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const readOnly = !!getSession()?.readOnly;

  // Re-render while starting so the window closes on time.
  useEffect(() => {
    if (!starting) return;
    const i = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(i);
  }, [starting]);
  // Connected: back to the slow poll.
  useEffect(() => {
    if (t?.state === 'connected') setStartedAt(0);
  }, [t?.state]);

  if (!t || !q.data) {
    return q.error ? null : (
      <Card title="Cloudflare Tunnel">
        <Spinner />
      </Card>
    );
  }
  const status: TunnelStatus = q.data;

  const lan = subnets.find((s) => s.network === 'lan') ?? subnets[0];
  const example = `http://${lan ? lan.address.replace(/\.\d+$/, '.20') : '192.168.1.20'}:8080`;

  const change = (enabled: boolean, token?: string) => {
    setChanging(false);
    void apply.start(tunnelOps(status, enabled, token), {
      onConfirmed: () => {
        setNow(Date.now());
        setStartedAt(enabled ? Date.now() : 0);
      },
    });
  };

  // Right after a change, a tunnel that is not up yet is starting, not failed.
  const state: TunnelState = t.state === 'failed' && starting && !t.detail ? 'connecting' : t.state;
  const tone = TONE[state as keyof typeof TONE] ?? 'neutral';
  const configured = state !== 'not-installed' && state !== 'not-set-up';

  return (
    <Card
      title={
        <span class="inline-flex items-center gap-2">
          Cloudflare Tunnel
          {state !== 'not-installed' && (
            <Pill tone={tone}>
              <Dot tone={tone} /> {LABEL[state]}
            </Pill>
          )}
        </span>
      }
      actions={
        configured && !readOnly ? (
          <>
            {t.enabled ? (
              <Button onClick={() => change(false)} disabled={apply.busy}>
                Turn Off
              </Button>
            ) : (
              <Button onClick={() => change(true)} disabled={apply.busy}>
                Turn On
              </Button>
            )}
            {!t.configFile && (
              <>
                <Button onClick={() => setChanging(true)} disabled={apply.busy || changing}>
                  Change Token
                </Button>
                <Button onClick={() => setRemoving(true)} disabled={apply.busy}>
                  Remove
                </Button>
              </>
            )}
          </>
        ) : undefined
      }
    >
      {state === 'not-installed' ? (
        <AddonMissing addon="tunnel">
          Publish a website or app from home under your own domain, with no port to open, even when your internet
          provider shares its public address (carrier-grade NAT). Needs about 25 MB of storage and a Cloudflare account.
        </AddonMissing>
      ) : state === 'not-set-up' ? (
        <div class="space-y-3">
          <p class="text-muted">
            Publish a website or app from home under your own domain, with no port to open. Create a tunnel in the{' '}
            <Ext href={DASHBOARD}>Cloudflare dashboard</Ext> (Networks → Tunnels), choose its connector, and copy the
            install command it shows.
          </p>
          {!readOnly && <TokenForm example={example} busy={apply.busy} action="Connect" onSubmit={(tk) => change(true, tk)} />}
        </div>
      ) : (
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label="Connections"
              value={state === 'connected' ? t.connections : '—'}
              hint={state === 'connected' && t.locations.length ? t.locations.join(', ') : undefined}
            />
            <Stat
              label="Tunnel"
              value={<span class="font-mono text-xs">{t.tunnelId ?? (t.configFile ? 'From config.yml' : '—')}</span>}
            />
          </div>
          {state === 'connecting' && (
            <p class="inline-flex items-center gap-2 text-muted">
              <Spinner /> Connecting…
            </p>
          )}
          {state === 'failed' && t.problem && (
            <Banner tone="bad" role="alert">
              {t.problem}
              {t.detail && t.detail !== t.problem && <span class="mt-1 block font-mono text-xs opacity-80">{t.detail}</span>}
            </Banner>
          )}
          {changing && (
            <TokenForm
              example={example}
              busy={apply.busy}
              action="Save Token"
              onSubmit={(tk) => change(t.enabled, tk)}
              onCancel={() => setChanging(false)}
            />
          )}
          {t.configFile ? (
            <p class="text-xs text-muted">
              This tunnel runs from a configuration file set up outside netui (
              <span class="font-mono">/etc/cloudflared/config.yml</span>).
            </p>
          ) : (
            <p class="text-xs text-muted">
              Choose what each public hostname leads to on the tunnel’s page in the{' '}
              <Ext href={DASHBOARD}>Cloudflare dashboard</Ext>, e.g. <span class="font-mono">{example}</span>. Anyone
              on the internet can open a published hostname: protect anything private, this router’s pages included,
              with an Access policy.
            </p>
          )}
        </div>
      )}
      {removing && (
        <ConfirmModal
          title="Remove the tunnel from this router?"
          action="Remove"
          onClose={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            void apply.start(removeTunnelOps(status));
          }}
        >
          <p class="text-muted">
            The router stops running it and forgets its token. The tunnel stays in your Cloudflare account: delete it
            there if you no longer need it.
          </p>
        </ConfirmModal>
      )}
    </Card>
  );
}
