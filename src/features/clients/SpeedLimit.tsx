import { useMemo } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import type { Client } from '../../model/clients';
import { hardwareOffload, limitOps, validateLimit, type LimitDraft } from '../../model/speedLimit';
import { useDraft } from '../../lib/useDraft';
import { Banner, Button, Field, FormSection } from '../../components/ui';

/** Download and upload limits for one device, in Mbit/s. */
export function SpeedLimit({ c, name, fw, returnTo }: { c: Client; name: string; fw: UciConfig; returnTo: string }) {
  const apply = useApply();
  const source = useMemo<LimitDraft>(() => ({ download: c.limit?.download ?? '', upload: c.limit?.upload ?? '' }), [c.limit]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  if (!draft) return null;
  const error = validateLimit(draft);
  const limited = !!(c.limit?.download || c.limit?.upload);

  const rate = (label: string, key: keyof LimitDraft) => (
    <Field label={`${label} (Mbit/s)`} stacked>
      {(id) => (
        <input
          id={id}
          class="input w-32"
          inputMode="decimal"
          placeholder="No limit"
          value={draft[key]}
          onInput={(e) => update({ [key]: e.currentTarget.value.trim() })}
        />
      )}
    </Field>
  );

  return (
    <FormSection title="Speed limit">
      <p class="pt-1 text-xs text-muted">
        Caps this device's internet speed. Traffic to other devices on the same network is not limited.
      </p>
      {hardwareOffload(fw) && (
        <div class="my-2">
          <Banner tone="warn">Hardware flow offloading is on: traffic it handles skips speed limits.</Banner>
        </div>
      )}
      {stale && (
        <div class="my-2">
          <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
            This device's speed limit changed on the router.
          </Banner>
        </div>
      )}
      <div class="flex flex-wrap gap-x-6">
        {rate('Download', 'download')}
        {rate('Upload', 'upload')}
      </div>
      {dirty && error && (
        <p class="py-1 text-xs text-bad" role="alert">
          {error}
        </p>
      )}
      <div class="flex justify-end gap-2 py-3">
        {limited && (
          <Button
            class="mr-auto"
            disabled={apply.busy}
            onClick={() => apply.start(limitOps(fw, c.mac, name, { download: '', upload: '' }), { returnTo })}
          >
            Remove Limit
          </Button>
        )}
        <Button onClick={reset} disabled={!dirty || apply.busy}>
          Reset
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || !!error || apply.busy}
          onClick={() => apply.start(limitOps(fw, c.mac, name, draft), { returnTo })}
        >
          Apply Limit
        </Button>
      </div>
    </FormSection>
  );
}
