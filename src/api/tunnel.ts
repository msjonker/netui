// netui.services tunnel (openwrt/files/usr/share/rpcd/ucode/netui-services):
// Cloudflare Tunnel's state. Its settings are ordinary UCI (`cloudflared`),
// staged through apply/rollback; the package's reload trigger starts or stops it.

import { useQuery } from '@tanstack/react-query';
import { read } from './ubus';
import type { TunnelStatus } from './types';

export const tunnelKeys = { status: ['netui.services', 'tunnel'] as const };

/** Faster while the tunnel is starting. */
export const useTunnel = (refetchInterval: number) =>
  useQuery({
    queryKey: tunnelKeys.status,
    queryFn: () => read<TunnelStatus>('netui.services', 'tunnel'),
    refetchInterval,
    retry: false,
  });
