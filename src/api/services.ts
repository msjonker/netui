// Services whose config changes are not picked up by procd reload triggers on
// a stock install, so a confirmed apply alone would not take effect:
//   sqm           init script disabled by default, so no trigger is registered
//   ddns          no reload trigger at all
//   wifi_schedule timers live in crontab, rebuilt only by `wifi_schedule.sh cron`
//   adblock-fast  ignores being switched off and reuses cached lists on reload;
//                 netui.services adblock_apply downloads/starts or stops it
//   opennds       no reload trigger; netui.services portal_apply restarts or stops it
//   https-dns-proxy  no on/off option: switchDoh() below, run after the apply
//                 (model/doh explains why not as a hook here). Its reload
//                 trigger handles resolver changes.
// The ACL grants `file exec` on exactly these paths, nothing broader.

import { call } from './ubus';
import { syncDevices } from './devices';

const DOH = '/etc/init.d/https-dns-proxy';

const HOOKS: Record<string, [command: string, params: string[]][]> = {
  // enable: start at boot like LuCI's SQM page does; start only acts on enabled queues.
  sqm: [
    ['/etc/init.d/sqm', ['enable']],
    ['/etc/init.d/sqm', ['restart']],
  ],
  ddns: [['/etc/init.d/ddns', ['restart']]],
  wifi_schedule: [['/usr/bin/wifi_schedule.sh', ['cron']]],
};

/** Packages whose follow-up runs in the netui.services plugin, in the background. */
const PLUGIN_HOOKS: [pkg: string, method: string, label: string][] = [
  ['adblock-fast', 'adblock_apply', 'ad blocking'],
  ['opennds', 'portal_apply', 'guest portal'],
];

const SYNC_ATTEMPTS = 7;
const SYNC_RETRY_MS = 5_000;

/** Paths the netui ACL lets the UI execute; kept in sync with acl.d/netui.json. */
export const SERVICE_COMMANDS = [...new Set([...Object.values(HOOKS).flatMap((h) => h.map(([c]) => c)), DOH])];

/**
 * Run the follow-up steps for the packages an apply touched: the service
 * commands above, and copying WiFi changes to adopted access points. Best effort:
 * the config is already committed, so a failure here is reported, not thrown.
 */
export async function runServiceHooks(packages: readonly string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const [pkg, method, label] of PLUGIN_HOOKS) {
    if (!packages.includes(pkg)) continue;
    try {
      const r = await call<{ error?: string }>('netui.services', method, {}, { permissionDeniedIsAuth: false });
      if (r?.error) failed.push(label);
    } catch {
      failed.push(label);
    }
  }
  for (const pkg of packages) {
    for (const [command, params] of HOOKS[pkg] ?? []) {
      try {
        await call('file', 'exec', { command, params }, { permissionDeniedIsAuth: false });
      } catch {
        failed.push(pkg);
        break;
      }
    }
  }
  // Adopted access points broadcast the gateway's WiFi and steer clients the
  // same way: copy every WiFi and client steering change.
  // A bridge change (the mesh toggles spanning tree) first takes br-lan through
  // STP listening and learning, so the access points are unreachable for a few
  // seconds: keep trying for half a minute.
  if (packages.includes('wireless') || packages.includes('usteer')) {
    const attempts = packages.includes('network') ? SYNC_ATTEMPTS : 1;
    let ok = false;
    for (let i = 0; i < attempts && !ok; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, SYNC_RETRY_MS));
      try {
        ok = !Object.values(await syncDevices()).some((o) => o.error);
      } catch {
        ok = false;
      }
    }
    if (!ok) failed.push('access points');
  }
  return failed;
}

/** Start (and enable at boot) or stop (and disable) DNS over HTTPS. Takes a few seconds. */
export async function switchDoh(on: boolean): Promise<void> {
  for (const action of on ? ['enable', 'start'] : ['stop', 'disable']) {
    const r = await call<{ code?: number; stderr?: string }>(
      'file',
      'exec',
      { command: DOH, params: [action] },
      { permissionDeniedIsAuth: false, timeoutMs: 30_000 },
    );
    if (r?.code) throw new Error(`Could not ${action} DNS over HTTPS: ${r.stderr?.trim() || `exit ${r.code}`}`);
  }
}
