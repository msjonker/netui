import { useState } from 'preact/hooks';
import type { FirmwareControl } from '../api/useFirmware';
import { PHASE_LABEL } from '../model/firmware';
import { Modal } from './overlay';
import { AddonMissing } from './InstallAddon';
import { IconExternal } from './icons';
import { Banner, Button, Spinner } from './ui';

const branchOf = (v: string | undefined) => v?.split('.').slice(0, 2).join('.');

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Firmware version, update check and upgrade for one device. `what` names it
 * in the copy ("router", "access point"). `fullscreen` covers the page while
 * the device restarts, for the gateway the UI itself runs on.
 */
export function FirmwarePanel({
  fw,
  what,
  fullscreen,
  mac,
  where,
}: {
  fw: FirmwareControl;
  what: string;
  fullscreen?: boolean;
  /** An access point (its MAC and name), to install the update tool there. */
  mac?: string;
  where?: string;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const v = fw.view;

  if (fw.status.error && !fw.step) {
    return <p class="text-muted">Firmware updates are not available here: {errorText(fw.status.error)}</p>;
  }
  if (!v) return <Spinner />;
  if (!v.available) {
    return (
      <AddonMissing addon="firmware" mac={mac} where={where}>
        Update this {what}'s firmware from here, keeping its settings and add-ons.
      </AddonMissing>
    );
  }

  const step = fw.step ?? (v.upgrade ? { phase: v.upgrade.phase, detail: v.upgrade.detail } : null);
  const busy = !!step || v.checking;
  const c = v.check;
  const update = c?.verdict === 'update' ? c.to : undefined;
  const summary = v.checking
    ? 'Checking for updates…'
    : !c
      ? 'Not checked for updates yet.'
      : c.verdict === 'current'
        ? 'Up to date.'
        : c.verdict === 'update'
          ? c.to !== c.from
            ? `OpenWrt ${c.to} is available.`
            : `${c.outdated} package update${c.outdated === 1 ? '' : 's'} available.`
          : 'Cannot update right now.';
  const major = confirm && branchOf(confirm) !== branchOf(v.installed);
  const label = step ? (step.phase === 'restarting' ? 'Restarting' : PHASE_LABEL[step.phase]) : '';

  return (
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-4">
        <div>
          <div>OpenWrt {v.installed ?? '—'}</div>
          <div class="text-xs text-muted">{summary}</div>
        </div>
        <div class="flex shrink-0 gap-2">
          {update && !step && (
            <Button variant="primary" disabled={busy} onClick={() => setConfirm(update)}>
              Update
            </Button>
          )}
          <Button disabled={busy} onClick={() => void fw.check()}>
            {v.checking ? <Spinner /> : 'Check for updates'}
          </Button>
        </div>
      </div>

      {step && (
        <div role="status" class="flex items-start gap-2 rounded-md border border-line p-3">
          <Spinner class="mt-0.5 shrink-0" />
          <div>
            <div>
              {label}
              {step.detail && <span class="text-muted"> · {step.detail}</span>}
            </div>
            <div class="text-xs text-muted">
              The build server makes an image with this {what}'s packages, which takes a few minutes. It keeps working
              until the image installs, then restarts.
            </div>
          </div>
        </div>
      )}

      {c?.verdict === 'blocked' && !busy && (
        <Banner tone="bad" role="alert">
          {c.errors.join(' ')}
        </Banner>
      )}
      {fw.error && (
        <Banner tone="bad" role="alert">
          {fw.error}
        </Banner>
      )}
      {fw.outcome && (
        <Banner
          tone={fw.outcome.result === 'back' || fw.outcome.result === 'unchanged' ? 'ok' : 'bad'}
          role={fw.outcome.result === 'back' ? 'status' : 'alert'}
          actions={<Button onClick={fw.dismiss}>Dismiss</Button>}
        >
          {fw.outcome.result === 'back'
            ? `Firmware updated. The ${what} is running OpenWrt ${v.installed ?? ''}.`
            : fw.outcome.result === 'unchanged'
              ? 'There was nothing to update.'
              : fw.outcome.result === 'failed'
                ? `The update failed and nothing was installed: ${fw.outcome.errors.join(' ')}`
                : fw.outcome.result === 'timeout'
                  ? `The ${what} has not come back. Check its power and cables; it may still be flashing.`
                  : `The ${what} restarted. Sign in again to continue.`}
        </Banner>
      )}

      {v.newerRelease && !busy && (
        <p class="text-xs text-muted">
          OpenWrt {v.newerRelease} is out, a major release.{' '}
          <button type="button" class="text-accent hover:underline" onClick={() => setConfirm(v.newerRelease!)}>
            Upgrade to {v.newerRelease}
          </button>
        </p>
      )}

      {confirm && (
        <Modal
          title={`Update to OpenWrt ${confirm}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirm(null);
                  void fw.upgrade(confirm);
                }}
              >
                Update
              </Button>
            </>
          }
        >
          <div class="space-y-2 text-muted">
            <p>
              The OpenWrt build server makes a firmware image with the packages installed now. The {what} installs it and
              restarts, which takes about five minutes;{' '}
              {fullscreen ? 'every device loses its connection until it is back.' : 'its WiFi clients move to another access point or wait.'}
            </p>
            <p>Settings and netui are kept.{fullscreen && ' You will need to sign in again afterwards.'}</p>
            {major && (
              <Banner tone="warn" role="status">
                This is a major upgrade. Read the{' '}
                <a class="inline-flex items-center gap-1 text-accent hover:underline" href="https://openwrt.org/releases/start" target="_blank" rel="noreferrer">
                  release notes <IconExternal size={12} />
                </a>{' '}
                first: settings from older releases sometimes need changes.
              </Banner>
            )}
          </div>
        </Modal>
      )}

      {fullscreen && (step?.phase === 'installing' || step?.phase === 'restarting') && (
        <div role="alertdialog" aria-label="Updating firmware" class="fixed inset-0 z-50 flex items-center justify-center bg-bg/95">
          <div class="max-w-sm space-y-3 text-center">
            <Spinner class="size-8" />
            <h2 class="text-lg font-semibold">Updating firmware…</h2>
            <p class="text-muted">
              The {what} is installing the new firmware and restarting. This takes about five minutes. Do not unplug it.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
