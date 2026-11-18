// The Ports page's building blocks, for the gateway and for access points
// alike: a front panel, a table and an editor drawer. Names and colors of
// networks come from the gateway's switch (`sw`), whose VLAN IDs access
// points share; which VLANs a device carries comes from `vids`.

import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { PortProfile, Switch } from '../../model/ports';
import { inUse, sameProfile } from '../../model/ports';
import { useDraft } from '../../lib/useDraft';
import { Drawer } from '../../components/overlay';
import { IconEthernet } from '../../components/icons';
import { Banner, Button, Detail, Dot, Field, FormSection, Pill, Segmented, cx } from '../../components/ui';
import { vlanColor, vlanLabel } from '../../components/vlanStyle';

/** A port as the page shows it, on any device. */
export interface ViewPort {
  name: string;
  carrier: boolean;
  speed?: number;
  duplex?: 'full' | 'half';
  /** wan: an internet uplink (gateway). lan: carries networks. unused: none. */
  role: 'wan' | 'lan' | 'unused';
  wanLabel?: string;
  /** Membership made outside netui, shown in its nearest form. */
  irregular?: boolean;
  /** An access point's port to the gateway. */
  uplink?: boolean;
  profile: PortProfile;
}

export function speedLabel(p: ViewPort): string {
  if (!p.carrier) return 'No link';
  if (!p.speed) return 'Up';
  return `${p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`}${p.duplex === 'half' ? ' half' : ''}`;
}

export function NetworkChip({ sw, vid, muted }: { sw: Switch; vid: number; muted?: boolean }) {
  return (
    <span class={cx('inline-flex items-center gap-1.5 whitespace-nowrap', muted && 'text-muted')}>
      <span class="inline-block size-2 shrink-0 rounded-sm" style={{ background: vlanColor(sw, vid) }} aria-hidden="true" />
      {vlanLabel(sw, vid)}
    </span>
  );
}

function taggedSummary(sw: Switch, vids: number[], p: PortProfile) {
  const others = vids.filter((v) => v !== p.native);
  if (p.tagged.length === 0) return <span class="text-faint">None</span>;
  if (others.length > 1 && p.tagged.length === others.length) return <span>All ({p.tagged.length})</span>;
  return (
    <span class="inline-flex flex-wrap gap-x-3 gap-y-1">
      {p.tagged.map((vid) => (
        <NetworkChip key={vid} sw={sw} vid={vid} muted />
      ))}
    </span>
  );
}

/** Front panel: one tile per port, colored by its native network. */
export function PortPanel({
  sw,
  ports,
  selected,
  onSelect,
}: {
  sw: Switch;
  ports: ViewPort[];
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  return (
    <ul class="flex flex-wrap gap-2" aria-label="Port panel">
      {ports.map((p) => {
        const native = p.profile.native;
        return (
          <li key={p.name}>
            <button
              type="button"
              aria-label={`Port ${p.name}`}
              aria-pressed={p.name === selected}
              title={p.uplink ? 'To this router' : undefined}
              onClick={() => onSelect(p.name)}
              class={cx(
                'flex w-[72px] flex-col overflow-hidden rounded-md border text-[11px] transition-colors',
                p.name === selected ? 'border-accent ring-2 ring-accent-soft' : 'border-line hover:border-line-strong',
              )}
            >
              <span
                class={cx(
                  'flex h-14 flex-col items-center justify-center gap-0.5',
                  p.carrier ? (p.role === 'wan' || p.uplink ? 'bg-accent-soft text-accent' : 'bg-ok-soft text-ok') : 'bg-subtle text-faint',
                )}
              >
                <IconEthernet size={18} />
                <span class="font-medium">{p.role === 'wan' ? (p.wanLabel ?? 'WAN') : p.name}</span>
                {p.uplink && <span class="text-[9px] leading-none uppercase">Uplink</span>}
              </span>
              <span
                class="h-1.5"
                style={{ background: p.role === 'lan' && native !== undefined ? vlanColor(sw, native) : 'transparent' }}
              />
              <span class="flex h-1 gap-px">
                {p.profile.tagged.map((vid) => (
                  <span key={vid} class="flex-1" style={{ background: vlanColor(sw, vid) }} />
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Legend under the panel: the networks this device carries. */
export function NetworkLegend({ sw, vids }: { sw: Switch; vids: number[] }) {
  if (!vids.length) return null;
  return (
    <div class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {vids.map((v) => (
        <NetworkChip key={v} sw={sw} vid={v} />
      ))}
    </div>
  );
}

export function PortTable({
  sw,
  ports,
  vids,
  selected,
  onSelect,
}: {
  sw: Switch;
  ports: ViewPort[];
  vids: number[];
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  return (
    <div class="overflow-x-auto">
      <table class="table" aria-label="Ports">
        <thead>
          <tr>
            <th>Port</th>
            <th>Link</th>
            <th>Native network</th>
            <th>Tagged VLANs</th>
          </tr>
        </thead>
        <tbody>
          {ports.map((p) => (
            <tr key={p.name} data-clickable aria-selected={p.name === selected} onClick={() => onSelect(p.name)}>
              <td class="font-medium">
                <span class="inline-flex items-center gap-2">
                  <IconEthernet size={16} class="text-muted" /> {p.name}
                  {p.irregular && <Pill tone="warn">Custom</Pill>}
                  {p.uplink && <Pill tone="accent">To this router</Pill>}
                </span>
              </td>
              <td>
                <span class="inline-flex items-center gap-1.5">
                  <Dot tone={p.carrier ? 'ok' : 'neutral'} /> {speedLabel(p)}
                </span>
              </td>
              <td>
                {p.role === 'wan' ? (
                  <Pill tone="accent">Internet</Pill>
                ) : p.role === 'unused' ? (
                  <span class="text-faint">Not in use</span>
                ) : p.profile.native !== undefined ? (
                  <NetworkChip sw={sw} vid={p.profile.native} />
                ) : (
                  <span class="text-faint">None</span>
                )}
              </td>
              <td>{p.role === 'lan' ? taggedSummary(sw, vids, p.profile) : <span class="text-faint">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type TagMode = 'all' | 'none' | 'custom';

interface PortDraft {
  /** VLAN ID as a string, '' for none. */
  native: string;
  mode: TagMode;
  tagged: number[];
  untagged: number[];
}

function toDraft(vids: number[], p: PortProfile): PortDraft {
  const others = vids.filter((v) => v !== p.native);
  const mode: TagMode =
    p.tagged.length === 0 ? 'none' : others.length > 0 && others.every((v) => p.tagged.includes(v)) ? 'all' : 'custom';
  return { native: p.native === undefined ? '' : String(p.native), mode, tagged: p.tagged, untagged: p.untagged ?? [] };
}

function fromDraft(vids: number[], d: PortDraft): PortProfile {
  const native = d.native === '' ? undefined : Number(d.native);
  const others = vids.filter((v) => v !== native);
  const tagged = d.mode === 'all' ? others : d.mode === 'none' ? [] : d.tagged.filter((v) => v !== native);
  const untagged = d.untagged.filter((v) => v !== native && !tagged.includes(v));
  const p: PortProfile = { tagged: [...tagged].sort((a, b) => a - b) };
  if (native !== undefined) p.native = native;
  if (untagged.length) p.untagged = untagged;
  return p;
}

/** The drawer for one port: its native network and the VLANs it carries tagged. */
export function PortEditor({
  port,
  sw,
  vids,
  bridge,
  details,
  readOnly,
  warnings,
  busy,
  onApply,
  onClose,
}: {
  port: ViewPort;
  /** The gateway's switch: network names and colors. */
  sw: Switch;
  /** VLANs this device carries. */
  vids: number[];
  bridge: string;
  details: [ComponentChildren, ComponentChildren][];
  /** Why this port cannot be changed here; editable when absent. */
  readOnly?: ComponentChildren;
  /** Warnings for the profile about to be applied. */
  warnings?: (next: PortProfile) => ComponentChildren;
  busy: boolean;
  onApply: (next: PortProfile) => void;
  onClose: () => void;
}) {
  const source = useMemo(() => toDraft(vids, port.profile), [vids, port]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  if (!draft) return null;

  const next = fromDraft(vids, draft);
  const changed = !sameProfile(next, port.profile);
  const others = vids.filter((v) => String(v) !== draft.native);

  return (
    <Drawer
      title={port.role === 'wan' ? `${port.name} (${port.wanLabel ?? 'WAN'})` : port.name}
      subtitle={speedLabel(port)}
      icon={<IconEthernet size={20} />}
      onClose={onClose}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={dirty ? reset : onClose} disabled={busy}>
              {dirty ? 'Reset' : 'Close'}
            </Button>
            <Button variant="primary" onClick={() => onApply(next)} disabled={!changed || busy}>
              Apply Changes
            </Button>
          </>
        )
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              The port setup was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        <div class="py-2">
          <Detail
            rows={[
              [
                'Link',
                <span class="inline-flex items-center gap-1.5">
                  <Dot tone={port.carrier ? 'ok' : 'neutral'} /> {speedLabel(port)}
                </span>,
              ],
              ...details,
            ]}
          />
        </div>

        {readOnly ? (
          <p class="pb-4 text-muted">{readOnly}</p>
        ) : (
          <>
            {port.irregular && (
              <div class="pb-2">
                <Banner tone="warn" role="status">
                  This port's VLAN setup was made outside netui and is shown in its nearest form. Applying a change rewrites
                  it in this form.
                </Banner>
              </div>
            )}
            <FormSection title="Native network">
              <Field label="Untagged traffic" stacked hint="Devices plugged into this port join this network.">
                {(id) => (
                  <select id={id} class="input" value={draft.native} onChange={(e) => update({ native: e.currentTarget.value })}>
                    {vids.map((v) => (
                      <option key={v} value={String(v)}>
                        {vlanLabel(sw, v)}
                      </option>
                    ))}
                    <option value="">None</option>
                  </select>
                )}
              </Field>
              {changed && warnings?.(next)}
            </FormSection>

            <FormSection title="Tagged VLANs">
              {vids.length < 2 && draft.native !== '' ? (
                <p class="py-2 text-muted">
                  There is only one network on this bridge. Create a VLAN network under Networks to carry more than one
                  network over this port.
                </p>
              ) : (
                <>
                  <div class="py-2">
                    <Segmented
                      label="Tagged VLANs"
                      value={draft.mode}
                      onChange={(mode) =>
                        update((d) => ({ ...d, mode, tagged: mode === 'custom' ? fromDraft(vids, d).tagged : d.tagged }))
                      }
                      options={[
                        { value: 'all', label: 'Allow All' },
                        { value: 'none', label: 'Block All' },
                        { value: 'custom', label: 'Custom' },
                      ]}
                    />
                  </div>
                  <p class="pb-2 text-xs text-muted">
                    {draft.mode === 'all'
                      ? 'Every other network, tagged. For access points, switches and servers that speak 802.1Q.'
                      : draft.mode === 'none'
                        ? 'Only the native network.'
                        : 'Only the networks checked below, tagged.'}
                  </p>
                  {draft.mode === 'custom' && (
                    <ul class="pb-2">
                      {others.map((v) => (
                        <li key={v}>
                          <label class="flex h-8 cursor-pointer items-center gap-2.5">
                            <input
                              type="checkbox"
                              class="size-4 accent-[var(--accent)]"
                              checked={draft.tagged.includes(v)}
                              onChange={(e) => {
                                const on = e.currentTarget.checked;
                                update((d) => ({
                                  ...d,
                                  tagged: on ? [...d.tagged, v].sort((a, b) => a - b) : d.tagged.filter((t) => t !== v),
                                }));
                              }}
                            />
                            <NetworkChip sw={sw} vid={v} />
                          </label>
                        </li>
                      ))}
                      {others.length === 0 && <li class="py-2 text-muted">No other networks.</li>}
                    </ul>
                  )}
                </>
              )}
              {draft.untagged.length > 0 && (
                <div class="pb-2">
                  <Banner tone="warn" role="status" actions={<Button onClick={() => update({ untagged: [] })}>Remove</Button>}>
                    Also sends {draft.untagged.map((v) => vlanLabel(sw, v)).join(', ')} untagged, without being its native
                    network. netui keeps this as it is unless you remove it.
                  </Banner>
                </div>
              )}
            </FormSection>
            {!inUse(next) && (
              <div class="py-3">
                <Banner tone="accent" role="status">
                  This port will carry no network and is taken out of {bridge}.
                </Banner>
              </div>
            )}
            {changed && (
              <p class="py-3 text-xs text-muted">
                Port changes restart the bridge, so devices on every port lose their connection for a few seconds.
              </p>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
