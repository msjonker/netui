import type { ComponentChildren } from 'preact';
import { Button, Spinner } from '../../components/ui';
import type { RebootPhase } from './reboot';

export const PHASE_TEXT: Record<RebootPhase, string> = {
  stopping: 'Shutting down…',
  starting: 'Starting up. This usually takes one to two minutes.',
  checking: 'Almost there…',
};

/** Covers the page while the router restarts; `timedOut` swaps the spinner for a reload button. */
export function BusyOverlay({ label, title, children, timedOut }: { label: string; title: string; children: ComponentChildren; timedOut?: boolean }) {
  return (
    <div role="alertdialog" aria-label={label} class="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-4">
      <div class="max-w-sm space-y-3 text-center">
        {timedOut ? (
          <>
            <h2 class="text-lg font-semibold">The router has not come back</h2>
            <p class="text-muted">It has been five minutes. Check its power and cables, then reload this page.</p>
            <Button variant="primary" onClick={() => location.reload()}>
              Reload
            </Button>
          </>
        ) : (
          <>
            <Spinner class="size-8" />
            <h2 class="text-lg font-semibold">{title}</h2>
            <p class="text-muted">{children}</p>
          </>
        )}
      </div>
    </div>
  );
}
