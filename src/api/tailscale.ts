// netui.tailscale (openwrt/files/usr/share/rpcd/ucode/netui-tailscale): remote
// access with the optional tailscale package. Plugin errors come back as
// { error } data and are thrown here.

import { useQuery } from '@tanstack/react-query';
import { call, read } from './ubus';
import type { TailscaleStatus } from './types';

export const tailscaleKeys = { status: ['netui.tailscale', 'status'] as const };

/** Faster while a sign-in or a connection is under way. */
export const useTailscale = (refetchInterval: number) =>
  useQuery({
    queryKey: tailscaleKeys.status,
    queryFn: () => read<TailscaleStatus>('netui.tailscale', 'status'),
    refetchInterval,
    retry: false,
  });

async function act(method: string, args: object = {}): Promise<void> {
  const r = await call<{ error?: string }>('netui.tailscale', method, args, {
    permissionDeniedIsAuth: false,
    timeoutMs: 30_000,
  });
  if (r?.error) throw new Error(r.error);
}

export const tailscaleLogin = () => act('login');
export const tailscaleUp = () => act('up');
export const tailscaleDown = () => act('down');
export const tailscaleLogout = () => act('logout');
export const tailscaleSet = (routes: string[], exitNode: boolean) => act('set', { routes, exit_node: exitNode });
