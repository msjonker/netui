// netui.history: the router keeps each confirmed change's packages before and
// after, and notices changes made elsewhere. The apply flow calls begin()
// right before `uci apply` and record() once the change is confirmed; both
// are best effort (a missing plugin or a failure never blocks an apply).

import { useQuery } from '@tanstack/react-query';
import { call, getSession, read } from './ubus';
import { DeviceError } from './devices';
import type { HistoryDetail, HistoryList } from './types';

export const historyKey = ['netui.history', 'list'] as const;

const QUIET = { permissionDeniedIsAuth: false } as const;

export async function historyBegin(packages: readonly string[]): Promise<void> {
  if (!packages.length) return;
  await call('netui.history', 'begin', { packages: [...packages] }, QUIET).catch(() => {});
}

export async function historyRecord(page?: string): Promise<void> {
  const user = getSession()?.username ?? '';
  await call('netui.history', 'record', { user, page: page ?? '' }, QUIET).catch(() => {});
}

export const useHistory = () =>
  useQuery({
    queryKey: historyKey,
    retry: false,
    queryFn: () => read<HistoryList>('netui.history', 'list'),
  });

export async function historyEntry(id: number): Promise<HistoryDetail> {
  const r = await call<HistoryDetail & { error?: string }>('netui.history', 'get', { id });
  if (r?.error) throw new DeviceError(r.error);
  return r;
}

export const useHistoryEntry = (id: number | undefined) =>
  useQuery({
    queryKey: ['netui.history', 'get', id],
    enabled: id !== undefined,
    retry: false,
    // An entry never changes once written.
    staleTime: Infinity,
    queryFn: () => historyEntry(id!),
  });
