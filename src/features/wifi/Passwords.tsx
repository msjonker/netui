import { useState } from 'preact/hooks';
import { networkLabel } from '../../model/network';
import type { Wlan } from '../../model/wifi';
import { isUnknownNetwork, passwordDevices, passwordsAllowed, type WifiPassword } from '../../model/wifiPasswords';
import { IconPlus, IconQr, IconTrash } from '../../components/icons';
import { Button, FormSection } from '../../components/ui';
import { ShareWifi } from './ShareWifi';

// Letters and digits that cannot be mistaken for each other when read aloud or typed from a label.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random 12-character password for a new entry. */
export function newPassword(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

/**
 * More passwords for one WiFi, each with a name and the network its devices
 * get. `vlanOk`: the radios can put devices on another network (undefined
 * while that is being found out).
 */
export function Passwords({
  passwords,
  onChange,
  security,
  network,
  networks,
  vlanOk,
  wlan,
  showKey,
}: {
  passwords: WifiPassword[];
  onChange: (passwords: WifiPassword[]) => void;
  security: string;
  /** The WiFi's own network. */
  network: string;
  networks: string[];
  vlanOk: boolean | undefined;
  /** The saved WiFi, for sharing passwords it already has. */
  wlan?: Wlan;
  showKey: boolean;
}) {
  const [sharing, setSharing] = useState<WifiPassword | null>(null);
  // Shown or hidden per row; a new one starts shown, to be read out or copied.
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const allowed = passwordsAllowed(security);
  const set = (i: number, patch: Partial<WifiPassword>) => onChange(passwords.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const others = networks.filter((n) => n !== network);

  return (
    <FormSection title="More passwords">
      <p class="pb-2 text-xs text-muted">
        {allowed
          ? 'Give a person or a group of devices a password of its own. Removing it disconnects only the devices that use it.'
          : 'Needs WPA2 security: WPA3 can check only one password per WiFi.'}
      </p>
      {passwords.map((p, i) => {
        const name = p.label.trim() || `Password ${i + 2}`;
        const saved = wlan?.passwords.some((x) => x.key === p.key && x.label === p.label);
        const devices = passwordDevices(p);
        const shown = showKey || (reveal[i] ?? !wlan?.passwords.some((x) => x.key === p.key));
        return (
          <div key={i} class="mb-2 space-y-2 rounded-lg border border-line p-3">
            <div class="flex gap-2">
              <input
                class="input min-w-0 flex-1"
                aria-label="Password name"
                placeholder="Name, e.g. Smart plugs"
                maxLength={32}
                value={p.label}
                onInput={(e) => set(i, { label: e.currentTarget.value })}
              />
              {saved && wlan && (
                <Button aria-label={`Share ${name}`} title="Share" onClick={() => setSharing(p)}>
                  <IconQr size={14} />
                </Button>
              )}
              <Button
                aria-label={`Remove ${name}`}
                title="Remove"
                onClick={() => {
                  setReveal({});
                  onChange(passwords.filter((_, j) => j !== i));
                }}
              >
                <IconTrash size={14} />
              </Button>
            </div>
            <div class="relative">
              <input
                class="input pr-14 font-mono"
                aria-label={`Password for ${name}`}
                type={shown ? 'text' : 'password'}
                autocomplete="new-password"
                value={p.key}
                onInput={(e) => set(i, { key: e.currentTarget.value })}
              />
              <button
                type="button"
                class="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-accent hover:underline"
                onClick={() => setReveal({ ...reveal, [i]: !shown })}
              >
                {shown ? 'Hide' : 'Show'}
              </button>
            </div>
            {(vlanOk || p.network) && (
              <select
                class="input"
                aria-label={`Network for ${name}`}
                value={p.network}
                onChange={(e) => set(i, { network: e.currentTarget.value })}
              >
                <option value="">Same as this WiFi</option>
                {others.map((n) => (
                  <option key={n} value={n} disabled={!vlanOk && n !== p.network}>
                    {networkLabel(n)}
                  </option>
                ))}
                {isUnknownNetwork(p.network) && <option value={p.network}>VLAN {p.network.slice(5)} (not set up: devices are turned away)</option>}
              </select>
            )}
            {devices.length > 0 && <p class="text-xs text-muted">Only for the device {devices.join(', ')}.</p>}
          </div>
        );
      })}
      {vlanOk === false && passwords.length > 0 && (
        <p class="pb-2 text-xs text-muted">
          This router's WiFi hardware cannot put devices on another network by password: they all join this WiFi's network.
        </p>
      )}
      <div class="py-1">
        <Button
          disabled={!allowed}
          onClick={() => onChange([...passwords, { label: '', key: newPassword(), network: '' }])}
        >
          <IconPlus size={14} /> Add Password
        </Button>
      </div>
      {sharing && wlan && <ShareWifi wlan={{ ...wlan, key: sharing.key }} onClose={() => setSharing(null)} />}
    </FormSection>
  );
}
