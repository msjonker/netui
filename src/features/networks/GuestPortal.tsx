import { useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { internetKeys, usePortalStatus, useUci } from '../../api/queries';
import { call } from '../../api/ubus';
import { useApply } from '../../api/useApply';
import type { PortalClient } from '../../api/types';
import { displayName } from '../../model/clients';
import { useClients } from '../../model/hooks';
import { networkLabel, type Network } from '../../model/network';
import { portalDraft, portalOps, readPortal, sessionLabel, validatePortal, SESSION_CHOICES, type PortalDraft } from '../../model/portal';
import { formatBytes, formatDuration } from '../../lib/format';
import { useDraft } from '../../lib/useDraft';
import { Banner, Button, Card, Dot, Empty, Field, Spinner, ToggleRow } from '../../components/ui';
import { AddonCard } from '../../components/InstallAddon';

const PLAN = { returnTo: '/settings/networks' };

function Guests({ clients }: { clients: PortalClient[] }) {
  const qc = useQueryClient();
  const known = useClients().clients;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (mac: string, method: 'portal_auth' | 'portal_deauth') => {
    setBusy(mac);
    setError(null);
    try {
      const r = await call<{ error?: string }>('netui.services', method, { mac });
      if (r?.error) throw new Error(r.error);
      await qc.invalidateQueries({ queryKey: internetKeys.portal });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  if (!clients.length) return <Empty>No guests yet.</Empty>;
  const now = Date.now() / 1000;
  return (
    <div class="space-y-2">
      {error && (
        <Banner tone="bad" role="alert">
          {error}
        </Banner>
      )}
      <div class="overflow-x-auto">
        <table class="table" aria-label="Guests">
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th>Time left</th>
              <th>Data</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((g) => {
              const c = known.find((k) => k.mac.toLowerCase() === g.mac);
              const signedIn = g.state === 'Authenticated';
              return (
                <tr key={g.mac}>
                  <td>
                    <div>{c ? displayName(c) : g.ip ?? g.mac}</div>
                    <div class="font-mono text-xs text-muted">{g.mac}</div>
                  </td>
                  <td>
                    <span class="inline-flex items-center gap-1.5">
                      <Dot tone={signedIn ? 'ok' : 'warn'} /> {signedIn ? 'Signed in' : 'At the portal'}
                    </span>
                  </td>
                  <td class="tabular-nums">{signedIn && g.session_end ? formatDuration(Math.max(0, g.session_end - now)) : '—'}</td>
                  <td class="text-xs text-muted tabular-nums">
                    {signedIn ? `↓ ${formatBytes((g.download ?? 0) * 1024)} ↑ ${formatBytes((g.upload ?? 0) * 1024)}` : '—'}
                  </td>
                  <td class="text-right">
                    <Button disabled={busy === g.mac} onClick={() => void act(g.mac, signedIn ? 'portal_deauth' : 'portal_auth')}>
                      {signedIn ? 'Sign out' : 'Let in'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * openNDS on one network: guests see a sign-in page before they get
 * internet. The settings go through the apply flow; the plugin then restarts
 * or stops openNDS.
 */
export function GuestPortalCard({ networks }: { networks: Network[] }) {
  const apply = useApply();
  const cfg = useUci('opennds');
  const status = usePortalStatus(!!cfg.data);
  const portal = useMemo(() => (cfg.data ? readPortal(cfg.data, networks) : undefined), [cfg.data, networks]);
  const source = useMemo(() => (portal ? portalDraft(portal, networks) : undefined), [portal, networks]);
  const { draft, dirty, reset, update } = useDraft<PortalDraft | undefined>(source);

  if (cfg.isPending) return null;
  if (!cfg.data) {
    return (
      <AddonCard addon="portal" title="Guest portal">Show guests a sign-in page before they get internet.</AddonCard>
    );
  }
  // The draft follows a render later: not "not installed", just not ready.
  if (!draft || !portal) return null;
  const errors = validatePortal(draft);
  const valid = Object.keys(errors).length === 0;
  const s = status.data;
  const state = s?.busy ? (
    <span role="status" class="inline-flex items-center gap-2 text-muted">
      <Spinner /> Applying…
    </span>
  ) : s?.running ? (
    <span class="inline-flex items-center gap-1.5">
      <Dot tone="ok" /> On {portal.network ? networkLabel(portal.network) : ''}
    </span>
  ) : (
    <span class="inline-flex items-center gap-1.5 text-muted">
      <Dot tone="neutral" /> Off
    </span>
  );

  return (
    <Card title="Guest portal" actions={state}>
      <ToggleRow
        label="Show guests a sign-in page"
        hint="Devices on the chosen network get internet only after they accept the portal, like hotel WiFi. They can always reach the router itself."
        checked={draft.enabled}
        disabled={apply.busy}
        onChange={(enabled) => update({ enabled })}
      />
      {draft.enabled && (
        <div class="grid gap-x-4 sm:grid-cols-2">
          <Field label="Network" stacked error={errors.network}>
            {(id) => (
              <select id={id} class="input" value={draft.network} onChange={(e) => update({ network: e.currentTarget.value })}>
                {networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {networkLabel(n.id)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Portal name" stacked error={errors.name} hint="Shown on the sign-in page.">
            {(id) => <input id={id} class="input" value={draft.name} maxLength={64} onInput={(e) => update({ name: e.currentTarget.value })} />}
          </Field>
          <Field label="Sign-in" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.login} onChange={(e) => update({ login: e.currentTarget.value as PortalDraft['login'] })}>
                <option value="click">Click to continue</option>
                <option value="email">Name and email address</option>
              </select>
            )}
          </Field>
          <Field label="Session length" stacked hint="Guests sign in again after this.">
            {(id) => (
              <select id={id} class="input" value={String(draft.sessionMinutes)} onChange={(e) => update({ sessionMinutes: Number(e.currentTarget.value) })}>
                {SESSION_CHOICES.map((m) => (
                  <option key={m} value={String(m)}>
                    {sessionLabel(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Download limit (Mbit/s)" stacked error={errors.downMbps} hint="Per guest. Empty for no limit.">
            {(id) => <input id={id} class="input" inputMode="decimal" value={draft.downMbps} onInput={(e) => update({ downMbps: e.currentTarget.value })} />}
          </Field>
          <Field label="Upload limit (Mbit/s)" stacked error={errors.upMbps} hint="Per guest. Empty for no limit.">
            {(id) => <input id={id} class="input" inputMode="decimal" value={draft.upMbps} onInput={(e) => update({ upMbps: e.currentTarget.value })} />}
          </Field>
        </div>
      )}
      {draft.enabled && draft.network === 'lan' && (
        <Banner tone="warn" role="status">
          Every device on the LAN, including this computer and your own phones, would have to sign in. Use a separate guest
          network.
        </Banner>
      )}
      {dirty && (
        <div class="flex justify-end gap-2 pt-3">
          <Button onClick={reset} disabled={apply.busy}>
            Reset
          </Button>
          <Button variant="primary" disabled={apply.busy || !valid} onClick={() => void apply.start(portalOps(draft, cfg.data!, networks), PLAN)}>
            Apply Changes
          </Button>
        </div>
      )}
      {s?.running && (
        <div class="mt-3 border-t border-line pt-3">
          <h3 class="pb-2 text-xs font-semibold tracking-wide text-muted uppercase">Guests</h3>
          <Guests clients={s.clients ?? []} />
        </div>
      )}
    </Card>
  );
}
