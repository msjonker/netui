import { useState } from 'preact/hooks';
import { needsKey, wifiQrPayload, type Wlan } from '../../model/wifi';
import { Modal } from '../../components/overlay';
import { QrCode } from '../../components/QrCode';
import { Button } from '../../components/ui';

/** Clipboard API where available (HTTPS); execCommand on plain HTTP, where it is not. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand?.('copy');
    ta.remove();
  }
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="flex min-h-9 items-center justify-between gap-3 py-1.5">
      <div class="min-w-0">
        <div class="text-xs text-muted">{label}</div>
        <div class={mono ? 'font-mono break-all' : 'break-all'}>{value}</div>
      </div>
      <Button
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() =>
          void copyText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** Share WiFi: a QR code phones can scan to join, plus the name and password. */
export function ShareWifi({ wlan, onClose }: { wlan: Wlan; onClose: () => void }) {
  const hasKey = needsKey(wlan.security) || (wlan.security === 'other' && !!wlan.key);
  return (
    <Modal title={`Share "${wlan.ssid}"`} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div class="flex flex-col items-center gap-2 py-2">
        <QrCode value={wifiQrPayload(wlan)} label={`QR code to join ${wlan.ssid}`} size={200} />
        <p class="text-center text-xs text-muted">Scan with a phone camera to join.</p>
      </div>
      <div class="divide-y divide-line">
        <CopyRow label="Network name" value={wlan.ssid} />
        {hasKey ? <CopyRow label="Password" value={wlan.key} mono /> : <p class="py-2 text-muted">No password needed.</p>}
      </div>
    </Modal>
  );
}
