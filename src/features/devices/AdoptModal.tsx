import { useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { adoptDevice } from '../../api/devices';
import { deviceKeys } from '../../api/queries';
import type { ManagedDevice, PendingDevice } from '../../api/types';
import { firmwareVersion, suggestedName } from '../../model/devices';
import { Modal } from '../../components/overlay';
import { Banner, Button, Detail, Field, Spinner } from '../../components/ui';

/** Adopt one pending access point: name it, prove ownership with its root password. */
export function AdoptModal({
  device,
  onClose,
  onAdopted,
}: {
  device: PendingDevice;
  onClose: () => void;
  onAdopted: (d: ManagedDevice) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(suggestedName(device));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await adoptDevice(device.ip, password, name.trim());
      await qc.invalidateQueries({ queryKey: deviceKeys.list });
      await qc.invalidateQueries({ queryKey: deviceKeys.pending });
      onAdopted(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Adopt ${device.model ?? 'device'}`}
      onClose={busy ? () => {} : onClose}
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void adopt()} disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : null} Adopt
          </Button>
        </>
      }
    >
      <div class="space-y-3 py-2">
        <Detail
          rows={[
            ['Address', <span class="font-mono">{device.ip}</span>],
            ['MAC address', <span class="font-mono">{device.mac}</span>],
            ['Firmware', `OpenWrt ${firmwareVersion(device.release) ?? '—'}`],
          ]}
        />
        <Field label="Name" stacked hint="Also becomes the device's hostname.">
          {(id) => <input id={id} class="input" value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />}
        </Field>
        <Field label="Current root password" stacked hint="Leave empty for a fresh OpenWrt install, which has none.">
          {(id) => (
            <input
              id={id}
              class="input"
              type="password"
              autocomplete="off"
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          )}
        </Field>
        <p class="text-xs text-muted">
          Adopting turns it into an access point for this network: all its ports join the LAN, it gets its address from
          this router, and it broadcasts the same WiFi. It gets a new random root password, shown on its details page.
        </p>
        {error && (
          <Banner tone="bad" role="alert">
            {error === 'wrong root password' ? 'Wrong root password for that device.' : error}
          </Banner>
        )}
      </div>
    </Modal>
  );
}
