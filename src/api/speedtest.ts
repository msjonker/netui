// netui.speedtest: run an internet speed test on the gateway and keep the
// last results. The run takes about 30 s; the status polls while it lasts.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call, read } from './ubus';
import { DeviceError } from './devices';
import type { SpeedTestStatus } from './types';

export const speedTestKey = ['netui.speedtest', 'status'] as const;

export async function startSpeedTest(): Promise<void> {
  const r = await call<{ error?: string }>('netui.speedtest', 'start');
  if (r?.error) throw new DeviceError(r.error);
}

/** Undefined data with an error means the plugin is missing: hide speed tests. */
export function useSpeedTest(enabled = true) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: speedTestKey,
    enabled,
    queryFn: () => read<SpeedTestStatus>('netui.speedtest', 'status'),
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : false),
    retry: false,
  });
  const start = async () => {
    await startSpeedTest();
    await qc.invalidateQueries({ queryKey: speedTestKey });
  };
  return { status, start };
}
