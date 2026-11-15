import { useMemo } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { useDeviceLinks, useDeviceRadios, useManagedDevices, useUci, useWifiState } from '../../api/queries';
import { useApply } from '../../api/useApply';
import type { ManagedDevice } from '../../api/types';
import { meshOps, readMesh, uplinkLabel, uplinkOf } from '../../model/mesh';
import { Banner, Card, Dot, ToggleRow } from '../../components/ui';
import { AddonMissing } from '../../components/InstallAddon';
import { usePackages } from '../../api/packages';

/** Spanning tree can take most of a minute to settle after the bridge changes. */
const MESH_APPLY_TIMEOUT_S = 90;

/** 5 GHz channels 52-144 need radar detection: a radar hit moves the gateway and drops the mesh for a minute. */
const isDfs = (ch: string | undefined) => !!ch && Number(ch) >= 52 && Number(ch) <= 144;

function ApUplink({ d }: { d: ManagedDevice }) {
  const links = useDeviceLinks(d.mac, d.online);
  const radios = useDeviceRadios(d.mac, d.online);
  const u = uplinkOf(links.data, radios.data);
  return (
    <li class="flex h-9 items-center gap-2">
      <Dot tone={!d.online ? 'bad' : u.kind === 'unknown' ? 'warn' : 'ok'} />
      <Link href={`/devices/${d.mac}`} class="min-w-0 flex-1 truncate hover:text-accent">
        {d.name}
      </Link>
      <span class="text-xs text-muted">{d.online ? uplinkLabel(u) : 'Offline'}</span>
    </li>
  );
}

/**
 * Wireless meshing: access points without a cable reach the gateway
 * over an 802.11s link on the 5 GHz radio. With a cable they use the cable and
 * keep the mesh on standby (spanning tree picks the path).
 */
export function MeshCard() {
  const apply = useApply();
  const wireless = useUci('wireless');
  const network = useUci('network');
  const aps = useManagedDevices();
  const mesh = useMemo(
    () => (wireless.data && network.data ? readMesh(wireless.data, network.data) : undefined),
    [wireless.data, network.data],
  );
  // The live 5 GHz channel replaces "auto" when the mesh pins it.
  const wifi = useWifiState();
  // Encrypted mesh needs hostapd's full build; stock images ship the basic one.
  const basicWifi = usePackages().data?.addons.mesh?.installed === false;
  const liveChannel = wifi.devices.find((d) => (d.info?.frequency ?? 0) > 5000 && d.info?.mode !== 'Mesh Point')?.info?.channel;

  if (!mesh || !wireless.data || !network.data) return null;
  if (!mesh.radio) return null;

  const toggle = (on: boolean) =>
    void apply.start(meshOps(on, wireless.data!, network.data!, liveChannel), {
      disruptive: true,
      returnTo: '/settings/wifi',
      // Turning spanning tree on or off takes every LAN port through STP
      // listening and learning; give it time before the router reverts.
      timeoutS: MESH_APPLY_TIMEOUT_S,
    });

  return (
    <Card title="Wireless mesh">
      <ToggleRow
        label="Wireless meshing"
        hint="Access points without a cable connect to this router over WiFi. With a cable they use it and keep the mesh as a backup. Turning it off disconnects access points that have no cable."
        checked={mesh.enabled}
        disabled={apply.busy}
        onChange={toggle}
      />
      {basicWifi && (
        <div class="pb-3">
          <AddonMissing addon="mesh">
            Mesh needs the full WiFi package; this router has the basic one. Access points need it too: install it from
            each one's panel on the Devices page.
          </AddonMissing>
        </div>
      )}
      {mesh.enabled && (
        <div class="space-y-3 pb-2">
          <p class="text-xs text-muted">
            Runs on the 5 GHz radio, channel {mesh.channel}. Every access point follows this channel, so it stays fixed while
            the mesh is on. Adopt access points with a cable first, then unplug them where you want them.
          </p>
          {isDfs(mesh.channel) && (
            <Banner tone="warn" role="status">
              Channel {mesh.channel} needs radar detection. If radar is detected the router changes channel and the mesh drops
              for about a minute. A channel from 36-48 or 149-165 avoids that.
            </Banner>
          )}
          {(aps.data?.length ?? 0) > 0 ? (
            <ul class="divide-y divide-line" aria-label="Access point uplinks">
              {aps.data!.map((d) => (
                <ApUplink key={d.mac} d={d} />
              ))}
            </ul>
          ) : (
            <p class="text-xs text-muted">
              No access points yet. Adopt one on the <Link href="/devices" class="text-accent hover:underline">Devices</Link> page.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
