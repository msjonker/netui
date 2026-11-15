// Ping, traceroute and DNS lookup with the router's busybox, through rpcd's
// file exec. The ACL allows exactly these three paths, for admins; arguments
// are fixed here except the target, which model/diagnostics isTarget() checks.

import { call } from './ubus';
import type { FileExecResult as ExecResult } from './types';

export type Tool = 'ping' | 'traceroute' | 'nslookup';

const COMMANDS: Record<Tool, [string, (target: string) => string[]]> = {
  ping: ['/bin/ping', (t) => ['-c', '4', '-W', '2', t]],
  // One probe per hop, 1 s wait, 20 hops: at most ~20 s, inside rpcd's 30 s.
  traceroute: ['/bin/traceroute', (t) => ['-n', '-q', '1', '-w', '1', '-m', '20', t]],
  nslookup: ['/usr/bin/nslookup', (t) => [t]],
};

export async function runTool(tool: Tool, target: string, count?: number): Promise<ExecResult> {
  const [command, args] = COMMANDS[tool];
  const params = args(target.trim());
  if (tool === 'ping' && count) params[1] = String(count);
  return call<ExecResult>('file', 'exec', { command, params }, { permissionDeniedIsAuth: false, timeoutMs: 40_000 });
}
