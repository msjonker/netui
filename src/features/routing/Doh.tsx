import { useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import type { UciConfig } from '../../api/types';
import { keys, useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { switchDoh } from '../../api/services';
import { DOH_PROVIDERS, dohDraft, dohOps, dohSwitch, normalizeDoh, validateDoh, type DohDraft } from '../../model/doh';
import { useDraft } from '../../lib/useDraft';
import { Banner, Button, Card, Dot, Field, Pill, Spinner, ToggleRow } from '../../components/ui';
import { AddonMissing } from '../../components/InstallAddon';

const PLAN = { returnTo: '/settings/routing' };

/** DNS over HTTPS (https-dns-proxy). Without the package: what it does and how to get it. */
export function DohCard({ dhcp }: { dhcp: UciConfig }) {
  const cfg = useUci('https-dns-proxy');
  const apply = useApply();
  const doh = useMemo(() => (cfg.data ? normalizeDoh(cfg.data, dhcp) : undefined), [cfg.data, dhcp]);
  const source = useMemo(() => (doh ? dohDraft(doh) : undefined), [doh]);
  const { draft, dirty, stale, reset, update } = useDraft<DohDraft>(source);
  const qc = useQueryClient();
  const [switching, setSwitching] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();

  if (cfg.isPending) return null;
  if (!doh || !draft || !cfg.data) {
    return (
      <Card title="DNS over HTTPS">
        <AddonMissing addon="doh">Encrypts the router’s DNS lookups so your internet provider cannot see or change them.</AddonMissing>
      </Card>
    );
  }
  const errors = validateDoh(draft);
  const ops = dirty ? dohOps(draft, doh, cfg.data, dhcp) : [];
  const flip = dirty ? dohSwitch(draft, doh) : undefined;
  const valid = Object.keys(errors).length === 0;
  const busy = apply.busy || switching !== null;

  // Starting or stopping is not config: it follows a confirmed apply, or runs alone.
  const run = async (on: boolean) => {
    setSwitching(on);
    setError(undefined);
    try {
      await switchDoh(on);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(null);
      await qc.invalidateQueries({ queryKey: keys.uci('dhcp') });
    }
  };
  const submit = () => {
    if (ops.length) void apply.start(ops, { ...PLAN, onConfirmed: flip === undefined ? undefined : () => void run(flip) });
    else if (flip !== undefined) void run(flip);
  };

  return (
    <Card
      title={
        <span class="inline-flex items-center gap-2">
          DNS over HTTPS
          <Pill tone={doh.active ? 'ok' : 'neutral'}>
            <Dot tone={doh.active ? 'ok' : 'neutral'} /> {doh.active ? 'Active' : 'Off'}
          </Pill>
        </span>
      }
      actions={
        <>
          {dirty && (
            <Button onClick={reset} disabled={busy}>
              Reset
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!valid || (ops.length === 0 && flip === undefined) || busy}
            onClick={submit}
          >
            Apply Changes
          </Button>
        </>
      }
    >
      {stale && (
        <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
          These settings were changed on the router while you were editing.
        </Banner>
      )}
      {switching !== null && (
        <p class="inline-flex items-center gap-2 pb-2 text-xs text-muted" role="status">
          <Spinner class="size-3" /> {switching ? 'Starting' : 'Stopping'}… this takes a few seconds.
        </p>
      )}
      {error && (
        <p class="pb-2 text-xs text-bad" role="alert">
          {error}
        </p>
      )}
      <ToggleRow
        label="Encrypt DNS"
        hint="Names are looked up over an encrypted connection to the provider below, so your internet provider cannot see or change them. Devices that use their own DNS server are sent to the router instead."
        checked={draft.enabled}
        onChange={(enabled) => update({ enabled })}
      />
      {draft.enabled && (
        <>
          <Field label="Provider" stacked>
            {(id) => (
              <select
                id={id}
                class="input"
                value={draft.provider}
                onChange={(e) => update({ provider: e.currentTarget.value })}
              >
                {DOH_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom address</option>
              </select>
            )}
          </Field>
          {draft.provider === 'custom' && (
            <Field label="Address" stacked error={errors.customUrl}>
              {(id) => (
                <input
                  id={id}
                  class="input font-mono"
                  placeholder="https://dns.example/dns-query"
                  value={draft.customUrl}
                  onInput={(e) => update({ customUrl: e.currentTarget.value.trim() })}
                />
              )}
            </Field>
          )}
          {doh.urls.length > 1 && !dirty && (
            <p class="mt-2 text-xs text-muted">
              {doh.urls.length} providers are configured; choosing one here replaces them.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
