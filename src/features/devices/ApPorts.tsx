import { useMemo, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { applyOnDevice, syncDevices } from '../../api/devices';
import { deviceKeys, useDeviceNetwork, useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import type { UciConfig } from '../../api/types';
import { list } from '../../api/uci';
import { useSwitch } from '../../model/hooks';
import { AP_UNSUPPORTED, apPortOps, gatewayVlans, hasVlans, meshVlanList, meshVlanOps, type ApLayout, type ApPort } from '../../model/apPorts';
import { MESH_SECTION } from '../../model/mesh';
import type { PortProfile, Switch } from '../../model/ports';
import { vlanColor, vlanLabel } from '../../components/vlanStyle';
import { Modal } from '../../components/overlay';
import { Banner, Button, Dot, Empty, Field, Pill, Spinner } from '../../components/ui';

function linkLabel(p: ApPort): string {
  if (!p.carrier) return 'No link';
  if (!p.speed) return 'Up';
  return `${p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`}${p.duplex === 'half' ? ' half' : ''}`;
}

function Chip({ sw, vid }: { sw: Switch; vid: number }) {
  return (
    <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span class="inline-block size-2 shrink-0 rounded-sm" style={{ background: vlanColor(sw, vid) }} aria-hidden="true" />
      {vlanLabel(sw, vid)}
    </span>
  );
}

/** The networks a port carries tagged, in words. */
function taggedText(sw: Switch, ap: ApLayout, p: PortProfile) {
  const others = ap.vids.filter((v) => v !== p.native);
  if (!p.tagged.length) return <span class="text-faint">None</span>;
  if (others.length && others.every((v) => p.tagged.includes(v))) return 'All others';
  return p.tagged.map((v) => vlanLabel(sw, v)).join(', ');
}

type Tagging = 'all' | 'none' | 'keep';

function EditPort({
  mac,
  port,
  ap,
  network,
  sw,
  onClose,
}: {
  mac: string;
  port: ApPort;
  ap: ApLayout;
  network: UciConfig;
  sw: Switch;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const others = (native: number | undefined) => ap.vids.filter((v) => v !== native);
  const allNow = port.profile.tagged.length > 0 && others(port.profile.native).every((v) => port.profile.tagged.includes(v));
  const [native, setNative] = useState(port.profile.native === undefined ? '' : String(port.profile.native));
  const [tagging, setTagging] = useState<Tagging>(port.profile.tagged.length === 0 ? 'none' : allNow ? 'all' : 'keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = useMemo((): PortProfile => {
    const n = native === '' ? undefined : Number(native);
    const tagged = tagging === 'all' ? others(n) : tagging === 'none' ? [] : port.profile.tagged.filter((v) => v !== n);
    return n === undefined ? { tagged } : { native: n, tagged };
  }, [native, tagging]);
  const ops = useMemo(() => apPortOps(ap, { [port.name]: next }, network), [ap, next, network, port.name]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await applyOnDevice(mac, ops);
      await qc.invalidateQueries({ queryKey: deviceKeys.network(mac) });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Port ${port.name}`}
      onClose={busy ? () => {} : onClose}
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy || ops.length === 0}>
            {busy && <Spinner />} Apply
          </Button>
        </>
      }
    >
      <div class="space-y-3 py-2">
        <Field label="Network" stacked hint="Devices plugged into this port join this network, untagged.">
          {(id) => (
            <select id={id} class="input" value={native} onChange={(e) => setNative(e.currentTarget.value)}>
              {ap.vids.map((v) => (
                <option key={v} value={String(v)}>
                  {vlanLabel(sw, v)}
                </option>
              ))}
              <option value="">Not in use</option>
            </select>
          )}
        </Field>
        <Field label="Also carries" stacked hint="Tagged networks are for another access point or a switch that understands VLANs.">
          {(id) => (
            <select id={id} class="input" value={tagging} onChange={(e) => setTagging(e.currentTarget.value as Tagging)}>
              <option value="all">All other networks, tagged</option>
              <option value="none">Nothing else</option>
              {tagging === 'keep' && <option value="keep">{port.profile.tagged.map((v) => vlanLabel(sw, v)).join(', ')}, tagged</option>}
            </select>
          )}
        </Field>
        {port.carrier && next.native !== port.profile.native && (
          <Banner tone="warn" role="status">
            Something is plugged into {port.name}. It moves to {next.native === undefined ? 'no network' : vlanLabel(sw, next.native)} and
            gets a new address.
          </Banner>
        )}
        <p class="text-xs text-muted">
          The access point restarts its LAN bridge, so its clients lose their connection for a few seconds. If it cannot reach
          this router afterwards it reverts on its own.
        </p>
        {error && (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        )}
      </div>
    </Modal>
  );
}

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
    <div class="py-2">
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
    </div>
  );
}

/** An access point's ports: which of this router's networks each one carries. */
export function ApPorts({ mac, online }: { mac: string; online: boolean }) {
  const qc = useQueryClient();
  const net = useDeviceNetwork(mac, online);
  const { sw } = useSwitch();
  const [editing, setEditing] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!online) return <Empty>The device is offline.</Empty>;
  if (net.error) return <Empty>Could not read the device's ports.</Empty>;
  if (!net.data || !sw) return <div class="py-3"><Spinner /></div>;

  const { layout: ap, network } = net.data;
  const gw = gatewayVlans(sw);
  const vlans = hasVlans(gw);
  const notCarried = vlans && !ap.unsupported && gw.vlans.some((v) => !ap.vids.includes(v.vid));
  const editable = vlans && !ap.unsupported && !notCarried;
  const current = ap.ports.find((p) => p.name === editing);

  const copy = async () => {
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
    <>
      {ap.unsupported && vlans && (
        <div class="py-2">
          <Banner tone="warn" role="status">
            This router's networks are not carried to it: {AP_UNSUPPORTED[ap.unsupported]}
          </Banner>
        </div>
      )}
      {notCarried && (
        <div class="py-2">
          <Banner
            role="status"
            actions={
              <Button disabled={syncing} onClick={() => void copy()}>
                {syncing && <Spinner />} Carry them now
              </Button>
            }
          >
            It does not carry all of this router's networks yet. It does after the next change, or now.
          </Banner>
        </div>
      )}
      {ap.meshUplink && <MeshVlans sw={sw} />}
      {error && (
        <div class="py-2">
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        </div>
      )}
      {ap.ports.length === 0 ? (
        <Empty>No ethernet ports found.</Empty>
      ) : (
        <div class="overflow-x-auto">
          <table class="table" aria-label="Ports">
            <thead>
              <tr><th>Port</th><th>Link</th><th>Network</th><th>Also carries</th><th /></tr>
            </thead>
            <tbody>
              {ap.ports.map((p) => (
                <tr key={p.name}>
                  <td>
                    <span class="inline-flex items-center gap-2">
                      {p.name}
                      {p.uplink && <Pill tone="accent">To this router</Pill>}
                    </span>
                  </td>
                  <td>
                    <span class="inline-flex items-center gap-1.5">
                      <Dot tone={p.carrier ? 'ok' : 'neutral'} />
                      {linkLabel(p)}
                    </span>
                  </td>
                  <td>{p.profile.native === undefined ? <span class="text-faint">Not in use</span> : <Chip sw={sw} vid={p.profile.native} />}</td>
                  <td>{taggedText(sw, ap, p.profile)}</td>
                  <td class="text-right">
                    {editable && !p.uplink && (
                      <Button variant="ghost" aria-label={`Edit port ${p.name}`} onClick={() => setEditing(p.name)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="py-2 text-xs text-muted">
        {!vlans
          ? 'Every port is on LAN. Create a VLAN network under Networks to put ports of access points on another network.'
          : ap.meshUplink
            ? 'It reaches this router over the wireless mesh, which carries every network.'
            : 'The port to this router carries LAN and, tagged, every other network.'}
      </p>
      {current && editable && <EditPort mac={mac} port={current} ap={ap} network={network} sw={sw} onClose={() => setEditing(null)} />}
    </>
  );
}
