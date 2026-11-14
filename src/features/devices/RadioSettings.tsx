import { useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { applyOnDevice } from '../../api/devices';
import { deviceKeys, useDeviceRadioCaps, useDeviceRadios, useDeviceWireless } from '../../api/queries';
import type { UciConfig } from '../../api/types';
import { apRadios, ROLE_LABEL, type ApRadio } from '../../model/devices';
import { channelOptions, TX_LABEL, txLevelOf, txPowerFor, widthChoices, type TxLevel } from '../../model/radio';
import { radioDraft, radioOps, type RadioDraft } from '../../model/wifi';
import { Modal } from '../../components/overlay';
import { Banner, Button, Empty, Field, Spinner } from '../../components/ui';

const widthLabel = (htmode: string | undefined) => (htmode ? `${/\d+/.exec(htmode)?.[0] ?? '?'} MHz` : 'Default');

function powerLabel(r: ApRadio) {
  return r.txpower === undefined ? 'Auto' : `${r.txpower} dBm`;
}

function EditRadio({ mac, radio, wireless, onClose }: { mac: string; radio: ApRadio; wireless: UciConfig; onClose: () => void }) {
  const qc = useQueryClient();
  const caps = useDeviceRadioCaps(mac, radio.section);
  const [draft, setDraft] = useState<RadioDraft>(() => radioDraft(radio));
  const [level, setLevel] = useState<TxLevel>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The mesh needs every node on the gateway's channel and width.
  const locked = radio.role === 'mesh' || radio.role === 'both';

  const levelNow = caps.data ? txLevelOf(draft.txpower, caps.data.power) : 'auto';
  const channels = channelOptions(caps.data?.freqs, radio.band, draft.channel);
  const widths = widthChoices(radio.band, caps.data?.info.htmodes, draft.htmode);
  // Only channel, width and power are per device; enable and country follow the gateway.
  const ops = useMemo(() => radioOps({ ...radioDraft(radio), channel: draft.channel, htmode: draft.htmode, txpower: draft.txpower }, radio, wireless), [draft, radio, wireless]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await applyOnDevice(mac, ops);
      await qc.invalidateQueries({ queryKey: deviceKeys.radios(mac) });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${radio.bandLabel} radio`}
      onClose={busy ? () => {} : onClose}
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy || ops.length === 0}>
            {busy && <Spinner />} Apply
          </Button>
        </>
      }
    >
      <div class="space-y-3 py-2">
        {locked && (
          <Banner role="status">
            This radio carries the wireless mesh, so its channel and width follow the gateway's 5 GHz radio.
          </Banner>
        )}
        {caps.isPending ? (
          <Spinner />
        ) : (
          <>
            <Field label="Channel" stacked hint="Different channels on neighbouring access points avoid interfering with each other.">
              {(id) => (
                <select id={id} class="input" disabled={locked} value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.currentTarget.value })}>
                  {channels.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Channel width" stacked>
              {(id) => (
                <select id={id} class="input" disabled={locked} value={draft.htmode} onChange={(e) => setDraft({ ...draft, htmode: e.currentTarget.value })}>
                  {widths.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Transmit power" stacked hint="Lower power on access points close together helps devices roam to the nearest one.">
              {(id) => (
                <select
                  id={id}
                  class="input"
                  value={level === 'custom' ? 'custom' : levelNow}
                  onChange={(e) => {
                    const l = e.currentTarget.value as TxLevel;
                    setLevel(l);
                    setDraft({ ...draft, txpower: txPowerFor(l, draft.txpower, caps.data?.power) });
                  }}
                >
                  {(['auto', 'high', 'medium', 'low'] as const).map((l) => (
                    <option key={l} value={l}>
                      {TX_LABEL[l]}
                    </option>
                  ))}
                  {levelNow === 'custom' && <option value="custom">{`${draft.txpower} dBm`}</option>}
                </select>
              )}
            </Field>
          </>
        )}
        <p class="text-xs text-muted">
          The access point restarts this radio; its clients reconnect within seconds. If it cannot be reached afterwards it
          reverts on its own.
        </p>
        {error && (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        )}
      </div>
    </Modal>
  );
}

/** An access point's radios: what each carries, its channel, width and power, editable per device. */
export function RadioSettings({ mac, online }: { mac: string; online: boolean }) {
  const wireless = useDeviceWireless(mac, online);
  const live = useDeviceRadios(mac, online);
  const [editing, setEditing] = useState<string | null>(null);
  const radios = useMemo(() => (wireless.data ? apRadios(wireless.data, live.data) : []), [wireless.data, live.data]);

  if (!online) return <Empty>The device is offline.</Empty>;
  if (wireless.isPending) return <div class="py-3"><Spinner /></div>;
  const current = radios.find((r) => r.section === editing);
  return (
    <>
      <table class="table" aria-label="Radios">
        <thead>
          <tr><th>Band</th><th>Role</th><th>Channel</th><th>Width</th><th>Power</th><th>Clients</th><th /></tr>
        </thead>
        <tbody>
          {radios.map((r) => (
            <tr key={r.section}>
              <td>{r.bandLabel}</td>
              <td>{ROLE_LABEL[r.role]}</td>
              <td>{r.role === 'off' ? '—' : r.channel === 'auto' ? `Auto${r.liveChannel ? ` (${r.liveChannel})` : ''}` : r.channel}</td>
              <td>{r.role === 'off' ? '—' : widthLabel(r.htmode)}</td>
              <td>{r.role === 'off' ? '—' : powerLabel(r)}</td>
              <td>{r.role === 'wifi' || r.role === 'both' ? r.clients : '—'}</td>
              <td class="text-right">
                {r.role !== 'off' && (
                  <Button variant="ghost" aria-label={`Edit ${r.bandLabel} radio`} onClick={() => setEditing(r.section)}>
                    Edit
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {current && wireless.data && <EditRadio mac={mac} radio={current} wireless={wireless.data} onClose={() => setEditing(null)} />}
    </>
  );
}
