import { Banner, Button } from './ui';

/**
 * Sticky footer for an edited settings form. `error` blocks Apply
 * with an explanation; `stale` warns that the router changed underneath.
 */
export function ApplyBar({
  dirty,
  stale,
  error,
  busy,
  onReset,
  onApply,
}: {
  dirty: boolean;
  stale?: boolean;
  error?: string | null;
  busy?: boolean;
  onReset: () => void;
  onApply: () => void;
}) {
  if (!dirty && !stale) return null;
  return (
    <div class="sticky bottom-0 z-10 -mx-6 mt-4 border-t border-line bg-surface/95 px-6 py-3 backdrop-blur">
      {stale && (
        <div class="mb-3">
          <Banner tone="warn" role="status" actions={<Button onClick={onReset}>Load latest</Button>}>
            These settings were changed on the router (LuCI, ssh or another session) while you were editing.
          </Banner>
        </div>
      )}
      <div class="flex items-center justify-end gap-3">
        {error && <span class="mr-auto text-xs text-bad">{error}</span>}
        {!error && dirty && <span class="mr-auto text-xs text-muted">Unsaved changes</span>}
        <Button onClick={onReset} disabled={busy || !dirty}>
          Reset
        </Button>
        <Button variant="primary" onClick={onApply} disabled={busy || !dirty || !!error}>
          Apply Changes
        </Button>
      </div>
    </div>
  );
}
