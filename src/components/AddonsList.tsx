import { useState } from 'preact/hooks';
import { usePackages } from '../api/packages';
import type { AddonKey } from '../api/types';
import { getSession } from '../api/ubus';
import { ADDONS } from '../model/addons';
import { AddonDialog } from './AddonDialog';
import { Button, Pill, Spinner } from './ui';

/** Never offered for removal: netui would break (mesh) or lose its updates. */
const KEEP: AddonKey[] = ['mesh'];

/**
 * Every optional feature and whether its package is installed, with Install
 * and Remove. `only` limits the list (access points need just a few).
 */
export function AddonsList({ mac, where, only }: { mac?: string; where?: string; only?: AddonKey[] }) {
  const status = usePackages(mac);
  const [open, setOpen] = useState<{ addon: AddonKey; action: 'install' | 'remove' } | null>(null);
  const readOnly = !!getSession()?.readOnly;
  if (status.error) return <p class="text-muted">Add-ons cannot be managed here: this router's netui is older than this page.</p>;
  if (!status.data) return <Spinner />;
  const keys = (only ?? (Object.keys(ADDONS) as AddonKey[])).filter((k) => status.data!.addons[k]);
  return (
    <>
      <ul class="divide-y divide-line" aria-label="Add-ons">
        {keys.map((k) => {
          const installed = status.data!.addons[k]!.installed;
          return (
            <li key={k} class="flex items-center gap-3 py-2">
              <div class="min-w-0 flex-1">
                <div>{ADDONS[k].label}</div>
                <div class="text-xs text-muted">{ADDONS[k].description}</div>
              </div>
              {installed ? (
                <>
                  <Pill tone="ok">Installed</Pill>
                  {!readOnly && !KEEP.includes(k) && (
                    <Button onClick={() => setOpen({ addon: k, action: 'remove' })} aria-label={`Remove ${ADDONS[k].label}`}>
                      Remove
                    </Button>
                  )}
                </>
              ) : (
                !readOnly && (
                  <Button onClick={() => setOpen({ addon: k, action: 'install' })} aria-label={`Install ${ADDONS[k].label}`}>
                    Install
                  </Button>
                )
              )}
            </li>
          );
        })}
      </ul>
      {open && <AddonDialog addon={open.addon} action={open.action} mac={mac} where={where} onClose={() => setOpen(null)} />}
    </>
  );
}
