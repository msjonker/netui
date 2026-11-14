import { useMemo, useState } from 'preact/hooks';
import { firstError, useDevices, useInterfaces, useUci } from '../../api/queries';
import { normalizeWan, wanL3Device } from '../../model/internet';
import { IconExternal } from '../../components/icons';
import { Card, LoadError, Page, Spinner } from '../../components/ui';
import { DdnsCard, SqmCard, UpnpCard } from './Services';
import { WanDrawer, WanStatusCard } from './Wan';
import { SpeedTestCard } from './SpeedTest';

const LUCI = '/cgi-bin/luci/admin';

function LuciLink({ href, children }: { href: string; children: string }) {
  return (
    <a class="inline-flex items-center gap-1 text-accent hover:underline" href={`${LUCI}/${href}`} target="_blank" rel="noreferrer">
      {children} <IconExternal size={12} />
    </a>
  );
}

/**
 * Internet settings: the primary WAN (status + editor), Smart Queues, UPnP
 * and Dynamic DNS. The last three only show when their package's config
 * exists; otherwise the page links to LuCI.
 */
export function InternetPage() {
  const ifaces = useInterfaces();
  const devices = useDevices(10_000);
  const network = useUci('network');
  const firewall = useUci('firewall');
  // Optional packages: a read error (usually NOT_FOUND: not installed) hides the card.
  const sqm = useUci('sqm');
  const upnpd = useUci('upnpd');
  const ddns = useUci('ddns');
  const [editing, setEditing] = useState(false);

  const wan = useMemo(() => (network.data ? normalizeWan(network.data, firewall.data) : undefined), [network.data, firewall.data]);
  const live = ifaces.data?.interface.find((i) => i.interface === wan?.section);
  const live6 = ifaces.data?.interface.find((i) => i.interface === wan?.v6?.section || i.interface === `${wan?.section}_6`);
  const port = wan ? devices.data?.[wan.port] : undefined;
  const l3 = wan ? wanL3Device(wan, ifaces.data) : undefined;
  const missing = [
    !sqm.data && !sqm.isPending && <LuciLink href="network/sqm">Smart Queues (SQM)</LuciLink>,
    !upnpd.data && !upnpd.isPending && <LuciLink href="services/upnp">UPnP</LuciLink>,
    !ddns.data && !ddns.isPending && <LuciLink href="services/ddns">Dynamic DNS</LuciLink>,
  ].filter(Boolean);

  return (
    <Page title="Internet" subtitle="WAN connection, speed test, Smart Queues, UPnP and Dynamic DNS">
      <LoadError error={firstError(ifaces, network)} />
      {!ifaces.data || !network.data ? (
        <Spinner />
      ) : (
        <div class="grid max-w-4xl grid-cols-1 gap-4">
          {wan ? (
            <WanStatusCard wan={wan} live={live} live6={live6} port={port} onEdit={() => setEditing(true)} />
          ) : (
            <Card title="Primary (WAN1)">
              <p class="text-muted">
                No WAN interface found. <LuciLink href="network/network">Set one up in LuCI</LuciLink>
              </p>
            </Card>
          )}
          <SpeedTestCard />
          {sqm.data && l3 && <SqmCard cfg={sqm.data} wanL3={l3} />}
          {upnpd.data && <UpnpCard cfg={upnpd.data} />}
          {ddns.data && wan && <DdnsCard cfg={ddns.data} wan={wan.section} wan6={wan.v6?.section} />}
          <Card title="Advanced">
            <p class="text-muted">
              Multi-WAN, extra WAN interfaces and tunnels are managed in LuCI: <LuciLink href="network/network">Interfaces</LuciLink>
              {missing.length > 0 && (
                <>
                  . Not installed here (install the package, then configure it in LuCI):{' '}
                  {missing.map((m, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      {m}
                    </span>
                  ))}
                </>
              )}
            </p>
          </Card>
        </div>
      )}
      {editing && wan && network.data && (
        <WanDrawer wan={wan} network={network.data} sqm={sqm.data} portMac={port?.macaddr} onClose={() => setEditing(false)} />
      )}
    </Page>
  );
}
