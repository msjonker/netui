import { useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { AddonKey } from '../api/types';
import { getSession } from '../api/ubus';
import { Button, Card, Dot, Pill } from './ui';

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

/** The status pill of a feature whose package is missing. */
export function NotInstalled({ label = 'Not installed' }: { label?: string }) {
  return (
    <Pill tone="neutral">
      <Dot tone="neutral" /> {label}
    </Pill>
  );
}

/** A card title with a status pill next to it. */
export function TitleWithPill({ title, pill }: { title: preact.ComponentChildren; pill: preact.ComponentChildren }) {
  return (
    <span class="inline-flex items-center gap-2">
      {title}
      {pill}
    </span>
  );
}

/**
 * A feature's card while its package is missing: its title marked "Not
 * installed", what it does, and Install. Every add-on card looks like this
 * until it is installed.
 */
export function AddonCard({
  addon,
  title,
  mac,
  where,
  children,
}: {
  addon: AddonKey;
  title: string;
  mac?: string;
  where?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <Card title={<TitleWithPill title={title} pill={<NotInstalled />} />}>
      <AddonMissing addon={addon} mac={mac} where={where}>
        {children}
      </AddonMissing>
    </Card>
  );
}
