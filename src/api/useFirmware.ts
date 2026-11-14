import { useMemo, useState } from 'preact/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { firmwareStatus, firmwareTiming, startFirmwareCheck, startFirmwareUpgrade, upgradeAndWait, type RestartResult, type UpgradeOutcome, type UpgradeStep } from './firmware';
import { firmwareView } from '../model/firmware';

export const firmwareKeys = {
  status: (mac: string) => ['firmware', mac] as const,
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Firmware status and actions for the gateway (no `mac`) or an adopted access
 * point. `restart` waits for the device to come back after it flashes.
 */
export function useFirmware(mac: string | undefined, restart: () => Promise<RestartResult>, enabled = true) {
  const qc = useQueryClient();
  const [step, setStep] = useState<UpgradeStep | null>(null);
  const [outcome, setOutcome] = useState<UpgradeOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = firmwareKeys.status(mac ?? '');
  const status = useQuery({
    queryKey: key,
    // upgrade() polls on its own while it runs.
    enabled: enabled && !step,
    queryFn: () => firmwareStatus(mac),
    refetchInterval: (q) => (q.state.data?.job?.running ? 2_000 : false),
    retry: false,
  });
  const view = useMemo(() => status.data && firmwareView(status.data), [status.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const check = async () => {
    setError(null);
    setOutcome(null);
    try {
      await startFirmwareCheck(mac);
    } catch (e) {
      setError(message(e));
    }
    await refresh();
  };

  const upgrade = async (version: string) => {
    setError(null);
    setOutcome(null);
    try {
      const deps = { start: (v: string) => startFirmwareUpgrade(v, mac), status: () => firmwareStatus(mac), restart, sleep: (ms: number) => firmwareTiming.sleep(ms) };
      setOutcome(await upgradeAndWait(deps, version, setStep));
    } catch (e) {
      setError(message(e));
    } finally {
      setStep(null);
      void refresh();
    }
  };

  const dismiss = () => {
    setOutcome(null);
    setError(null);
  };

  return { status, view, step, outcome, error, check, upgrade, dismiss };
}

export type FirmwareControl = ReturnType<typeof useFirmware>;
