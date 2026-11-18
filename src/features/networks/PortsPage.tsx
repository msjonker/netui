import { useMemo, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { useLocation, useParams } from 'wouter-preact';
import type { UciConfig } from '../../api/types';
import { useManagedDevices } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { useNetworks, useSwitch } from '../../model/hooks';
import { currentPlan, switchOps, vlanOf, type PortProfile, type Switch, type SwitchPort } from '../../model/ports';
import { sortDevices } from '../../model/devices';
import { normalizeMac } from '../../lib/mac';
import { IconExternal } from '../../components/icons';
import { Banner, Card, Dot, Empty, LoadError, Page, Segmented, Spinner } from '../../components/ui';
import { vlanLabel } from '../../components/vlanStyle';
import { NetworkLegend, PortEditor, PortPanel, PortTable } from './portParts';

// Ports of this router and of every adopted access point, one device at a
// time. Access points load their part on demand.
const ApPortsView = lazy(() => import('./ApPortsView').then((m) => ({ default: m.ApPortsView })));

const LUCI_DEVICES = '/cgi-bin/luci/admin/network/network';

const UNSUPPORTED: Record<NonNullable<Switch['unsupported']>, string> = {
  swconfig: "This router has an older switch chip (swconfig). Its VLANs are set up in LuCI.",
  'no-bridge': 'This router has no LAN bridge, so there are no port settings to change here.',
  custom:
    'The LAN bridge has interfaces netui cannot place on a VLAN (made in LuCI or by hand). Port settings are shown read-only; change them in LuCI.',
};

function GatewayPortForm({
  port,
  sw,
  network,
  mgmt,
  onClose,
}: {
  port: SwitchPort;
  sw: Switch;
  network: UciConfig;
  /** VLAN of the network this page was loaded from, if it is on the bridge. */
  mgmt?: { vid: number; name: string };
  onClose: () => void;
}) {
  const apply = useApply();
  const planFor = (next: PortProfile) => {
    const plan = currentPlan(sw);
    plan.profiles[port.name] = next;
    return plan;
  };
  const warnings = (next: PortProfile) => {
    if (!mgmt) return null;
    if (port.profile.native === mgmt.vid && next.native !== mgmt.vid) {
      return (
        <div class="pb-2">
          <Banner tone="warn" role="status">
            You reached this page over {mgmt.name}. If this computer is plugged into {port.name}, it loses access; the router
            then reverts on its own after 30 seconds.
          </Banner>
        </div>
      );
    }
    if (!Object.values(planFor(next).profiles).some((p) => p.native === mgmt.vid)) {
      return (
        <div class="pb-2">
          <Banner tone="warn" role="status">
            No port will carry {mgmt.name} untagged.
          </Banner>
        </div>
      );
    }
    return null;
  };

  return (
    <PortEditor
      port={port}
      sw={sw}
      vids={sw.vlans.map((v) => v.vid)}
      bridge={sw.bridge}
      details={[['Bridge', port.role === 'lan' ? sw.bridge : port.role === 'wan' ? 'Internet uplink' : 'Not in use']]}
      readOnly={
        port.role === 'wan'
          ? 'This port carries the internet connection. Change it under Internet or in LuCI.'
          : sw.unsupported
            ? "This router's switch layout is edited in LuCI."
            : undefined
      }
      warnings={warnings}
      busy={apply.busy}
      onApply={(next) =>
        void apply.start(switchOps(sw, planFor(next), network), {
          disruptive: true,
          returnTo: '/settings/ports',
          onConfirmed: onClose,
        })
      }
      onClose={onClose}
    />
  );
}

function GatewayPorts({ sw, network }: { sw: Switch; network: UciConfig | undefined }) {
  const { networks } = useNetworks();
  const [selected, setSelected] = useState<string | null>(null);
  const port = sw.ports.find((p) => p.name === selected);
  const toggle = (p: string) => setSelected(p === selected ? null : p);

  const mgmt = useMemo(() => {
    const n = networks?.find((x) => x.address === location.hostname);
    const v = n ? vlanOf(sw, n.id) : undefined;
    return n && v ? { vid: v.vid, name: vlanLabel(sw, v.vid) } : undefined;
  }, [networks, sw]);

  const vids = sw.vlans.map((v) => v.vid);
  return (
    <>
      {sw.unsupported && (
        <div class="mb-4">
          <Banner tone="warn" role="status">
            {UNSUPPORTED[sw.unsupported]}
          </Banner>
        </div>
      )}
      {sw.ports.length === 0 ? (
        <Card>
          <Empty>No ethernet ports found.</Empty>
        </Card>
      ) : (
        <div class="space-y-4">
          <Card
            title={sw.bridge || 'Ports'}
            actions={
              <span class="text-muted">{sw.vlanFiltering ? `VLAN filtering · ${sw.vlans.length} VLANs` : 'Plain bridge, no VLANs'}</span>
            }
          >
            <PortPanel sw={sw} ports={sw.ports} selected={selected} onSelect={toggle} />
            <NetworkLegend sw={sw} vids={vids} />
          </Card>
          <Card flush>
            <PortTable sw={sw} ports={sw.ports} vids={vids} selected={selected} onSelect={toggle} />
          </Card>
        </div>
      )}
      {port && network && (
        <GatewayPortForm key={port.name} port={port} sw={sw} network={network} mgmt={mgmt} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

export function PortsPage() {
  const params = useParams<{ mac?: string }>();
  const [, navigate] = useLocation();
  const { sw, network, error } = useSwitch();
  const managed = useManagedDevices(30_000);
  const devices = useMemo(() => sortDevices(managed.data ?? []), [managed.data]);
  const mac = params.mac ? normalizeMac(params.mac) : undefined;
  const device = devices.find((d) => d.mac === mac);
  const loading = (
    <div class="flex justify-center py-10">
      <Spinner />
    </div>
  );

  return (
    <Page
      title="Ports"
      subtitle="What each port carries: one native network plus any tagged VLANs"
      actions={
        !mac && (
          <a
            href={LUCI_DEVICES}
            target="_blank"
            rel="noreferrer"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 font-medium hover:bg-hover"
          >
            Devices in LuCI <IconExternal size={14} />
          </a>
        )
      }
    >
      {(devices.length > 0 || mac) && (
        <div class="mb-4 overflow-x-auto">
          <Segmented
            label="Device"
            value={mac ?? 'gateway'}
            onChange={(v) => navigate(v === 'gateway' ? '/settings/ports' : `/settings/ports/${v}`)}
            options={[
              { value: 'gateway', label: 'Gateway' },
              ...devices.map((d) => ({
                value: d.mac,
                label: (
                  <span class="inline-flex items-center gap-1.5">
                    {d.name}
                    {!d.online && <Dot tone="bad" />}
                  </span>
                ),
              })),
            ]}
          />
        </div>
      )}
      <LoadError error={error} />
      {!sw ? (
        loading
      ) : !mac ? (
        <GatewayPorts sw={sw} network={network.data} />
      ) : device ? (
        <Suspense fallback={loading}>
          <ApPortsView key={device.mac} device={device} sw={sw} />
        </Suspense>
      ) : managed.isPending ? (
        loading
      ) : (
        <Card>
          <Empty>No adopted access point with that address.</Empty>
        </Card>
      )}
    </Page>
  );
}
