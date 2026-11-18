import { useMemo } from 'preact/hooks';
import { useAdblockStatus, useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { adblockDraft, adblockOps, readAdblock, validateAdblock, DEFAULT_LIST, type AdblockDraft } from '../../model/adblock';
import { formatBytes } from '../../lib/format';
import { useDraft } from '../../lib/useDraft';
import { Banner, Button, Card, Dot, Field, Spinner, ToggleRow } from '../../components/ui';
import { PLAN } from './shared';
import { AddonCard } from '../../components/InstallAddon';

/** `on`: the saved setting, which the running apply is carrying out. */
function StatusLine({ on }: { on: boolean }) {
  const s = useAdblockStatus().data;
  if (!s?.installed) return null;
  if (s.busy) {
    return (
      <span role="status" class="inline-flex items-center gap-2 text-muted">
        <Spinner /> {on ? 'Downloading the lists and starting…' : 'Stopping…'}
      </span>
    );
  }
  if (s.status === 'statusSuccess' && s.entries != null) {
    return (
      <span class="inline-flex items-center gap-1.5">
        <Dot tone="ok" /> Blocking {s.entries.toLocaleString()} domains
      </span>
    );
  }
  if (s.errors?.length || s.status === 'statusError' || s.status === 'statusFail') {
    return (
      <span class="inline-flex items-center gap-1.5 text-bad">
        <Dot tone="bad" /> {s.message || s.errors?.map((e) => e.info ?? e.code).join(', ') || 'Not working'}
      </span>
    );
  }
  return (
    <span class="inline-flex items-center gap-1.5 text-muted">
      <Dot tone="neutral" /> Off
    </span>
  );
}

/**
 * adblock-fast, network-wide: the router's DNS answers "no such domain" for
 * ads, trackers and malware hosts on the chosen lists. Applying goes through
 * the apply flow; the lists then download in the background.
 */
export function AdBlockingCard({ filtered }: { filtered: boolean }) {
  const apply = useApply();
  const cfg = useUci('adblock-fast');
  const source = useMemo(() => (cfg.data ? adblockDraft(readAdblock(cfg.data)) : undefined), [cfg.data]);
  const { draft, dirty, reset, update } = useDraft<AdblockDraft | undefined>(source);

  if (cfg.isPending) return null;
  if (!cfg.data) {
    return (
      <AddonCard addon="adblock" title="Ad blocking">Block ads and trackers for every device, without apps on them.</AddonCard>
    );
  }
  // The draft follows a render later: not "not installed", just not ready.
  if (!draft) return null;
  const a = readAdblock(cfg.data);
  const errors = validateAdblock(draft);
  const valid = Object.keys(errors).length === 0;
  const total = a.lists.filter((l) => draft.lists.includes(l.section)).reduce((n, l) => n + l.size, 0);
  const toggle = (section: string, on: boolean) =>
    update({ lists: on ? [...draft.lists, section] : draft.lists.filter((s) => s !== section) });

  return (
    <Card title="Ad blocking" actions={<StatusLine on={a.enabled} />}>
      <ToggleRow
        label="Block ads and trackers"
        hint="For every device on your networks, through the router's DNS. Devices set to their own DNS, and apps using DNS over HTTPS, are not covered."
        checked={draft.enabled}
        disabled={apply.busy}
        onChange={(enabled) => update({ enabled })}
      />
      {draft.enabled && (
        <>
          <Field label="Block lists" stacked error={errors.lists} hint={`About ${formatBytes(total)} to download; the router keeps the lists in memory. ${DEFAULT_LIST} is a good start.`}>
            {() => (
              <div class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-2" role="group" aria-label="Block lists">
                {a.lists.map((l) => (
                  <label key={l.section} class="flex cursor-pointer items-center justify-between gap-3 py-0.5">
                    <span class="inline-flex min-w-0 items-center gap-2">
                      <input type="checkbox" checked={draft.lists.includes(l.section)} onChange={(e) => toggle(l.section, e.currentTarget.checked)} />
                      <span class="truncate">{l.name}</span>
                    </span>
                    <span class="shrink-0 text-xs text-muted tabular-nums">{formatBytes(l.size)}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>
          <div class="grid gap-x-4 sm:grid-cols-2">
            <Field label="Never block" stacked error={errors.allowed} hint="One domain per line, e.g. a shop a list breaks.">
              {(id) => <textarea id={id} rows={3} class="input font-mono" value={draft.allowed} onInput={(e) => update({ allowed: e.currentTarget.value })} />}
            </Field>
            <Field label="Also block" stacked error={errors.blocked} hint="One domain per line.">
              {(id) => <textarea id={id} rows={3} class="input font-mono" value={draft.blocked} onInput={(e) => update({ blocked: e.currentTarget.value })} />}
            </Field>
          </div>
          {filtered && (
            <Banner tone="warn" role="status">
              Networks with content filtering keep using Cloudflare's filter and are not ad-blocked. Other networks are, but
              devices there can then bypass the router's DNS.
            </Banner>
          )}
        </>
      )}
      {dirty && (
        <div class="flex justify-end gap-2 pt-3">
          <Button onClick={reset} disabled={apply.busy}>
            Reset
          </Button>
          <Button variant="primary" disabled={apply.busy || !valid} onClick={() => void apply.start(adblockOps(draft, cfg.data!, filtered), PLAN)}>
            Apply Changes
          </Button>
        </div>
      )}
    </Card>
  );
}
