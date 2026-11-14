// Usage history from nlbwmon: `nlbw` prints its accounting database, one
// period (a month, by default) at a time. The ACL lets netui run that one
// binary; it only reads, apart from `-c commit`, which netui does not use.

import { useQuery } from '@tanstack/react-query';
import { call } from './ubus';
import type { FileExecResult, NlbwTable } from './types';

const NLBW = '/usr/sbin/nlbw';

async function nlbw(params: string[]): Promise<string> {
  const r = await call<FileExecResult>('file', 'exec', { command: NLBW, params }, { permissionDeniedIsAuth: false });
  if (r.code !== 0) throw new Error(`nlbw: ${r.stderr?.trim() || `exit ${r.code}`}`);
  return r.stdout ?? '';
}

export const usageKeys = {
  periods: ['nlbw', 'list'] as const,
  usage: (period: string) => ['nlbw', 'json', period] as const,
};

/** Stored periods, newest first, as YYYY-MM-DD start dates. The current one is not listed until committed. */
export const usePeriods = (enabled = true) =>
  useQuery({
    queryKey: usageKeys.periods,
    enabled,
    queryFn: async () =>
      (await nlbw(['-c', 'list']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .sort()
        .reverse(),
  });

/** Bytes per client and application; `period` '' is the current one. */
export const useUsage = (period = '', enabled = true) =>
  useQuery({
    queryKey: usageKeys.usage(period),
    enabled,
    refetchInterval: period ? false : 60_000,
    queryFn: async () => JSON.parse(await nlbw(['-c', 'json', '-g', 'mac,layer7', ...(period ? ['-t', period] : [])])) as NlbwTable,
  });
