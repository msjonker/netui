import { useMemo } from 'preact/hooks';
import { useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { MIN_SIGNAL_CHOICES, ROAM_TRIGGER_DBM, readSteering, steeringOps, type Steering } from '../../model/steering';
import { useDraft } from '../../lib/useDraft';
import { Button, Card, Field, ToggleRow } from '../../components/ui';

const minSignalLabel = (dbm: number) => (dbm === 0 ? 'Off' : `${dbm} dBm`);

/**
 * Band steering, roaming assistant and minimum RSSI, on usteer. Only
 * shown when usteer is installed; the gateway copies the settings to every
 * adopted access point.
 */
export function SteeringCard() {
  const apply = useApply();
  const usteer = useUci('usteer');
  const wireless = useUci('wireless');
  const source = useMemo(() => (usteer.data ? readSteering(usteer.data) : undefined), [usteer.data]);
  const { draft, dirty, reset, update } = useDraft<Steering | undefined>(source);

  if (!usteer.data || !source || !draft) return null;
  const ops = steeringOps(draft, usteer.data, wireless.data);

  return (
    <Card title="Client steering">
      <ToggleRow
        label="Band steering"
        hint="Nudge devices that support both bands to 5 GHz, which is faster and less crowded."
        checked={draft.bandSteering}
        disabled={apply.busy}
        onChange={(bandSteering) => update({ bandSteering })}
      />
      <ToggleRow
        label="Roaming assistant"
        hint={`Ask devices whose signal drops below ${ROAM_TRIGGER_DBM} dBm to move to a closer access point. Turns on BSS transition and 802.11k on the WiFi networks so devices can follow the request.`}
        checked={draft.roaming}
        disabled={apply.busy}
        onChange={(roaming) => update({ roaming })}
      />
      <Field label="Minimum signal" stacked hint="Disconnect devices below this signal so they rejoin a closer access point. Use with care: some devices take a while to come back.">
        {(id) => (
          <select id={id} class="input" value={String(draft.minSignal)} disabled={apply.busy} onChange={(e) => update({ minSignal: Number(e.currentTarget.value) })}>
            {MIN_SIGNAL_CHOICES.map((d) => (
              <option key={d} value={String(d)}>
                {minSignalLabel(d)}
              </option>
            ))}
          </select>
        )}
      </Field>
      {dirty && (
        <div class="flex justify-end gap-2 py-2">
          <Button onClick={reset} disabled={apply.busy}>
            Reset
          </Button>
          <Button variant="primary" disabled={apply.busy || ops.length === 0} onClick={() => void apply.start(ops, { returnTo: '/settings/wifi' })}>
            Apply Changes
          </Button>
        </div>
      )}
    </Card>
  );
}
