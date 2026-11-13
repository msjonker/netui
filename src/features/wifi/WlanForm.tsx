import { useMemo, useState } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import { networkLabel } from '../../model/network';
import {
  deleteWlanOps,
  effectivePmf,
  needsKey,
  newWlanDraft,
  validateWlan,
  wlanDraft,
  wlanOps,
  type Pmf,
  type Radio,
  type Security,
  type Wlan,
  type WlanDraft,
} from '../../model/wifi';
import { useDraft } from '../../lib/useDraft';
import { Drawer, Modal } from '../../components/overlay';
import { IconQr, IconTrash, IconWifi } from '../../components/icons';
import { Banner, Button, Field, FormSection, ToggleRow, cx } from '../../components/ui';
import { ShareWifi } from './ShareWifi';

const SECURITY_OPTIONS: { value: Security; label: string }[] = [
  { value: 'sae-mixed', label: 'WPA2/WPA3 (recommended)' },
  { value: 'psk2', label: 'WPA2' },
  { value: 'sae', label: 'WPA3' },
  { value: 'owe', label: 'Enhanced Open (OWE)' },
  { value: 'none', label: 'Open (no password)' },
];

const PMF_LABEL: Record<Pmf, string> = { off: 'Off', optional: 'Optional', required: 'Required' };

// WiFi edits briefly drop every wireless client, possibly including this browser.
export const WIFI_PLAN = { disruptive: true, returnTo: '/settings/wifi' };

export function WlanForm({
  wlan,
  wlans,
  radios,
  networks,
  isolated,
  wireless,
  onClose,
}: {
  wlan?: Wlan;
  wlans: Wlan[];
  radios: Radio[];
  networks: string[];
  /** Networks with a firewall zone of their own, for guest WiFi. */
  isolated: string[];
  wireless: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo<WlanDraft>(
    () =>
      wlan
        ? wlanDraft(wlan, isolated)
        : newWlanDraft(
            radios.filter((r) => r.enabled).map((r) => r.section),
            networks[0] ?? 'lan',
          ),
    [wlan, radios, networks, isolated],
  );
  const { draft, dirty, stale, reset, update } = useDraft(source);
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  if (!draft) return null;

  const error = validateWlan(
    draft,
    wlans.filter((w) => w.id !== wlan?.id),
    { radios, isolated },
  );
  const canApply = (dirty || !wlan) && !error && !apply.busy;
  const pmf = effectivePmf(draft.security, draft.pmf);
  const pmfFixed = draft.security !== 'psk2' && draft.security !== 'psk-mixed';
  const canRoam = needsKey(draft.security);
  const networkChoices = [...new Set([...(draft.guest ? isolated : networks), draft.network])];

  const setSecurity = (security: Security) =>
    update((d) => ({ ...d, security, fastRoaming: needsKey(security) && d.fastRoaming }));
  const setGuest = (guest: boolean) =>
    update((d) => ({
      ...d,
      guest,
      isolate: guest || d.isolate,
      network: guest && !isolated.includes(d.network) ? (isolated[0] ?? d.network) : d.network,
    }));

  return (
    <Drawer
      title={wlan ? wlan.ssid || '(no name)' : 'Create New WiFi'}
      subtitle={wlan ? wlan.members.map((m) => m.bandLabel).join(' · ') : undefined}
      icon={<IconWifi size={20} />}
      onClose={onClose}
      footer={
        <>
          {wlan && (
            <Button variant="danger" class="mr-auto" onClick={() => setConfirmDelete(true)} disabled={apply.busy}>
              <IconTrash size={14} /> Remove
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Cancel'}
          </Button>
          <Button variant="primary" disabled={!canApply} onClick={() => apply.start(wlanOps(draft, wlan, wireless), { ...WIFI_PLAN, onConfirmed: onClose })}>
            {wlan ? 'Apply Changes' : 'Add WiFi'}
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This WiFi network was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        {wlan?.mixed && (
          <div class="mt-4">
            <Banner tone="warn">The bands of this WiFi have different settings. Applying makes them all match this form.</Banner>
          </div>
        )}
        {wlan && (
          <div class="mt-4">
            <Button onClick={() => setSharing(true)}>
              <IconQr size={14} /> Share WiFi
            </Button>
          </div>
        )}
        <FormSection title="General">
          <Field label="Name (SSID)" stacked>
            {(id) => (
              <input id={id} class="input" maxLength={32} value={draft.ssid} onInput={(e) => update({ ssid: e.currentTarget.value })} />
            )}
          </Field>
          <Field label="Security" stacked>
            {(id) => (
              <select id={id} class="input" value={draft.security} onChange={(e) => setSecurity(e.currentTarget.value as Security)}>
                {draft.security === 'other' && <option value="other">Custom ({wlan?.encryption})</option>}
                {draft.security === 'psk-mixed' && <option value="psk-mixed">WPA/WPA2 (legacy)</option>}
                {SECURITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {needsKey(draft.security) && (
            <Field label="Password" stacked hint="8 to 63 characters.">
              {(id) => (
                <div class="relative">
                  <input
                    id={id}
                    class="input pr-14 font-mono"
                    type={showKey ? 'text' : 'password'}
                    autocomplete="new-password"
                    value={draft.key}
                    onInput={(e) => update({ key: e.currentTarget.value })}
                  />
                  <button
                    type="button"
                    class="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-accent hover:underline"
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              )}
            </Field>
          )}
          {draft.security === 'none' && (
            <p class="pb-2 text-xs text-warn">Anyone in range can join and see unencrypted traffic.</p>
          )}
          {draft.security === 'owe' && (
            <p class="pb-2 text-xs text-muted">No password, but traffic is encrypted. Older devices cannot join.</p>
          )}
          {draft.security !== 'none' && draft.security !== 'other' && (
            <Field
              label="Protected management frames (PMF)"
              stacked
              hint={
                pmfFixed
                  ? `Set by ${draft.security === 'sae-mixed' ? 'WPA2/WPA3' : draft.security === 'owe' ? 'Enhanced Open' : 'WPA3'}.`
                  : pmf === 'required'
                    ? 'Older devices without 802.11w cannot join.'
                    : undefined
              }
            >
              {(id) => (
                <select
                  id={id}
                  class="input"
                  disabled={pmfFixed}
                  value={pmf}
                  onChange={(e) => update({ pmf: e.currentTarget.value as Pmf })}
                >
                  {(['off', 'optional', 'required'] as const).map((p) => (
                    <option key={p} value={p}>
                      {PMF_LABEL[p]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <ToggleRow label="Enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
        </FormSection>

        <FormSection title="Network">
          <ToggleRow
            label="Guest network"
            hint="Isolates guests from each other and puts them on a network kept apart from your LAN."
            checked={draft.guest}
            onChange={setGuest}
          />
          {draft.guest && isolated.length === 0 && (
            <p class="pb-2 text-xs text-warn">
              No isolated network yet. Create one in <a class="text-accent hover:underline" href="#/settings/networks">Networks</a>{' '}
              with its own firewall zone, then pick it here.
            </p>
          )}
          <Field label="Network" stacked hint="Devices joining this WiFi get an address on this network.">
            {(id) => (
              <select id={id} class="input" value={draft.network} onChange={(e) => update({ network: e.currentTarget.value })}>
                {networkChoices.map((n) => (
                  <option key={n} value={n}>
                    {networkLabel(n)}
                    {isolated.includes(n) ? ' (isolated)' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div class="py-2.5">
            <div class="mb-2 text-muted">WiFi bands</div>
            <div class="flex flex-wrap gap-2">
              {radios.map((r) => {
                const on = draft.radios.includes(r.section);
                return (
                  <label
                    key={r.section}
                    class={cx(
                      'flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3',
                      on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-line-strong',
                    )}
                  >
                    <input
                      type="checkbox"
                      class="accent-[var(--accent)]"
                      checked={on}
                      onChange={(e) =>
                        update((d) => ({
                          ...d,
                          radios: e.currentTarget.checked ? [...d.radios, r.section] : d.radios.filter((x) => x !== r.section),
                        }))
                      }
                    />
                    {r.bandLabel}
                    {!r.enabled && <span class="text-xs text-faint">(radio off)</span>}
                  </label>
                );
              })}
            </div>
          </div>
        </FormSection>

        <FormSection title="Advanced">
          <ToggleRow
            label="Client device isolation"
            hint="Devices on this WiFi cannot reach each other."
            checked={draft.isolate}
            onChange={(isolate) => update((d) => ({ ...d, isolate, guest: isolate && d.guest }))}
          />
          <ToggleRow
            label="Fast roaming (802.11r)"
            hint={canRoam ? 'Quicker hand-off between bands and access points. Some older devices misbehave.' : 'Needs a password-based security mode.'}
            checked={draft.fastRoaming}
            disabled={!canRoam}
            onChange={(fastRoaming) => update({ fastRoaming })}
          />
          {draft.fastRoaming && (
            <Field label="Mobility domain" stacked hint="4 hex digits shared by access points clients may roam between.">
              {(id) => (
                <input
                  id={id}
                  class="input w-32 font-mono"
                  maxLength={4}
                  placeholder="Auto"
                  value={draft.mobilityDomain}
                  onInput={(e) => update({ mobilityDomain: e.currentTarget.value.trim() })}
                />
              )}
            </Field>
          )}
          <ToggleRow
            label="BSS transition"
            hint="Steers devices to a better band (802.11v with 802.11k neighbor reports)."
            checked={draft.bssTransition}
            onChange={(bssTransition) => update({ bssTransition })}
          />
          <ToggleRow
            label="Multicast enhancement"
            hint="Sends multicast to each device as unicast, for more reliable streaming and casting. Implies client isolation on the radio."
            checked={draft.multicastEnhance}
            onChange={(multicastEnhance) => update({ multicastEnhance })}
          />
          <Field label="Maximum clients" stacked hint="Per band. Empty for no limit.">
            {(id) => (
              <input
                id={id}
                class="input w-32"
                inputMode="numeric"
                placeholder="No limit"
                value={draft.maxClients}
                onInput={(e) => update({ maxClients: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
          <ToggleRow
            label="Hide WiFi name"
            hint="Devices must enter the name to join."
            checked={draft.hidden}
            onChange={(hidden) => update({ hidden })}
          />
        </FormSection>

        {(dirty || !wlan) && error && (
          <p class="py-3 text-xs text-bad" role="alert">
            {error}
          </p>
        )}
      </div>
      {sharing && wlan && <ShareWifi wlan={wlan} onClose={() => setSharing(false)} />}
      {confirmDelete && wlan && (
        <Modal
          title={`Remove "${wlan.ssid}"?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void apply.start(deleteWlanOps(wlan), WIFI_PLAN);
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p class="text-muted">Devices connected to this WiFi will be disconnected.</p>
        </Modal>
      )}
    </Drawer>
  );
}
