import { useMemo } from 'preact/hooks';
import type { IwinfoSurveyEntry, UciConfig } from '../../api/types';
import { useCountryList, useFreqList, useRadioInfo, useSurvey, useTxPowerList } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { CHANNELS, placeholdersOn, radioDraft, radioOps, validateRadio, type Radio } from '../../model/wifi';
import {
  TX_LABEL,
  channelLoad,
  channelOptions,
  countryOptions,
  txLevelOf,
  txLevels,
  txPowerFor,
  widthChoices,
  type ChannelLoad,
  type TxLevel,
} from '../../model/radio';
import { useDraft } from '../../lib/useDraft';
import { Drawer } from '../../components/overlay';
import { IconWifi } from '../../components/icons';
import { Banner, Button, Detail, Field, FormSection, ToggleRow } from '../../components/ui';
import { WIFI_PLAN } from './WlanForm';

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Last two survey polls per interface, shared by every component showing a radio. */
const surveys = new Map<string, { at: number; data: IwinfoSurveyEntry[] }[]>();

/**
 * Utilisation of a radio's in-use channel from iwinfo survey, polled every
 * 10 s. The counters are cumulative, so each poll is compared with the one
 * before; the first shows the average since the counters started.
 */
export function useChannelLoad(radio: Radio): ChannelLoad | undefined {
  const dev = radio.enabled ? radio.ifname : undefined;
  const q = useSurvey(dev);
  if (!dev || !q.data) return undefined;
  let s = surveys.get(dev) ?? [];
  if (s[s.length - 1]?.at !== q.dataUpdatedAt) surveys.set(dev, (s = [...s.slice(-1), { at: q.dataUpdatedAt, data: q.data }]));
  const [prev, cur] = s.length > 1 ? s : [undefined, s[0]];
  return channelLoad(cur?.data, radio.live?.frequency, prev?.data);
}

export function RadioForm({
  radio,
  wireless,
  clients,
  onClose,
}: {
  radio: Radio;
  wireless: UciConfig;
  clients: number;
  onClose: () => void;
}) {
  const apply = useApply();
  const load = useChannelLoad(radio);
  const freqs = useFreqList(radio.section);
  const txList = useTxPowerList(radio.section);
  const countries = useCountryList(radio.section);
  const info = useRadioInfo(radio.section);
  const source = useMemo(() => radioDraft(radio), [radio]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  if (!draft) return null;

  const error = validateRadio(draft);
  // Without iwinfo (older ACL, no driver support) fall back to the fixed tables.
  const channels = freqs.error
    ? (radio.band ? CHANNELS[radio.band] : ['auto']).map((c) => ({ value: c, label: c === 'auto' ? 'Auto' : c, dfs: false }))
    : channelOptions(freqs.data, radio.band, draft.channel);
  const selected = channels.find((c) => c.value === draft.channel);
  const widths = widthChoices(radio.band, info.data?.htmodes, radio.htmode);
  const levels = txLevels(txList.data);
  const level = txLevelOf(draft.txpower, txList.data);
  const countryChoices = countryOptions(countries.data, draft.country);
  const noise = load?.noise ?? radio.live?.noise;
  const otherRadios = Object.values(wireless).filter((s) => s['.type'] === 'wifi-device' && s['.name'] !== radio.section).length;

  return (
    <Drawer
      title={`${radio.bandLabel} radio`}
      subtitle={radio.section}
      icon={<IconWifi size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? 'Reset' : 'Close'}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !!error || apply.busy}
            onClick={() => apply.start(radioOps(draft, radio, wireless), { ...WIFI_PLAN, onConfirmed: onClose })}
          >
            Apply Changes
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
              This radio was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        {radio.enabled && (
          <FormSection title="Now">
            <Detail
              rows={[
                ['Channel', radio.live?.channel ? `${radio.live.channel} (${radio.live.frequency} MHz)` : 'Not broadcasting'],
                ['Channel utilisation', load ? pct(load.busy) : undefined],
                ['Noise floor', noise ? `${noise} dBm` : undefined],
                ['Transmit power', radio.live?.txpower !== undefined ? `${radio.live.txpower} dBm` : undefined],
                ['Clients', String(clients)],
              ]}
            />
          </FormSection>
        )}
        <FormSection title="Radio">
          <ToggleRow
            label="Radio enabled"
            hint="Turning a radio off takes down every WiFi on this band."
            checked={draft.enabled}
            onChange={(enabled) => update({ enabled })}
          />
          {draft.enabled && !radio.enabled && placeholdersOn(wireless, radio.section).length > 0 && (
            <p class="pb-2 text-xs text-muted">The open "OpenWrt" network from the fresh install stays off.</p>
          )}
          <Field
            label="Channel"
            stacked
            hint={
              selected?.dfs
                ? 'DFS channel: the radio listens for radar for at least a minute before broadcasting, and moves if it hears any.'
                : 'Only channels allowed in the selected country are listed.'
            }
          >
            {(id) => (
              <select id={id} class="input" value={draft.channel} onChange={(e) => update({ channel: e.currentTarget.value })}>
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
              <select id={id} class="input" value={draft.htmode} onChange={(e) => update({ htmode: e.currentTarget.value })}>
                {!widths.some((w) => w.value === draft.htmode) && <option value={draft.htmode}>{draft.htmode || 'Default'}</option>}
                {widths.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Transmit power" stacked hint="Auto uses the most the country allows. Lower power shrinks coverage to help devices roam.">
            {(id) => (
              <select
                id={id}
                class="input"
                value={level}
                onChange={(e) => update({ txpower: txPowerFor(e.currentTarget.value as TxLevel, draft.txpower, txList.data) })}
              >
                {(['auto', 'high', 'medium', 'low', 'custom'] as const)
                  .filter((l) => levels || l === 'auto' || l === 'custom')
                  .map((l) => (
                    <option key={l} value={l}>
                      {TX_LABEL[l]}
                      {l !== 'auto' && l !== 'custom' && levels ? ` (${levels[l]} dBm)` : ''}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          {level === 'custom' && (
            <Field label="Custom power (dBm)" stacked>
              {(id) =>
                txList.data?.length ? (
                  <select id={id} class="input w-40" value={draft.txpower} onChange={(e) => update({ txpower: e.currentTarget.value })}>
                    {!txList.data.some((p) => String(p.dbm) === draft.txpower) && <option value={draft.txpower}>{draft.txpower} dBm</option>}
                    {txList.data.map((p) => (
                      <option key={p.dbm} value={String(p.dbm)}>
                        {p.dbm} dBm ({p.mw} mW)
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    class="input w-24"
                    inputMode="numeric"
                    value={draft.txpower}
                    onInput={(e) => update({ txpower: e.currentTarget.value.trim() })}
                  />
                )
              }
            </Field>
          )}
          <Field
            label="Country"
            stacked
            hint={`Sets the channels and power levels allowed by regulation.${otherRadios ? ' Applies to all radios.' : ''}`}
          >
            {(id) =>
              countryChoices.length ? (
                <select id={id} class="input" value={draft.country} onChange={(e) => update({ country: e.currentTarget.value })}>
                  {!draft.country && <option value="">Driver default</option>}
                  {countryChoices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  class="input w-24 uppercase"
                  maxLength={2}
                  value={draft.country}
                  onInput={(e) => update({ country: e.currentTarget.value.trim().toUpperCase() })}
                />
              )
            }
          </Field>
          {error && (
            <p class="py-2 text-xs text-bad" role="alert">
              {error}
            </p>
          )}
        </FormSection>
      </div>
    </Drawer>
  );
}
