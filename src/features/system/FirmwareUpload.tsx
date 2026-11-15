import { useRef, useState } from 'preact/hooks';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { flashImage, uploadImage, type ImageCheck } from '../../api/firmware';
import { expireSession } from '../../api/ubus';
import { formatBytes } from '../../lib/format';
import { Modal } from '../../components/overlay';
import { Banner, Button, Detail, Spinner } from '../../components/ui';
import { BusyOverlay, PHASE_TEXT } from './BusyOverlay';
import { rebootDeps, waitForRestart, type RebootPhase } from './reboot';

/** Flashing writes the image before the restart: allow far longer than a plain restart. */
const FLASH_WAIT_MS = 15 * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Install a firmware image file by hand, for when the online update cannot
 * help (no internet, a model the build service does not cover, a specific
 * version). Settings are kept.
 */
export function FirmwareUpload({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<ImageCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'flashing' | RebootPhase | 'timeout' | null>(null);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setCheck(null);
    setError(null);
    setBusy(true);
    try {
      setCheck(await uploadImage(f));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const install = async () => {
    setError(null);
    setPhase('flashing');
    onlineManager.setOnline(false);
    try {
      await flashImage();
      const r = await waitForRestart(rebootDeps, (p) => setPhase(p === 'stopping' ? 'flashing' : p), FLASH_WAIT_MS);
      if (r === 'timeout') return setPhase('timeout');
      setPhase(null);
      expireSession('The firmware was installed and the router restarted. Sign in again to continue.');
    } catch (e) {
      setPhase(null);
      setError(message(e));
    } finally {
      onlineManager.setOnline(true);
      void qc.invalidateQueries();
    }
  };

  if (phase) {
    return (
      <BusyOverlay label="Installing firmware" title="Installing firmware…" timedOut={phase === 'timeout'}>
        {phase === 'flashing'
          ? 'Writing the new firmware. Do not unplug the router: this takes a few minutes.'
          : phase !== 'timeout' && PHASE_TEXT[phase]}
      </BusyOverlay>
    );
  }

  const ok = !!check?.valid;
  return (
    <Modal
      title="Install a firmware file"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!ok || busy} onClick={() => void install()}>
            Install and Restart
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <p class="text-muted">
          For when the online update cannot help: the router has no internet, or you need a particular version. Download
          the <em>sysupgrade</em> image for this model from{' '}
          <a class="text-accent hover:underline" href="https://firmware-selector.openwrt.org/" target="_blank" rel="noreferrer">
            firmware-selector.openwrt.org
          </a>
          . Your settings are kept.
        </p>
        <div class="flex items-center gap-3">
          <Button disabled={busy} onClick={() => input.current?.click()}>
            {file ? 'Choose Another File…' : 'Choose File…'}
          </Button>
          {busy && (
            <span class="inline-flex items-center gap-2 text-muted">
              <Spinner /> Uploading and checking…
            </span>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept=".bin,.img,.itb,.gz"
          class="hidden"
          aria-label="Firmware file"
          onChange={(e) => void choose(e.currentTarget.files?.[0])}
        />
        {check && file && (
          <>
            <Detail
              rows={[
                ['File', file.name],
                ['Size', formatBytes(check.size)],
                ['SHA-256', check.sha256 && <span class="font-mono text-xs break-all">{check.sha256}</span>],
              ]}
            />
            <p class="text-xs text-muted">Compare the SHA-256 with the one on the download page before installing.</p>
            {ok ? (
              <Banner tone="ok" role="status">
                The router checked the image: it is made for this model.
              </Banner>
            ) : (
              <Banner tone="bad" role="alert">
                {check.deviceMatch
                  ? 'The router cannot use this file: it is damaged or not a sysupgrade image.'
                  : 'This image is for a different model, or damaged. Installing it could make the router unusable.'}
              </Banner>
            )}
          </>
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
