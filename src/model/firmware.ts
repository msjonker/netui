import type { FirmwareJob, FirmwareStatus } from '../api/types';

// Reading owut's output. The plugin returns the log as owut wrote it; these
// match the messages in owut 2026.08 (check, then the build, download,
// verify and install steps of upgrade).

export interface CheckResult {
  from?: string;
  to?: string;
  /** Installed packages with a newer version in the target release. */
  outdated: number;
  /** update: safe to upgrade; current: nothing to do; blocked: owut refuses. */
  verdict: 'update' | 'current' | 'blocked';
  errors: string[];
  at: number;
}

export type UpgradePhase = 'preparing' | 'queued' | 'building' | 'downloading' | 'verifying' | 'installing' | 'unchanged' | 'failed';

export interface UpgradeProgress {
  phase: UpgradePhase;
  detail?: string;
  errors: string[];
}

export interface FirmwareView {
  available: boolean;
  installed?: string;
  checking: boolean;
  check?: CheckResult;
  /** An upgrade owut is running now (also one started from another browser). */
  upgrade?: UpgradeProgress & { version: string };
  /** The newest stable release of a later branch than the installed one. */
  newerRelease?: string;
}

// owut colours its output and redraws status lines with cursor movement.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function logLines(log: string): string[] {
  return log
    .replace(ANSI, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const errorsOf = (lines: string[]) =>
  lines.filter((l) => l.startsWith('ERROR:')).map((l) => l.replace(/^ERROR:\s*/, ''));

const version = (lines: string[], label: string) =>
  lines.map((l) => new RegExp(`^${label}\\s+(\\S+)`).exec(l)?.[1]).find(Boolean);

export function parseCheck(job: FirmwareJob): CheckResult | undefined {
  if (job.action !== 'check' || job.running || job.exit === null) return undefined;
  const lines = logLines(job.log);
  const text = lines.join('\n');
  const outdated = Number(/(\d+) packages? (?:is|are) out-of-date/.exec(text)?.[1] ?? 0);
  const errors = errorsOf(lines);
  let verdict: CheckResult['verdict'] = 'blocked';
  if (job.exit === 0 && /safe to proceed/.test(text)) verdict = 'update';
  else if (job.exit === 0 && /no changes, upgrade not necessary/.test(text)) verdict = 'current';
  else if (/package downgrades/.test(text)) errors.push('Some packages would be downgraded.');
  if (verdict === 'blocked' && errors.length === 0) errors.push(lines.at(-1) ?? 'owut stopped without saying why.');
  return { from: version(lines, 'Version-from'), to: version(lines, 'Version-to'), outdated, verdict, errors, at: job.started };
}

const humanize = (s: string) => s.replace(/_/g, ' ');

export function upgradeProgress(job: FirmwareJob): UpgradeProgress {
  const lines = logLines(job.log);
  let p: UpgradeProgress = { phase: 'preparing', errors: [] };
  for (const l of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^Status:\s+queued(?: - (\d+) ahead)?/.exec(l))) p = { phase: 'queued', detail: m[1] ? `${m[1]} ahead in the queue` : undefined, errors: [] };
    else if ((m = /^Status:\s+started(?: - (.+))?/.exec(l))) p = { phase: 'building', detail: m[1] && humanize(m[1]), errors: [] };
    else if (/^Build succeeded/.test(l)) p = { phase: 'downloading', errors: [] };
    else if ((m = /^Download progress:\s*([\d.]+)%/.exec(l))) p = { phase: 'downloading', detail: `${Math.floor(Number(m[1]))}%`, errors: [] };
    else if (/^Image saved/.test(l)) p = { phase: 'verifying', errors: [] };
    else if (/^Installing .* and rebooting/.test(l)) p = { phase: 'installing', errors: [] };
    else if (/^There are no changes to/.test(l)) p = { phase: 'unchanged', errors: [] };
  }
  if (job.exit !== null && job.exit !== 0) {
    const errors = errorsOf(lines);
    return { phase: 'failed', errors: errors.length ? errors : [lines.at(-1) ?? 'owut stopped without saying why.'] };
  }
  // owut hands the image to sysupgrade and exits; the device flashes and reboots.
  if (job.exit === 0 && p.phase !== 'unchanged') return { phase: 'installing', errors: [] };
  return p;
}

const parts = (v: string) => v.split(/[.-]/).map((n) => Number(n) || 0);

function newer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The newest stable release of a later branch (no release candidates or snapshots). */
export function newerRelease(branches: FirmwareStatus['branches']): string | undefined {
  if (!branches) return undefined;
  let best: string | undefined;
  for (const [name, latest] of Object.entries(branches.latest)) {
    if (!/^\d+\.\d+$/.test(name) || !/^\d+\.\d+\.\d+$/.test(latest)) continue;
    if (!newer(name, branches.current)) continue;
    if (!best || newer(latest, best)) best = latest;
  }
  return best;
}

export function firmwareView(s: FirmwareStatus): FirmwareView {
  const job = s.job;
  const view: FirmwareView = {
    available: s.available,
    installed: s.installed,
    checking: job?.action === 'check' && job.running,
    newerRelease: newerRelease(s.branches),
  };
  if (job?.action === 'check') view.check = parseCheck(job);
  if (job?.action === 'upgrade' && job.version) {
    const p = upgradeProgress(job);
    if (job.running || p.phase === 'installing') view.upgrade = { ...p, version: job.version };
  }
  return view;
}

export const PHASE_LABEL: Record<UpgradePhase, string> = {
  preparing: 'Checking packages',
  queued: 'Waiting for the build server',
  building: 'Building firmware',
  downloading: 'Downloading',
  verifying: 'Verifying',
  installing: 'Installing',
  unchanged: 'Nothing to update',
  failed: 'Failed',
};
