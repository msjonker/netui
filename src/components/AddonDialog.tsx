import { useLayoutEffect, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { addonJob, packagesKey, usePackages } from '../api/packages';
import type { AddonKey } from '../api/types';
import { ADDONS, fits, jobError, jobStep } from '../model/addons';
import { Modal } from './overlay';
import { Banner, Button, Spinner } from './ui';

const mb = (kib: number) => (kib < 10 * 1024 ? `${(kib / 1024).toFixed(1)} MB` : `${Math.round(kib / 1024)} MB`);

/**
 * Install or remove one add-on: what it is and what it needs, then the
 * router's progress, then the result. A finished install re-reads everything
 * so the feature appears where the user clicked.
 */
export function AddonDialog({
  addon,
  action = 'install',
  mac,
  where,
  onClose,
}: {
  addon: AddonKey;
  action?: 'install' | 'remove';
  /** An adopted access point; the gateway without. */
  mac?: string;
  /** Shown in the title for an access point. */
  where?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const status = usePackages(mac);
  const info = ADDONS[addon];
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = status.data?.job;
  const mine = started && job?.addon === addon && job.action === action ? job : undefined;
  const done = !!mine && !mine.running && mine.exit === 0;
  const failed = !!mine && !mine.running && mine.exit !== null && mine.exit !== 0;
  const busy = started && !done && !failed && !error;

  // Layout effect: Preact runs plain effects a frame later, and a quick Close
  // would unmount the dialog before the refresh starts.
  useLayoutEffect(() => {
    if (done) void qc.invalidateQueries();
  }, [done]);

  const start = async () => {
    setError(null);
    try {
      await addonJob(action, addon, mac);
      setStarted(true);
      await qc.invalidateQueries({ queryKey: packagesKey(mac) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const free = status.data?.free;
  const verb = action === 'install' ? 'Install' : 'Remove';
  // The router checks again before it installs anything; this says so up front.
  const noRoom = action === 'install' && !started && !fits(info, free);
  return (
    <Modal
      title={`${verb} ${info.label}${where ? ` on ${where}` : ''}?`}
      locked={busy}
      onClose={onClose}
      footer={
        started && !error ? (
          <Button variant="primary" disabled={busy} onClick={onClose}>
            {busy ? 'Working…' : 'Close'}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant={action === 'install' ? 'primary' : 'danger'} disabled={noRoom} onClick={() => void start()}>
              {verb}
            </Button>
          </>
        )
      }
    >
      <div class="space-y-3">
        {!started || error ? (
          <>
            <p class="text-muted">{info.description}</p>
            {action === 'install' ? (
              <p class="text-muted">
                Needs {info.mb < 1 ? 'less than 1 MB' : `about ${info.mb} MB`} of storage
                {free != null && `; ${mb(free)} free`}. The router downloads it from the OpenWrt package servers, so it
                needs to be online.
              </p>
            ) : (
              <p class="text-muted">Its settings stay on the router, so installing it again brings them back.</p>
            )}
            {noRoom ? (
              <Banner tone="bad" role="alert">
                Not enough storage: {info.label} needs about {info.minMb ?? info.mb} MB plus 1 MB to spare, and{' '}
                {where ?? 'this router'} has {mb(free!)} free. Removing an add-on you do not use makes room.
              </Banner>
            ) : (
              action === 'install' &&
              info.note && (
                <Banner tone="warn" role="status">
                  {info.note}
                </Banner>
              )
            )}
          </>
        ) : busy ? (
          <p role="status" class="flex items-center gap-2">
            <Spinner /> {mine ? jobStep(mine) : 'Starting'}…
          </p>
        ) : done ? (
          <Banner tone="ok" role="status">
            {action === 'install' ? `${info.label} is installed.` : `${info.label} is removed.`}
            {action === 'install' && info.note && addon === 'wireguard' && ` ${info.note}`}
          </Banner>
        ) : (
          <Banner tone="bad" role="alert">
            {jobError(mine!)}
          </Banner>
        )}
        {error && (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        )}
      </div>
    </Modal>
  );
}
