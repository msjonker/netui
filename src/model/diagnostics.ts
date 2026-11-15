// Diagnostics: reading busybox ping / nslookup output (recorded on the
// DL-WRX36, test/fixtures/ubus/dl-wrx36/plain/file.exec.diagnostics.json) and
// the one-click connection check that walks from the cable to name lookup.

import type { FileExecResult as ExecResult } from '../api/types';
import { isIPv4 } from '../lib/ip';

/**
 * A host name or IP address the tools may be pointed at. Leading dashes,
 * spaces and anything else that could read as an option are refused.
 */
export function isTarget(v: string): boolean {
  const s = v.trim();
  if (isIPv4(s)) return true;
  if (/^[0-9a-f:.]+$/i.test(s) && s.includes(':')) return true;
  return /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*\.?$/i.test(s);
}

export interface PingResult {
  sent: number;
  received: number;
  avgMs?: number;
  /** "bad address": the name did not resolve. */
  error?: string;
}

export function parsePing(r: ExecResult): PingResult {
  const out = r.stdout ?? '';
  const stats = /(\d+) packets transmitted, (\d+) packets received/.exec(out);
  const rtt = /min\/avg\/max = [\d.]+\/([\d.]+)\//.exec(out);
  return {
    sent: Number(stats?.[1] ?? 0),
    received: Number(stats?.[2] ?? 0),
    avgMs: rtt ? Number(rtt[1]) : undefined,
    error: stats ? undefined : r.stderr?.trim().replace(/^ping: /, '') || 'no answer',
  };
}

/** Addresses nslookup found (IPv4 and IPv6), excluding the server's own line. */
export function parseLookup(r: ExecResult): string[] {
  const answer = (r.stdout ?? '').split(/\n\n/).filter((b) => /^Name:/m.test(b));
  return answer.flatMap((b) => [...b.matchAll(/^Address:\s*(\S+)$/gm)].map((m) => m[1]!));
}

// ---------------------------------------------------------------------------
// Connection check

export type StepState = 'ok' | 'warn' | 'fail' | 'skip';

export interface Step {
  id: 'cable' | 'address' | 'gateway' | 'internet' | 'dns';
  label: string;
  state: StepState;
  detail?: string;
}

export interface CheckInput {
  /** WAN port link: false without a cable (undefined: unknown, e.g. PPPoE or a modem port without carrier info). */
  carrier?: boolean;
  /** The WAN's IPv4 address, if it has one. */
  address?: string;
  gateway?: string;
  gatewayPing?: PingResult;
  internetPing?: PingResult;
  internetTarget?: string;
  lookup?: string[];
}

const LABELS: Record<Step['id'], string> = {
  cable: 'Cable to the modem',
  address: 'Internet address from your provider',
  gateway: 'Modem or provider gateway answers',
  internet: 'Internet reachable',
  dns: 'Names resolve (DNS)',
};

const ADVICE: Record<Step['id'], string> = {
  cable: 'No link on the WAN port. Check the cable between the modem and the router, and that the modem is on.',
  address:
    'The router got no address from your provider. Restart the modem, wait a minute, and check the connection type under Settings → Internet.',
  gateway: 'The gateway does not answer pings. Some providers block them; the next step tells whether the internet works anyway.',
  internet:
    'Nothing on the internet answers. Restart the modem; if that does not help, the problem is probably on your provider’s side.',
  dns: 'The internet works but names do not resolve. Check the DNS servers under Settings → Internet, or switch Auto DNS back on.',
};

/** Steps for what has run so far ('skip' until a step has its result, or after no link / no address). */
export function checkSteps(i: CheckInput): Step[] {
  const step = (id: Step['id'], state: StepState, detail?: string): Step => ({
    id,
    label: LABELS[id],
    state,
    detail: state === 'fail' || state === 'warn' ? ADVICE[id] : detail,
  });
  const steps: Step[] = [];
  let blocked = false;
  const push = (id: Step['id'], state: StepState | undefined, detail?: string) => {
    if (blocked || state === undefined) return void steps.push(step(id, 'skip'));
    steps.push(step(id, state, detail));
    // Without a link or an address there is nothing further to test.
    if (state === 'fail' && (id === 'cable' || id === 'address')) blocked = true;
  };
  const ms = (p?: PingResult) => (p?.avgMs != null ? `${Math.round(p.avgMs)} ms` : undefined);

  push('cable', i.carrier === false ? 'fail' : 'ok');
  push('address', i.address ? 'ok' : 'fail', i.address);
  const internetOk = !!i.internetPing && i.internetPing.received > 0;
  push(
    'gateway',
    // Some gateways ignore pings: only a failure when the internet is unreachable too.
    !i.gatewayPing ? undefined : i.gatewayPing.received > 0 ? 'ok' : !i.internetPing ? undefined : internetOk ? 'warn' : 'fail',
    i.gateway && `${i.gateway}${ms(i.gatewayPing) ? `, ${ms(i.gatewayPing)}` : ''}`,
  );
  push(
    'internet',
    !i.internetPing ? undefined : internetOk ? 'ok' : 'fail',
    i.internetTarget && `${i.internetTarget}${ms(i.internetPing) ? `, ${ms(i.internetPing)}` : ''}`,
  );
  push('dns', !i.lookup ? undefined : i.lookup.length ? 'ok' : 'fail', i.lookup?.[0]);
  return steps;
}
