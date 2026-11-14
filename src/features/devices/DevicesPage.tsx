import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation, useParams } from 'wouter-preact';
import { useQueryClient } from '@tanstack/react-query';
import { syncDevices } from '../../api/devices';
import {
  deviceKeys,
  useDeviceRadios,
  useDeviceSystem,
  useManagedDevices,
  usePendingDevices,
  useSystemBoard,
  useSystemInfo,
  useWifiState,
} from '../../api/queries';
import type { ManagedDevice, PendingDevice } from '../../api/types';
import { firmwareVersion, sortDevices } from '../../model/devices';
import { formatDuration } from '../../lib/format';
import { normalizeMac } from '../../lib/mac';
import { IconAccessPoint, IconRouter } from '../../components/icons';
import { Banner, Button, Card, Dot, Empty, LoadError, Page, Pill, Spinner } from '../../components/ui';
import { AdoptModal } from './AdoptModal';
import { DeviceDrawer } from './DeviceDrawer';

function GatewayRow() {
  const [, navigate] = useLocation();
  const board = useSystemBoard();
  const info = useSystemInfo();
  const wifi = useWifiState({ assoc: true });
  const clients = wifi.devices.reduce((n, d) => n + (d.stations?.length ?? 0), 0);
  return (
    <tr class="cursor-pointer" onClick={() => navigate('/')}>
      <td>
        <span class="inline-flex items-center gap-2 font-medium">
          <IconRouter size={16} class="text-accent" /> {board.data?.hostname ?? 'Gateway'}
        </span>
      </td>
      <td><span class="inline-flex items-center gap-1.5"><Dot tone="ok" /> Online</span></td>
      <td>{board.data?.model ?? '—'}</td>
      <td><Pill tone="accent">Gateway</Pill></td>
      <td class="font-mono">{location.hostname}</td>
      <td>{clients}</td>
      <td>{info.data ? formatDuration(info.data.uptime) : '—'}</td>
      <td>{firmwareVersion(board.data?.release.description) ?? '—'}</td>
    </tr>
  );
}

function DeviceRow({ d, onOpen }: { d: ManagedDevice; onOpen: () => void }) {
  const radios = useDeviceRadios(d.mac, d.online);
  const system = useDeviceSystem(d.mac, d.online);
  const clients = radios.data?.reduce((n, r) => n + r.clients, 0);
  return (
    <tr class="cursor-pointer" onClick={onOpen}>
      <td>
        <span class="inline-flex items-center gap-2 font-medium">
          <IconAccessPoint size={16} class={d.online ? 'text-accent' : 'text-faint'} /> {d.name}
        </span>
      </td>
      <td>
        <span class="inline-flex items-center gap-1.5">
          <Dot tone={d.online ? 'ok' : 'bad'} /> {d.online ? 'Online' : 'Offline'}
        </span>
      </td>
      <td>{d.model ?? '—'}</td>
      <td><Pill>Access point</Pill></td>
      <td class="font-mono">{d.ip ?? '—'}</td>
      <td>{clients ?? '—'}</td>
      <td>{system.data ? formatDuration(system.data.info.uptime) : '—'}</td>
      <td>{firmwareVersion(d.release) ?? '—'}</td>
    </tr>
  );
}

function PendingCard({ pending, onAdopt }: { pending: ReturnType<typeof usePendingDevices>; onAdopt: (p: PendingDevice) => void }) {
  const list = pending.data ?? [];
  return (
    <Card
      title="Ready to adopt"
      flush
      actions={
        <span class="inline-flex items-center gap-2 text-xs text-muted">
          {pending.isFetching && <Spinner />} Scanning the LAN every 15 s
        </span>
      }
    >
      {list.length === 0 ? (
        <Empty>
          No access points waiting. On another OpenWrt router, install the <code>netui-agent</code> package, run{' '}
          <code>netui-agent prepare</code>, and plug any of its ports into this router's LAN.
        </Empty>
      ) : (
        <table class="table" aria-label="Ready to adopt">
          <thead>
            <tr><th>Model</th><th>IP address</th><th>MAC address</th><th>Firmware</th><th /></tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.mac}>
                <td class="font-medium">{p.model ?? p.hostname ?? 'Unknown device'}</td>
                <td class="font-mono">{p.ip}</td>
                <td class="font-mono">{p.mac}</td>
                <td>{firmwareVersion(p.release) ?? '—'}</td>
                <td class="text-right">
                  {p.adopted ? (
                    <Pill tone="warn">Managed by another gateway</Pill>
                  ) : (
                    <Button variant="primary" onClick={() => onAdopt(p)}>
                      Adopt
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function DevicesPage() {
  const qc = useQueryClient();
  const params = useParams<{ mac?: string }>();
  const [, navigate] = useLocation();
  const managed = useManagedDevices();
  const pending = usePendingDevices();
  const [adopting, setAdopting] = useState<PendingDevice | null>(null);
  /** Adopted in this session and waiting to come back online, to copy the WiFi then. */
  const [fresh, setFresh] = useState<string[]>([]);
  const [freshNote, setFreshNote] = useState<string | null>(null);

  const devices = useMemo(() => sortDevices(managed.data ?? []), [managed.data]);
  const selectedMac = params.mac ? normalizeMac(params.mac) : undefined;
  const selected = devices.find((d) => d.mac === selectedMac);

  // A just-adopted device restarts its network with a new address; once it is
  // back, give it this router's WiFi.
  useEffect(() => {
    const back = devices.filter((d) => d.online && fresh.includes(d.mac));
    if (!back.length) return;
    setFresh((f) => f.filter((m) => !back.some((d) => d.mac === m)));
    for (const d of back) {
      void syncDevices(d.mac)
        .then((r) => {
          const o = r[d.mac];
          setFreshNote(o?.error ? `${d.name} is online, but copying the WiFi failed: ${o.error}` : `${d.name} is online and broadcasting this router's WiFi.`);
          void qc.invalidateQueries({ queryKey: deviceKeys.radios(d.mac) });
        })
        .catch((e) => setFreshNote(`${d.name} is online, but copying the WiFi failed: ${e instanceof Error ? e.message : e}`));
    }
  }, [devices, fresh, qc]);

  return (
    <Page title="Devices" subtitle="This router and the access points it manages">
      <div class="space-y-4">
        <LoadError error={managed.error} />
        {fresh.length > 0 && (
          <Banner role="status">
            <span class="inline-flex items-center gap-2">
              <Spinner /> Adopted. The device is restarting its network and will appear online within a minute.
            </span>
          </Banner>
        )}
        {freshNote && (
          <Banner tone="ok" role="status" actions={<Button onClick={() => setFreshNote(null)}>Dismiss</Button>}>
            {freshNote}
          </Banner>
        )}
        <Card flush>
          <table class="table" aria-label="Devices">
            <thead>
              <tr>
                <th>Name</th><th>Status</th><th>Model</th><th>Role</th><th>IP address</th><th>WiFi clients</th><th>Uptime</th><th>Firmware</th>
              </tr>
            </thead>
            <tbody>
              <GatewayRow />
              {devices.map((d) => (
                <DeviceRow key={d.mac} d={d} onOpen={() => navigate(`/devices/${d.mac}`)} />
              ))}
            </tbody>
          </table>
        </Card>
        <PendingCard pending={pending} onAdopt={setAdopting} />
      </div>
      {adopting && (
        <AdoptModal
          device={adopting}
          onClose={() => setAdopting(null)}
          onAdopted={(d) => {
            setAdopting(null);
            setFresh((f) => [...f, d.mac]);
          }}
        />
      )}
      {selected && <DeviceDrawer key={selected.mac} device={selected} onClose={() => navigate('/devices')} />}
    </Page>
  );
}
