import { useRef, useState } from 'preact/hooks';
import { onlineManager } from '@tanstack/react-query';
import { downloadBackup, restoreBackup } from '../../api/backup';
import { probeAddress } from '../../api/apply';
import { useInterfaces, useSystemBoard } from '../../api/queries';
import { call, expireSession, getSession, TransportError } from '../../api/ubus';
import { readBackup, type BackupInfo } from '../../model/backup';
import { Modal } from '../../components/overlay';
import { Banner, Button, Card, Detail } from '../../components/ui';
import { BusyOverlay, PHASE_TEXT } from './BusyOverlay';
import { rebootDeps, waitForRestart, type RebootPhase } from './reboot';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MOVE_WAIT_MS = 5 * 60_000;

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Waiting for the router at its new address; tests replace these. */
export const moveDeps = {
  probe: (address: string) => probeAddress(address),
  sleep: (ms: number) => rebootDeps.sleep(ms),
};

/** The router after a restore that moved it: wait until the new address answers, then go there. */
async function followTo(address: string): Promise<boolean> {
  await moveDeps.sleep(20_000);
  for (let waited = 20_000; waited < MOVE_WAIT_MS; waited += 3_000) {
    if (await moveDeps.probe(address)) {
      const host = address.includes(':') ? `[${address}]` : address;
      const loc = window.location;
      loc.assign(`${loc.protocol}//${host}${loc.port ? `:${loc.port}` : ''}${loc.pathname}`);
      return true;
    }
    await moveDeps.sleep(3_000);
  }
  return false;
}

export function BackupCard() {
  const board = useSystemBoard();
  const lan = useInterfaces(false).data?.interface.find((i) => i.interface === 'lan')?.['ipv4-address']?.[0]?.address;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'download' | 'read' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ file: File; info: BackupInfo } | null>(null);
  const [phase, setPhase] = useState<'uploading' | RebootPhase | 'moving' | 'timeout' | null>(null);
  const [target, setTarget] = useState<string>();

  const download = async () => {
    setBusy('download');
    setError(null);
    try {
      const host = board.data?.hostname ?? 'openwrt';
      save(await downloadBackup(), `backup-${host}-${new Date().toISOString().slice(0, 10)}.tar.gz`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy('read');
    setError(null);
    try {
      setPending({ file, info: await readBackup(file) });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  const restore = async () => {
    const { file, info } = pending!;
    setPending(null);
    setError(null);
    setPhase('uploading');
    try {
      await restoreBackup(file);
    } catch (e) {
      setPhase(null);
      return setError(message(e));
    }
    // Nothing can be undone from here: the restored settings take effect on restart.
    onlineManager.setOnline(false);
    try {
      await call('system', 'reboot', {}, { timeoutMs: 5_000, deferExpiry: true }).catch((e) => {
        if (!(e instanceof TransportError)) throw e;
      });
      // Follow the router to its new address when the browser uses the old one;
      // a name (router.lan) keeps working.
      const moves = !!info.lanAddress && !!lan && info.lanAddress !== lan && window.location.hostname === lan;
      if (moves) {
        setTarget(info.lanAddress);
        setPhase('moving');
        if (!(await followTo(info.lanAddress!))) setPhase('timeout');
        return;
      }
      setPhase('stopping');
      const r = await waitForRestart(rebootDeps, setPhase);
      if (r === 'timeout') return setPhase('timeout');
      setPhase(null);
      expireSession('The backup was restored and the router restarted. Sign in again to continue.');
    } catch (e) {
      setPhase(null);
      setError(message(e));
    } finally {
      onlineManager.setOnline(true);
    }
  };

  const info = pending?.info;
  return (
    <Card title="Backup">
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div>Settings backup</div>
            <div class="text-xs text-muted">Every setting, netui and its access point list. Keep it private: it holds WiFi passwords and login hashes.</div>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button disabled={!!busy} onClick={() => void download()}>
              Download
            </Button>
            <Button disabled={!!busy} onClick={() => input.current?.click()}>
              Restore…
            </Button>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept=".tar.gz,.tgz,application/gzip"
          class="hidden"
          aria-label="Backup file"
          onChange={(e) => void choose(e.currentTarget.files?.[0])}
        />
        {error && (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        )}
      </div>

      {info && (
        <Modal
          title="Restore this backup?"
          onClose={() => setPending(null)}
          footer={
            <>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => void restore()}>
                Restore and restart
              </Button>
            </>
          }
        >
          <div class="space-y-3">
            <Detail
              rows={[
                ['File', pending!.file.name],
                ['Device name', info.hostname ?? '—'],
                ['LAN address', info.lanAddress ?? 'From DHCP'],
                ['Settings', info.configs.join(', ')],
              ]}
            />
            <p class="text-muted">
              Every setting in the backup replaces the current one, and the router restarts. This cannot be undone, and you
              will need to sign in again.
            </p>
            {info.lanAddress && lan && info.lanAddress !== lan && (
              <Banner tone="warn" role="status">
                The router moves from {lan} to {info.lanAddress}. Devices on the LAN get new addresses as they reconnect.
              </Banner>
            )}
            {!info.logins.includes(getSession()?.username ?? '') && (
              <Banner tone="warn" role="status">
                The backup has no {getSession()?.username} login, so you cannot sign in to netui afterwards. Sign in to
                LuCI as root and run netui-passwd to create it again.
              </Banner>
            )}
            {!info.netui && (
              <Banner tone="warn" role="status">
                This backup is from before netui kept its files in backups. Settings are restored; netui itself stays as it is.
              </Banner>
            )}
          </div>
        </Modal>
      )}

      {phase && (
        <BusyOverlay label="Restoring" title="Restoring backup…" timedOut={phase === 'timeout'}>
          {phase === 'uploading'
            ? 'Sending the backup to the router…'
            : phase === 'moving'
              ? `Restarting at ${target}. This usually takes one to two minutes.`
              : phase !== 'timeout' && PHASE_TEXT[phase]}
        </BusyOverlay>
      )}
    </Card>
  );
}
