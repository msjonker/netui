import { useMemo, useState } from 'preact/hooks';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useLocaltime, useSystemBoard, useSystemInfo, useTimezones, useUci, firstError } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { expireSession } from '../../api/ubus';
import { useFirmware } from '../../api/useFirmware';
import type { RestartResult } from '../../api/firmware';
import { splitList } from '../../model/dns';
import {
  clockSkew,
  normalizeSystemSettings,
  normalizeTimezones,
  SKEW_WARN_S,
  systemDetails,
  systemOps,
  validateSystem,
  type SystemSettings,
} from '../../model/system';
import { formatBytes, formatDuration } from '../../lib/format';
import { useDraft } from '../../lib/useDraft';
import { Modal } from '../../components/overlay';
import { FirmwarePanel } from '../../components/FirmwarePanel';
import { IconExternal, IconPower } from '../../components/icons';
import { Banner, Button, Card, Detail, Field, LoadError, Meter, Page, Spinner, ToggleRow } from '../../components/ui';
import { rebootAndWait, rebootDeps, waitForRestart, type RebootPhase } from './reboot';

const PLAN = { returnTo: '/settings/system' };

type Draft = Omit<SystemSettings, 'ntpServers'> & { ntpServers: string };

function formatClock(epoch: number, zone: string): string {
  const d = new Date(epoch * 1000);
  try {
    return d.toLocaleString(undefined, { timeZone: zone.replace(/ /g, '_'), dateStyle: 'medium', timeStyle: 'medium' });
  } catch {
    return `${d.toLocaleString(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' })} UTC`;
  }
}

function skewText(s: number): string {
  const a = Math.abs(s);
  const amount = a >= 86400 ? `${Math.round(a / 86400)} days` : a >= 3600 ? `${Math.round(a / 3600)} hours` : `${Math.round(a / 60)} minutes`;
  return `${amount} ${s < 0 ? 'behind' : 'ahead of'}`;
}

function GeneralCard() {
  const apply = useApply();
  const system = useUci('system');
  const tz = useTimezones();
  const time = useLocaltime();
  const zones = useMemo(() => (tz.data ? normalizeTimezones(tz.data) : undefined), [tz.data]);
  const settings = useMemo(() => (system.data ? normalizeSystemSettings(system.data) : undefined), [system.data]);
  const source = useMemo<Draft | undefined>(
    () => settings && { ...settings, ntpServers: settings.ntpServers.join(' ') },
    [settings],
  );
  const { draft, dirty, stale, reset, update } = useDraft(source);

  if (!system.data || !draft || !settings) {
    return (
      <Card title="General">
        {system.data && !settings ? <p class="text-muted">This router has no system section.</p> : <Spinner />}
      </Card>
    );
  }
  const next: SystemSettings = { ...draft, ntpServers: splitList(draft.ntpServers) };
  const errors = validateSystem(next, zones);
  const valid = Object.keys(errors).length === 0;
  const skew = time.data !== undefined ? clockSkew(time.data, Date.now()) : 0;
  const zone = zones?.find((z) => z.name === draft.zonename);

  return (
    <Card
      title="General"
      actions={
        <>
          {dirty && (
            <Button onClick={reset} disabled={apply.busy}>
              Reset
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!dirty || !valid || apply.busy}
            onClick={() => void apply.start(systemOps(next, system.data!, zones), PLAN)}
          >
            Apply Changes
          </Button>
        </>
      }
    >
      {stale && (
        <Banner tone="warn" role="status" actions={<Button onClick={reset}>Load latest</Button>}>
          These settings were changed on the router while you were editing.
        </Banner>
      )}
      <Field label="Device name" error={errors.hostname} hint="Shown in the header and to devices on the network.">
        {(id) => <input id={id} class="input" value={draft.hostname} onInput={(e) => update({ hostname: e.currentTarget.value.trim() })} />}
      </Field>
      <Field label="Timezone" error={errors.zonename} hint={zone && zone.name !== 'UTC' ? zone.tz : undefined}>
        {(id) => (
          <>
            <input
              id={id}
              class="input"
              list="tz-list"
              placeholder="Search, e.g. Europe/Amsterdam"
              value={draft.zonename}
              onInput={(e) => update({ zonename: e.currentTarget.value })}
            />
            <datalist id="tz-list">
              {zones?.map((z) => <option key={z.name} value={z.name} />)}
            </datalist>
          </>
        )}
      </Field>
      <Field label="Router time">
        {() => (
          <div class="space-y-2 pt-1.5">
            <div class="tabular-nums">{time.data !== undefined ? formatClock(time.data, settings.zonename) : '—'}</div>
            {Math.abs(skew) > SKEW_WARN_S && (
              <Banner tone="warn" role="status">
                The router's clock is {skewText(skew)} this browser. It corrects itself over NTP once it can reach the
                internet; until then logs and schedules use the wrong time.
              </Banner>
            )}
          </div>
        )}
      </Field>
      <div class="border-t border-line pt-2">
        <ToggleRow
          label="Sync time with NTP servers"
          checked={draft.ntpEnabled}
          onChange={(ntpEnabled) => update({ ntpEnabled })}
        />
        {draft.ntpEnabled && (
          <Field label="NTP servers" error={errors.ntpServers} hint="Separate with spaces or commas.">
            {(id) => <input id={id} class="input font-mono" value={draft.ntpServers} onInput={(e) => update({ ntpServers: e.currentTarget.value })} />}
          </Field>
        )}
        <ToggleRow
          label="Act as NTP server for clients"
          hint="Devices on your networks can use the router as their time source."
          checked={draft.ntpServer}
          onChange={(ntpServer) => update({ ntpServer })}
        />
      </div>
    </Card>
  );
}

function usage(u: { used: number; total: number }) {
  return (
    <div class="ml-auto w-48 space-y-1">
      <div class="text-xs tabular-nums">
        {formatBytes(u.used)} of {formatBytes(u.total)}
      </div>
      <Meter value={u.total ? u.used / u.total : 0} />
    </div>
  );
}

function DeviceCard() {
  const board = useSystemBoard();
  const info = useSystemInfo();
  const d = board.data && info.data ? systemDetails(board.data, info.data) : undefined;
  return (
    <Card
      title="Device"
      actions={
        <a class="inline-flex items-center gap-1 text-accent hover:underline" href="/cgi-bin/luci/admin/system/flash" target="_blank" rel="noreferrer">
          Backup & manual upgrade <IconExternal size={12} />
        </a>
      }
    >
      {!d ? (
        <Spinner />
      ) : (
        <Detail
          rows={[
            ['Model', d.model],
            ['Firmware', d.firmware],
            ['Target', <span class="font-mono text-xs">{d.target}</span>],
            ['Kernel', <span class="font-mono text-xs">{d.kernel}</span>],
            ['CPU', d.cpu],
            ['Uptime', formatDuration(d.uptime)],
            ['Load', <span class="tabular-nums">{d.load.map((l) => l.toFixed(2)).join(' / ')}</span>],
            ['Memory', usage(d.memory)],
            ['Storage', d.storage && usage(d.storage)],
          ]}
        />
      )}
    </Card>
  );
}

/** Flashing takes longer than a plain restart. */
const FLASH_WAIT_MS = 15 * 60_000;

function FirmwareCard() {
  const qc = useQueryClient();
  const restart = async (): Promise<RestartResult> => {
    // As for a restart: pause queries while the router is away.
    onlineManager.setOnline(false);
    try {
      const r = await waitForRestart(rebootDeps, undefined, FLASH_WAIT_MS);
      if (r === 'signed-out') expireSession('The firmware was updated and the router restarted. Sign in again to continue.');
      return r;
    } finally {
      onlineManager.setOnline(true);
      void qc.invalidateQueries();
    }
  };
  const fw = useFirmware(undefined, restart);
  return (
    <Card title="Firmware">
      <FirmwarePanel fw={fw} what="router" fullscreen />
    </Card>
  );
}

const PHASE_TEXT: Record<RebootPhase, string> = {
  stopping: 'Shutting down…',
  starting: 'Starting up. This usually takes one to two minutes.',
  checking: 'Almost there…',
};

function Restart() {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [phase, setPhase] = useState<RebootPhase | 'timeout' | 'done' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setAsking(false);
    setError(null);
    // Pause every query so background polls neither fail noisily nor drop
    // the session with a generic notice while the router is away.
    onlineManager.setOnline(false);
    try {
      const r = await rebootAndWait(rebootDeps, setPhase);
      if (r === 'timeout') return setPhase('timeout');
      if (r === 'signed-out') {
        setPhase(null);
        return expireSession('The router restarted. Sign in again to continue.');
      }
      setPhase('done');
    } catch (err) {
      setPhase(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      onlineManager.setOnline(true);
      void qc.invalidateQueries();
    }
  };

  return (
    <Card title="Maintenance">
      <div class="flex items-center justify-between gap-4">
        <div>
          <div>Restart router</div>
          <div class="text-xs text-muted">All networks and WiFi go down for a minute or two.</div>
        </div>
        <Button variant="danger" onClick={() => setAsking(true)}>
          <IconPower size={14} /> Restart
        </Button>
      </div>
      {error && (
        <div class="mt-3">
          <Banner tone="bad" role="alert">
            Could not restart: {error}
          </Banner>
        </div>
      )}
      {phase === 'done' && (
        <div class="mt-3">
          <Banner tone="ok" role="status" actions={<Button onClick={() => setPhase(null)}>Dismiss</Button>}>
            The router restarted and is back online.
          </Banner>
        </div>
      )}
      {asking && (
        <Modal
          title="Restart the router?"
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button onClick={() => setAsking(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => void run()}>
                Restart
              </Button>
            </>
          }
        >
          <p class="text-muted">
            Every device loses its connection until the router is back, usually within two minutes. You will need to
            sign in again afterwards.
          </p>
        </Modal>
      )}
      {phase && phase !== 'done' && (
        <div role="alertdialog" aria-label="Restarting" class="fixed inset-0 z-50 flex items-center justify-center bg-bg/95">
          <div class="max-w-sm space-y-3 text-center">
            {phase === 'timeout' ? (
              <>
                <h2 class="text-lg font-semibold">The router has not come back</h2>
                <p class="text-muted">
                  It has been five minutes. Check its power and cables, then reload this page.
                </p>
                <Button variant="primary" onClick={() => location.reload()}>
                  Reload
                </Button>
              </>
            ) : (
              <>
                <Spinner class="size-8" />
                <h2 class="text-lg font-semibold">Restarting…</h2>
                <p class="text-muted">{PHASE_TEXT[phase]}</p>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function SystemPage() {
  const system = useUci('system');
  const board = useSystemBoard();
  return (
    <Page title="System" subtitle="Device name, time and maintenance">
      <LoadError error={firstError(system, board)} />
      <div class="grid gap-4 xl:grid-cols-2">
        <div class="space-y-4">
          <GeneralCard />
          <Restart />
        </div>
        <div class="space-y-4">
          <DeviceCard />
          <FirmwareCard />
        </div>
      </div>
    </Page>
  );
}
