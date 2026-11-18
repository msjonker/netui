import { useCallback, useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { deviceApplyDeps, deviceApplyTarget, syncDevices } from '../../api/devices';
import { deviceKeys, useDeviceNetwork, useUci } from '../../api/queries';
import { useApply, useApplyController } from '../../api/useApply';
import type { ManagedDevice } from '../../api/types';
import { list } from '../../api/uci';
import { AP_UNSUPPORTED, apPortOps, gatewayVlans, hasVlans, meshVlanList, meshVlanOps, type ApLayout } from '../../model/apPorts';
import { MESH_SECTION } from '../../model/mesh';
import { inUse, type Switch } from '../../model/ports';
import { ApplyDialog, sectionLabelFor } from '../../components/ApplyDialog';
import { Banner, Button, Card, Empty, Spinner } from '../../components/ui';
import { vlanLabel } from '../../components/vlanStyle';
import { NetworkLegend, PortEditor, PortPanel, PortTable, type ViewPort } from './portParts';

/** The mesh carries every VLAN; offer to fix a gateway whose mesh predates its VLANs. */
function MeshVlans({ sw }: { sw: Switch }) {
  const wireless = useUci('wireless');
  const apply = useApply();
  const gw = gatewayVlans(sw);
  const mesh = wireless.data?.[MESH_SECTION];
  if (!mesh || String(mesh.disabled) === '1') return null;
  const have = list(mesh.network_vlan);
  const want = meshVlanList(gw);
  if (have.length === want.length && want.every((v) => have.includes(v))) return null;
  const missing = gw.vlans.filter((v) => v.vid !== gw.lan && !have.includes(`${v.vid}:t`)).map((v) => vlanLabel(sw, v.vid));
  return (
    <Banner
      tone="warn"
      role="status"
      actions={
        <Button disabled={apply.busy} onClick={() => void apply.start(meshVlanOps(wireless.data, MESH_SECTION, gw), { disruptive: true })}>
          Fix
        </Button>
      }
    >
      {missing.length
        ? `The wireless mesh does not carry ${missing.join(', ')} yet, so this access point cannot offer it.`
        : 'The wireless mesh carries networks this router no longer has.'}
    </Banner>
  );
}

const viewPorts = (ap: ApLayout): ViewPort[] =>
  ap.ports.map((p) => ({ ...p, role: inUse(p.profile) ? 'lan' : 'unused' }));

/** An adopted access point's ports, edited through the gateway with the usual review and rollback. */
export function ApPortsView({ device, sw }: { device: ManagedDevice; sw: Switch }) {
  const qc = useQueryClient();
  const mac = device.mac;
  const net = useDeviceNetwork(mac, device.online);
  const target = useMemo(() => deviceApplyTarget(mac), [mac]);
  const deps = useCallback(() => deviceApplyDeps(mac), [mac]);
  const ctl = useApplyController(deps, target);
  const [selected, setSelected] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = useCallback(
    (pkg: string, section: string) => sectionLabelFor(pkg === 'network' ? net.data?.network[section] : undefined, section, pkg),
    [net.data],
  );

  if (!device.online) {
    return (
      <Card>
        <Empty>{device.name} is offline.</Empty>
      </Card>
    );
  }
  if (net.error) {
    return (
      <Card>
        <Empty>Could not read the ports of {device.name}.</Empty>
      </Card>
    );
  }
  if (!net.data) {
    return (
      <div class="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const { layout: ap, network } = net.data;
  const gw = gatewayVlans(sw);
  const vlans = hasVlans(gw);
  const notCarried = vlans && !ap.unsupported && gw.vlans.some((v) => !ap.vids.includes(v.vid));
  const editable = vlans && !ap.unsupported && !notCarried;
  const ports = viewPorts(ap);
  const port = ports.find((p) => p.name === selected);
  const toggle = (p: string) => setSelected(p === selected ? null : p);
  const uplink = ap.ports.find((p) => p.uplink);

  const carry = async () => {
    setSyncing(true);
    setError(null);
    try {
      const o = (await syncDevices(mac))[mac];
      if (o?.networkError || o?.error) setError(o.networkError ?? o.error!);
      await qc.invalidateQueries({ queryKey: deviceKeys.network(mac) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div class="space-y-4">
      {ap.unsupported && vlans && (
        <Banner tone="warn" role="status">
          This router's networks are not carried to {device.name}: {AP_UNSUPPORTED[ap.unsupported]}
        </Banner>
      )}
      {notCarried && (
        <Banner
          role="status"
          actions={
            <Button disabled={syncing} onClick={() => void carry()}>
              {syncing && <Spinner />} Carry them now
            </Button>
          }
        >
          {device.name} does not carry all of this router's networks yet. It does after the next change, or now.
        </Banner>
      )}
      {ap.meshUplink && <MeshVlans sw={sw} />}
      {error && (
        <Banner tone="bad" role="alert">
          {error}
        </Banner>
      )}
      {ports.length === 0 ? (
        <Card>
          <Empty>No ethernet ports found.</Empty>
        </Card>
      ) : (
        <>
          <Card
            title={device.name}
            actions={
              <span class="text-muted">
                {ap.meshUplink ? 'Connected over the mesh' : uplink ? `Connected through ${uplink.name}` : device.model}
              </span>
            }
          >
            <PortPanel sw={sw} ports={ports} selected={selected} onSelect={toggle} />
            <NetworkLegend sw={sw} vids={ap.vids.length > 1 ? ap.vids : []} />
          </Card>
          <Card flush>
            <PortTable sw={sw} ports={ports} vids={ap.vids} selected={selected} onSelect={toggle} />
          </Card>
          <p class="text-xs text-muted">
            {!vlans
              ? 'Every port is on LAN. Create a VLAN network under Networks to put ports of access points on another network.'
              : ap.meshUplink
                ? 'It reaches this router over the wireless mesh, which carries every network.'
                : 'The port to this router carries LAN and, tagged, every other network.'}
          </p>
        </>
      )}
      {port && (
        <PortEditor
          key={port.name}
          port={port}
          sw={sw}
          vids={ap.vids}
          bridge={ap.bridge}
          details={[['Device', device.name]]}
          readOnly={
            port.uplink
              ? 'This port connects to this router, so it always carries LAN and every other network, tagged.'
              : ap.unsupported
                ? AP_UNSUPPORTED[ap.unsupported]
                : !vlans
                  ? 'Every port is on LAN while this router has no other networks.'
                  : notCarried
                    ? `Carry this router's networks to ${device.name} first.`
                    : undefined
          }
          warnings={(next) =>
            port.carrier && next.native !== port.profile.native ? (
              <div class="pb-2">
                <Banner tone="warn" role="status">
                  Something is plugged into {port.name}. It moves to{' '}
                  {next.native === undefined ? 'no network' : vlanLabel(sw, next.native)} and gets a new address.
                </Banner>
              </div>
            ) : null
          }
          busy={ctl.busy || !editable}
          onApply={(next) =>
            void ctl.start(apPortOps(ap, { [port.name]: next }, network), { disruptive: true, onConfirmed: () => setSelected(null) })
          }
          onClose={() => setSelected(null)}
        />
      )}
      <ApplyDialog ctl={ctl} sectionLabel={label} target={device.name} />
    </div>
  );
}
