// netui.firmware: firmware upgrades with owut, on the gateway directly and on
// access points through the gateway's relay. Both run as a background job on
// the device; the UI polls its status and parses owut's log.

import { call, cgiUpload, SessionExpiredError, TransportError, UbusError, UbusStatus } from './ubus';
import { DeviceError, relay } from './devices';
import type { FirmwareStarted, FirmwareStatus } from './types';
import { upgradeProgress, type UpgradeProgress } from '../model/firmware';

function check<T extends { error?: string }>(r: T): T {
  if (r.error) throw new DeviceError(r.error);
  return r;
}

// Direct calls, not read(): the gateway may be restarting while these poll.
const STATUS_TIMEOUT_MS = 8_000;

/** `mac` selects an adopted access point; without it, the gateway itself. */
export async function firmwareStatus(mac?: string): Promise<FirmwareStatus> {
  return check(
    mac
      ? await relay<FirmwareStatus>(mac, 'netui.firmware', 'status')
      : await call<FirmwareStatus>('netui.firmware', 'status', {}, { timeoutMs: STATUS_TIMEOUT_MS, deferExpiry: true }),
  );
}

export async function startFirmwareCheck(mac?: string): Promise<void> {
  check(mac ? await relay<FirmwareStarted>(mac, 'netui.firmware', 'check', {}, true) : await call<FirmwareStarted>('netui.firmware', 'check'));
}

export async function startFirmwareUpgrade(version: string, mac?: string): Promise<void> {
  check(
    mac
      ? await relay<FirmwareStarted>(mac, 'netui.firmware', 'upgrade', { version }, true)
      : await call<FirmwareStarted>('netui.firmware', 'upgrade', { version }),
  );
}

export type RestartResult = 'back' | 'signed-out' | 'timeout';

export interface UpgradeDeps {
  start(version: string): Promise<void>;
  status(): Promise<FirmwareStatus>;
  /** The device is flashing: resolve once it answers again. */
  restart(): Promise<RestartResult>;
  sleep(ms: number): Promise<void>;
}

export type UpgradeStep = Omit<UpgradeProgress, 'errors'> | { phase: 'restarting'; detail?: undefined };
export type UpgradeOutcome = { result: RestartResult | 'unchanged' } | { result: 'failed'; errors: string[] };

const POLL_MS = 3_000;
/** Status calls in a row that may fail before the device counts as restarting. */
const MISSES = 3;

/**
 * Start an upgrade and follow it: owut checks, has the image built, downloads
 * and verifies it, then hands it to sysupgrade, which flashes and reboots.
 */
export async function upgradeAndWait(deps: UpgradeDeps, version: string, onStep: (s: UpgradeStep) => void): Promise<UpgradeOutcome> {
  onStep({ phase: 'preparing' });
  await deps.start(version);
  for (let misses = 0; misses < MISSES; ) {
    await deps.sleep(POLL_MS);
    let s: FirmwareStatus;
    try {
      s = await deps.status();
      misses = 0;
    } catch (e) {
      if (e instanceof SessionExpiredError) break;
      misses++;
      continue;
    }
    // No job: /tmp was emptied, so the device has already rebooted.
    if (s.job?.action !== 'upgrade') break;
    const p = upgradeProgress(s.job);
    if (p.phase === 'failed') return { result: 'failed', errors: p.errors };
    if (p.phase === 'unchanged') return { result: 'unchanged' };
    onStep({ phase: p.phase, detail: p.detail });
    if (p.phase === 'installing') break;
  }
  onStep({ phase: 'restarting' });
  return { result: await deps.restart() };
}

/** Waits between polls; tests replace `sleep`. */
export const firmwareTiming = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const AP_WAIT_MS = 15 * 60_000;
const AP_POLL_MS = 5_000;

/** An access point is back once its firmware plugin answers without the upgrade job (/tmp starts empty). */
export async function waitForAccessPoint(mac: string): Promise<RestartResult> {
  for (let waited = 0; waited < AP_WAIT_MS; waited += AP_POLL_MS) {
    await firmwareTiming.sleep(AP_POLL_MS);
    try {
      if (!(await firmwareStatus(mac)).job) return 'back';
    } catch {
      // Still flashing or booting.
    }
  }
  return 'timeout';
}

// ---------------------------------------------------------------------------
// An image file from the user, as LuCI's flash page does it: cgi-io uploads it
// to the one path the ACL allows, procd checks it, and the one sysupgrade
// command line the ACL allows flashes it, keeping the settings. Responses
// recorded in test/fixtures/ubus/dl-wrx36/plain/system.validate_firmware_image.json.

export const IMAGE_PATH = '/tmp/firmware.bin';

export interface ImageCheck {
  valid: boolean;
  /** The image's metadata names this board. */
  deviceMatch: boolean;
  sha256?: string;
  size: number;
}

export async function uploadImage(file: Blob): Promise<ImageCheck> {
  const up = await cgiUpload(IMAGE_PATH, file);
  const r = await call<{ valid?: boolean; tests?: { fwtool_device_match?: boolean } }>(
    'system',
    'validate_firmware_image',
    { path: IMAGE_PATH },
    { permissionDeniedIsAuth: false, timeoutMs: 30_000 },
  );
  return { valid: !!r.valid, deviceMatch: r.tests?.fwtool_device_match !== false, sha256: up.sha256sum, size: up.size };
}

/**
 * Start flashing. sysupgrade does not return before the system goes down:
 * rpcd answers TIMEOUT (seen on the DL-WRX36) or the connection drops.
 */
export async function flashImage(): Promise<void> {
  try {
    const r = await call<{ code?: number; stderr?: string }>(
      'file',
      'exec',
      { command: '/sbin/sysupgrade', params: [IMAGE_PATH] },
      { permissionDeniedIsAuth: false, timeoutMs: 20_000, deferExpiry: true },
    );
    if (r?.code) throw new Error(`The router refused the image: ${r.stderr?.trim() || `exit ${r.code}`}`);
  } catch (e) {
    if (!(e instanceof TransportError) && !(e instanceof UbusError && e.status === UbusStatus.TIMEOUT)) throw e;
  }
}
