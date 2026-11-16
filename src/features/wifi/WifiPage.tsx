import { useMemo, useState } from 'preact/hooks';
import { useUci } from '../../api/queries';
import { useClients, useNetworks } from '../../model/hooks';
import { networkLabel } from '../../model/network';
import { SECURITY_LABEL, isolatedNetworks, type Radio, type Wlan } from '../../model/wifi';
import type { Client } from '../../model/clients';
import { IconLock, IconPlus, IconQr, IconWifi, SignalBars } from '../../components/icons';
import { Button, Card, Dot, Empty, Meter, Page, Pill, Spinner } from '../../components/ui';
import { WlanForm } from './WlanForm';
import { RadioForm, pct, useChannelLoad } from './RadioForm';
import { ScheduleCard } from './Schedule';
import { MeshCard } from './Mesh';
import { SteeringCard } from './Steering';
import { ShareWifi } from './ShareWifi';

type Selection =
  | { kind: 'wlan'; id: string }
  | { kind: 'new' }
  | { kind: 'radio'; section: string }
  | { kind: 'schedule'; id: string }
  | null;

/** WiFi experience from the average client signal. */
function experience(dbms: number[]): { dbm: number; label: string } | undefined {
  if (!dbms.length) return undefined;
  const dbm = Math.round(dbms.reduce((a, b) => a + b, 0) / dbms.length);
  const label = dbm >= -60 ? 'Excellent' : dbm >= -70 ? 'Good' : dbm >= -80 ? 'Fair' : 'Poor';
  return { dbm, label };
}

function RadioRow({
  radio,
  clients,
  selected,
  onSelect,
}: {
  radio: Radio;
  clients: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const load = useChannelLoad(radio);
  const noise = load?.noise ?? radio.live?.noise;
  const width = radio.htmode?.replace(/^[A-Z]+/, '');
  return (
    <tr data-clickable aria-selected={selected} onClick={onSelect}>
      <td class="font-medium">{radio.bandLabel}</td>
      <td>
        <span class="inline-flex items-center gap-1.5">
          <Dot tone={!radio.enabled ? 'neutral' : radio.live ? 'ok' : 'warn'} />
          {!radio.enabled ? 'Off' : radio.live ? 'On' : 'Idle'}
        </span>
      </td>
      <td>
        {radio.channel === 'auto' ? 'Auto' : radio.channel}
        {radio.live?.channel && radio.channel === 'auto' && <span class="text-muted"> ({radio.live.channel})</span>}
      </td>
      <td>{width ? `${width} MHz` : '—'}</td>
      <td>
        {radio.txpower !== undefined ? `${radio.txpower} dBm` : 'Auto'}
        {radio.txpower === undefined && radio.live?.txpower !== undefined && (
          <span class="text-muted"> ({radio.live.txpower} dBm)</span>
        )}
      </td>
      <td class="min-w-28">
        {load ? (
          <div class="flex items-center gap-2" title="Share of time the channel was busy">
            <div class="w-16">
              <Meter value={load.busy} tone={load.busy > 0.7 ? 'bad' : load.busy > 0.4 ? 'warn' : 'ok'} />
            </div>
            <span class="tabular-nums">{pct(load.busy)}</span>
          </div>
        ) : (
          <span class="text-faint">—</span>
        )}
      </td>
      <td class="tabular-nums">{noise ? `${noise} dBm` : '—'}</td>
      <td class="tabular-nums">{clients}</td>
      <td>{radio.country ?? '—'}</td>
    </tr>
  );
}

export function WifiPage() {
  const { clients, wifi, wirelessError, firewall } = useClients();
  const { networks } = useNetworks();
  const wireless = useUci('wireless').data;
  const [sel, setSel] = useState<Selection>(null);
  const [share, setShare] = useState<string | null>(null);

  const networkIds = useMemo(() => (networks ?? []).map((n) => n.id), [networks]);
  const isolated = useMemo(() => isolatedNetworks(networkIds, firewall.data), [networkIds, firewall.data]);
  const wlans = wifi?.wlans ?? [];
  const radios = wifi?.radios ?? [];
  // This router's own interfaces only: an access point's ifnames (phy1-ap0, ...) can repeat the router's.
  const onIfaces = (ifnames: (string | undefined)[]) => (c: Client) =>
    !!c.wireless && !c.wireless.ap && ifnames.includes(c.wireless.ifname);
  // A network's clients include those on access points broadcasting it.
  const wlanClients = (w: Wlan) =>
    clients.filter((c) => onIfaces(w.members.map((m) => m.ifname))(c) || (!!c.wireless?.ap && c.wireless.ssid === w.ssid));
  const radioClients = (r: Radio) =>
    clients.filter(onIfaces(wlans.flatMap((w) => w.members.filter((m) => m.radio === r.section).map((m) => m.ifname)))).length;

  const current = sel?.kind === 'wlan' ? wlans.find((w) => w.id === sel.id) : undefined;
  const radio = sel?.kind === 'radio' ? radios.find((r) => r.section === sel.section) : undefined;
  const sharing = wlans.find((w) => w.id === share);

  if (wirelessError) {
    return (
      <Page title="WiFi">
        <Card>
          <Empty>
            This router has no wireless configuration.
            <br />
            <span class="text-xs">({wirelessError.message})</span>
          </Empty>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="WiFi"
      subtitle="Wireless networks broadcast by this router"
      actions={
        <Button variant="primary" onClick={() => setSel({ kind: 'new' })} disabled={radios.length === 0}>
          <IconPlus size={14} /> Create New
        </Button>
      }
    >
      <div class="space-y-4">
        <Card flush>
          {!wifi ? (
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          ) : wlans.length === 0 ? (
            <Empty>No WiFi networks yet.</Empty>
          ) : (
            <div class="overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Network</th>
                    <th>Bands</th>
                    <th>Security</th>
                    <th>Clients</th>
                    <th>Experience</th>
                    <th>
                      <span class="sr-only">Share</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {wlans.map((w) => {
                    const live = w.members.some((m) => m.ifname);
                    const cs = wlanClients(w);
                    const exp = experience(cs.map((c) => c.wireless!.signal));
                    return (
                      <tr
                        key={w.id}
                        data-clickable
                        aria-selected={sel?.kind === 'wlan' && sel.id === w.id}
                        onClick={() => setSel({ kind: 'wlan', id: w.id })}
                      >
                        <td>
                          <span class="flex items-center gap-2.5 font-medium">
                            <IconWifi size={16} class={w.enabled && !w.radioOff ? 'text-accent' : 'text-faint'} />
                            {w.ssid || <span class="text-muted">(no name)</span>}
                            {w.isolate && isolated.includes(w.network[0] ?? '') && <Pill tone="accent">Guest</Pill>}
                            {w.hidden && <Pill>Hidden</Pill>}
                          </span>
                        </td>
                        <td>
                          <span class="inline-flex items-center gap-1.5">
                            <Dot tone={!w.enabled ? 'neutral' : live ? 'ok' : 'warn'} />
                            {!w.enabled ? 'Disabled' : live ? 'Broadcasting' : w.radioOff ? 'Radio off' : 'Not running'}
                          </span>
                        </td>
                        <td>{w.network.map(networkLabel).join(', ') || '—'}</td>
                        <td>
                          <span class="flex gap-1">
                            {w.members.map((m) => (
                              <Pill key={m.section} tone={m.ifname ? 'accent' : 'neutral'}>
                                {m.bandLabel}
                              </Pill>
                            ))}
                          </span>
                        </td>
                        <td>
                          <span class="inline-flex items-center gap-1.5 text-muted">
                            {w.security !== 'none' && <IconLock size={13} />}
                            {SECURITY_LABEL[w.security]}
                          </span>
                        </td>
                        <td class="tabular-nums">{cs.length}</td>
                        <td>
                          {exp ? (
                            <span class="inline-flex items-center gap-1.5" title={`Average signal ${exp.dbm} dBm`}>
                              <SignalBars dbm={exp.dbm} />
                              {exp.label}
                            </span>
                          ) : (
                            <span class="text-faint">—</span>
                          )}
                        </td>
                        <td class="text-right">
                          <button
                            type="button"
                            aria-label={`Share ${w.ssid}`}
                            class="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShare(w.id);
                            }}
                          >
                            <IconQr size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Radios" flush>
          {radios.length === 0 ? (
            <Empty>{wifi ? 'No radios found.' : <Spinner />}</Empty>
          ) : (
            <div class="overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>Status</th>
                    <th>Channel</th>
                    <th>Width</th>
                    <th>Tx power</th>
                    <th>Utilisation</th>
                    <th>Noise</th>
                    <th>Clients</th>
                    <th>Country</th>
                  </tr>
                </thead>
                <tbody>
                  {radios.map((r) => (
                    <RadioRow
                      key={r.section}
                      radio={r}
                      clients={radioClients(r)}
                      selected={sel?.kind === 'radio' && sel.section === r.section}
                      onSelect={() => setSel({ kind: 'radio', section: r.section })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <MeshCard />

        <SteeringCard />

        <ScheduleCard
          sel={sel?.kind === 'schedule' ? sel.id : null}
          setSel={(id) => setSel(id === null ? null : { kind: 'schedule', id })}
        />
      </div>

      {wireless && sel?.kind === 'new' && (
        <WlanForm
          wlans={wlans}
          radios={radios}
          networks={networkIds}
          isolated={isolated}
          wireless={wireless}
          onClose={() => setSel(null)}
        />
      )}
      {wireless && current && (
        <WlanForm
          key={current.id}
          wlan={current}
          wlans={wlans}
          radios={radios}
          networks={networkIds}
          isolated={isolated}
          wireless={wireless}
          onClose={() => setSel(null)}
        />
      )}
      {wireless && radio && (
        <RadioForm
          key={radio.section}
          radio={radio}
          wireless={wireless}
          clients={radioClients(radio)}
          onClose={() => setSel(null)}
        />
      )}
      {sharing && <ShareWifi wlan={sharing} onClose={() => setShare(null)} />}
    </Page>
  );
}
