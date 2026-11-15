import { useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { AddonKey } from '../api/types';
import { getSession } from '../api/ubus';
import { Button } from './ui';

const AddonDialog = lazy(() => import('./AddonDialog').then((m) => ({ default: m.AddonDialog })));

/** "Install" next to a feature whose package is missing. Read-only users do not get it. */
export function InstallAddon({ addon, mac, where }: { addon: AddonKey; mac?: string; where?: string }) {
  const [open, setOpen] = useState(false);
  if (getSession()?.readOnly) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>Install</Button>
      {open && (
        <Suspense fallback={null}>
          <AddonDialog addon={addon} mac={mac} where={where} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

/** A missing feature's one-line pitch with its Install button. */
export function AddonMissing({ addon, mac, where, children }: { addon: AddonKey; mac?: string; where?: string; children: preact.ComponentChildren }) {
  return (
    <div class="flex flex-wrap items-center gap-4">
      <p class="min-w-0 flex-1 text-muted">{children}</p>
      <InstallAddon addon={addon} mac={mac} where={where} />
    </div>
  );
}
