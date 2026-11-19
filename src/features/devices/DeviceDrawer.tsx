import { useEffect, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { deviceCredentials, forgetDevice, relay, renameDevice, syncDevices } from '../../api/devices';
import { deviceKeys, useDeviceLinks, useDeviceNetwork, useDeviceRadios, useDeviceSystem } from '../../api/queries';
import { gatewayVlans, hasVlans } from '../../model/apPorts';
import { vlanLabel } from '../../components/vlanStyle';
import type { DeviceCredentials, ManagedDevice, SyncOutcome } from '../../api/types';
import { firmwareVersion } from '../../model/devices';
import { displayName } from '../../model/clients';
import { useClients, useSwitch } from '../../model/hooks';
import { Link } from 'wouter-preact';
import { uplinkLabel, uplinkOf } from '../../model/mesh';
import { formatDuration, formatPercent } from '../../lib/format';
import { Drawer, Modal } from '../../components/overlay';
import { IconAccessPoint, IconPower, IconRefresh, IconTrash } from '../../components/icons';
import { Banner, Button, Detail, Dot, Empty, Field, FormSection, Pill, Spinner } from '../../components/ui';
import { RadioSettings } from './RadioSettings';
import { useFirmware } from '../../api/useFirmware';
import { waitForAccessPoint } from '../../api/firmware';
import { FirmwarePanel } from '../../components/FirmwarePanel';
import { lazy, Suspense } from 'preact/compat';

const AddonsList = lazy(() => import('../../components/AddonsList').then((m) => ({ default: m.AddonsList })));

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Forgetting drops the stored root password, so show it while it still exists. */
function ForgetText({ mac }: { mac: string }) {
  const [creds, setCreds] = useState<DeviceCredentials | null>(null);
  useEffect(() => {
    void deviceCredentials(mac).then(setCreds, () => setCreds({ error: 'unavailable' }));
  }, [mac]);
  return (
    <div class="space-y-2 py-2 text-muted">
      <p>
        It stays an access point and keeps broadcasting the WiFi it has, but this router stops managing it. It shows up
        under <Pill>Ready to adopt</Pill> again.
      </p>
      <p>
        Adopting it again, or logging in to it, needs its root password. Keep it now: this router forgets it.{' '}
        {creds?.password ? <span class="font-mono text-fg">{creds.password}</span> : creds ? 'Not available.' : <Spinner />}
      </p>
    </div>
  );
}

/** One line about the access point's ports; they are edited on the Ports page. */
function PortsSummary({ mac, online }: { mac: string; online: boolean }) {
  const net = useDeviceNetwork(mac, online);
  const { sw } = useSwitch();
  const ap = net.data?.layout;
  let text: string;
  if (!online) text = 'The device is offline.';
  else if (!ap || !sw) text = 'Reading its ports…';
  else {
    const gw = gatewayVlans(sw);
    const moved = ap.ports.filter((p) => p.profile.native !== gw.lan);
    const notCarried = hasVlans(gw) && gw.vlans.some((v) => !ap.vids.includes(v.vid));
    text = [
      `${ap.ports.length} port${ap.ports.length === 1 ? '' : 's'}`,
      moved.length
        ? moved.map((p) => `${p.name} ${p.profile.native === undefined ? 'not in use' : `on ${vlanLabel(sw, p.profile.native)}`}`).join(', ')
        : 'all on LAN',
      notCarried && !ap.unsupported && "not carrying all of this router's networks yet",
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return (
    <div class="flex items-center justify-between gap-4 py-2.5">
      <p class="text-muted">{text}</p>
      <Link href={`/settings/ports/${mac}`} class="shrink-0 font-medium text-accent hover:underline">
        Manage ports
      </Link>
    </div>
  );
}

export function DeviceDrawer({ device, onClose }: { device: ManagedDevice; onClose: () => void }) {
  const qc = useQueryClient();
  const system = useDeviceSystem(device.mac, device.online);
  const radios = useDeviceRadios(device.mac, device.online);
  const links = useDeviceLinks(device.mac, device.online);
  const served = useClients().clients.filter((c) => c.wireless?.ap?.mac === device.mac);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [creds, setCreds] = useState<DeviceCredentials | null>(null);
  const [confirm, setConfirm] = useState<'restart' | 'forget' | null>(null);
  const firmware = useFirmware(
    device.mac,
    async () => {
      const r = await waitForAccessPoint(device.mac);
      void qc.invalidateQueries({ queryKey: deviceKeys.list });
      void qc.invalidateQueries({ queryKey: deviceKeys.system(device.mac) });
      return r;
    },
    device.online,
  );
  const upgrading = !!firmware.step || !!firmware.view?.upgrade;

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ tone: 'ok', text });
    } catch (e) {
      setNotice({ tone: 'bad', text: message(e) });
    } finally {
      setBusy(null);
    }
  };

  const syncText = (o: SyncOutcome | undefined) => {
    if (!o || o.error) throw new Error(o?.error ?? 'No answer from the device');
    if (o.networkError) throw new Error(o.networkError);
    const skipped = o.skipped?.length ? ` Not copied (its network does not reach this access point): ${o.skipped.join(', ')}.` : '';
    return `Copied ${o.networks} WiFi network${o.networks === 1 ? '' : 's'} from this router.${skipped}`;
  };

  const info = system.data?.info;
  const mem = info?.memory.available !== undefined ? 1 - info.memory.available / info.memory.total : undefined;

  return (
    <Drawer
      title={device.name}
      subtitle={[device.model, device.ip].filter(Boolean).join(' · ')}
      icon={<IconAccessPoint size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" class="mr-auto" disabled={!!busy || upgrading} onClick={() => setConfirm('forget')}>
            <IconTrash size={14} /> Forget
          </Button>
          <Button disabled={!!busy || upgrading || !device.online} onClick={() => setConfirm('restart')}>
            <IconPower size={14} /> Restart
          </Button>
        </>
      }
    >
      <div class="px-5">
        {notice && (
          <div class="mt-4">
            <Banner tone={notice.tone} role={notice.tone === 'bad' ? 'alert' : 'status'}>
              {notice.text}
            </Banner>
          </div>
        )}
        <FormSection title="Overview">
          <Detail
            rows={[
              ['Status', <span class="inline-flex items-center gap-1.5"><Dot tone={device.online ? 'ok' : 'bad'} />{device.online ? 'Online' : 'Offline'}</span>],
              ['Uplink', device.online ? uplinkLabel(uplinkOf(links.data, radios.data)) : '—'],
              ['IP address', <span class="font-mono">{device.ip ?? '—'}</span>],
              ['MAC address', <span class="font-mono">{device.mac}</span>],
              ['Firmware', `OpenWrt ${firmwareVersion(system.data?.board.release.description ?? device.release) ?? '—'}`],
              ['Uptime', info ? formatDuration(info.uptime) : '—'],
              ['Memory', mem !== undefined ? formatPercent(mem) : '—'],
            ]}
          />
        </FormSection>

        <FormSection title="Firmware">
          <FirmwarePanel fw={firmware} what="access point" mac={device.mac} where={device.name} />
        </FormSection>

        <FormSection title="Add-ons">
          <Suspense fallback={<Spinner />}>
            <AddonsList mac={device.mac} where={device.name} only={['mesh', 'steering', 'firmware']} />
          </Suspense>
        </FormSection>

        <FormSection title="Radios">
          <RadioSettings mac={device.mac} online={device.online} />
        </FormSection>

        <FormSection title="Ports">
          <PortsSummary mac={device.mac} online={device.online} />
        </FormSection>

        <FormSection title={`Clients (${served.length})`}>
          {served.length === 0 ? (
            <Empty>No WiFi clients on this access point.</Empty>
          ) : (
            <ul class="divide-y divide-line" aria-label="Clients on this access point">
              {served.map((c) => (
                <li key={c.mac}>
                  <Link href={`/clients/${c.mac}`} class="flex h-9 items-center gap-2 hover:text-accent">
                    <span class="min-w-0 flex-1 truncate">{displayName(c)}</span>
                    <span class="text-xs text-muted">{c.wireless!.band}</span>
                    <span class="w-16 text-right text-xs">{c.wireless!.signal} dBm</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </FormSection>

        <FormSection title="Settings">
          <Field label="Name" stacked hint="Also the device's hostname.">
            {(id) => (
              <div class="flex gap-2">
                <input id={id} class="input" value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
                <Button
                  disabled={!!busy || !name.trim() || name.trim() === device.name}
                  onClick={() =>
                    void run('rename', async () => {
                      await renameDevice(device.mac, name.trim());
                      await qc.invalidateQueries({ queryKey: deviceKeys.list });
                      return 'Renamed.';
                    })
                  }
                >
                  Save
                </Button>
              </div>
            )}
          </Field>
          <div class="flex items-center justify-between gap-4 py-2.5">
            <p class="text-muted">WiFi and networks follow this router automatically after every change. Copy them now if they drifted.</p>
            <Button
              disabled={!!busy || !device.online}
              onClick={() =>
                void run('sync', async () => {
                  const text = syncText((await syncDevices(device.mac))[device.mac]);
                  await qc.invalidateQueries({ queryKey: deviceKeys.radios(device.mac) });
                  await qc.invalidateQueries({ queryKey: deviceKeys.network(device.mac) });
                  return text;
                })
              }
            >
              {busy === 'sync' ? <Spinner /> : <IconRefresh size={14} />} Copy WiFi
            </Button>
          </div>
          <div class="flex items-center justify-between gap-4 py-2.5">
            <p class="text-muted">SSH login for the device itself.</p>
            {creds ? (
              <span class="font-mono text-xs">
                {creds.username} / {creds.password}
              </span>
            ) : (
              <Button disabled={!!busy} onClick={() => void run('creds', async () => setCreds(await deviceCredentials(device.mac)))}>
                Show SSH password
              </Button>
            )}
          </div>
        </FormSection>
      </div>

      {confirm === 'restart' && (
        <Modal
          title={`Restart ${device.name}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirm(null);
                  void run('restart', async () => {
                    await relay(device.mac, 'system', 'reboot', {}, true);
                    return 'Restarting. Clients on this access point reconnect in a minute or two.';
                  });
                }}
              >
                Restart
              </Button>
            </>
          }
        >
          <p class="py-2 text-muted">Its WiFi goes down for a minute or two.</p>
        </Modal>
      )}
      {confirm === 'forget' && (
        <Modal
          title={`Forget ${device.name}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirm(null);
                  void run('forget', async () => {
                    await forgetDevice(device.mac);
                    await qc.invalidateQueries({ queryKey: deviceKeys.list });
                    onClose();
                  });
                }}
              >
                Forget
              </Button>
            </>
          }
        >
          <ForgetText mac={device.mac} />
        </Modal>
      )}
    </Drawer>
  );
}
