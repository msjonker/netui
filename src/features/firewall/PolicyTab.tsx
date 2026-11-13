import { useMemo, useState } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import { networkLabel } from '../../model/network';
import {
  cellOps,
  pingOps,
  pingRule,
  policyMatrix,
  ROUTER,
  wanInputRules,
  type PolicyCell,
  type Verdict,
  type Zone,
} from '../../model/policy';
import { Modal } from '../../components/overlay';
import { IconExternal } from '../../components/icons';
import { Banner, Button, Card, Dot, Pill, Segmented, ToggleRow, cx } from '../../components/ui';
import { LUCI_RULES, PLAN } from './shared';

export function zoneLabel(z: Zone | string | undefined, zones: Zone[]): string {
  if (z === ROUTER || z === undefined) return 'Router';
  const zone = typeof z === 'string' ? zones.find((x) => x.name === z) : z;
  if (!zone) return String(z);
  return zone.internet ? 'Internet' : networkLabel(zone.name);
}

const VIA: Record<PolicyCell['via'], string> = {
  input: 'Set by the zone’s input policy: access to the router itself (web UI, ssh, DNS, DHCP).',
  'zone-forward': 'Set by the zone’s forward policy: traffic between networks in this zone.',
  forwarding: 'Set by a zone forwarding: may devices here open connections there? Replies always get back.',
  default: 'Set by the firewall’s default forward policy.',
};

function Verdicts({ c }: { c: PolicyCell }) {
  const v = <Pill tone={c.verdict === 'allow' ? 'ok' : 'bad'}>{c.verdict === 'allow' ? 'Allow' : 'Block'}</Pill>;
  if (!c.rules.length) return v;
  return (
    <span class="inline-flex flex-col items-start gap-0.5">
      <Pill tone="warn">Custom</Pill>
      <span class="text-[11px] text-muted">
        {c.verdict === 'allow' ? 'Allow' : 'Block'} + {c.rules.length} rule{c.rules.length > 1 ? 's' : ''}
      </span>
    </span>
  );
}

function CellDialog({
  c,
  zones,
  fw,
  uiKnown,
  onClose,
}: {
  c: PolicyCell;
  zones: Zone[];
  fw: UciConfig;
  uiKnown: boolean;
  onClose: () => void;
}) {
  const apply = useApply();
  const [choice, setChoice] = useState<Verdict>(c.verdict);
  const src = zoneLabel(c.src, zones);
  const dest = zoneLabel(c.dest, zones);
  const ops = cellOps(c, choice, fw);
  const editable = !c.locked && c.via !== 'default';
  const toRouter = c.dest === ROUTER;
  const [ack, setAck] = useState(false);
  const cutRisk = toRouter && choice === 'block' && c.verdict === 'allow' && !uiKnown;

  return (
    <Modal
      title={`${src} → ${dest}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{editable ? 'Cancel' : 'Done'}</Button>
          {editable && (
            <Button
              variant={choice === 'block' ? 'danger' : 'primary'}
              disabled={apply.busy || ops.length === 0 || (cutRisk && !ack)}
              onClick={() => {
                onClose();
                void apply.start(ops, { ...PLAN, disruptive: true });
              }}
            >
              {choice === 'allow' ? 'Allow' : 'Block'}
            </Button>
          )}
        </>
      }
    >
      <div class="space-y-3 pb-2">
        <p class="text-muted">{VIA[c.via]}</p>
        {c.locked ? (
          <Banner tone="warn" role="status">
            {c.locked}
          </Banner>
        ) : (
          editable && (
            <Segmented
              label="Policy"
              value={choice}
              onChange={setChoice}
              options={[
                { value: 'allow', label: 'Allow' },
                { value: 'block', label: 'Block' },
              ]}
            />
          )
        )}
        {editable && choice !== c.verdict && (
          <p>
            {choice === 'allow' ? 'Allows' : 'Blocks'} new connections from {src} to {dest}.
            {toRouter && choice === 'block' && ' DHCP and DNS stay open.'}
            {choice === 'block' && zones.find((z) => z.name === c.dest)?.internet && ` Devices on ${src} lose internet access.`}
          </p>
        )}
        {cutRisk && (
          <Banner tone="bad" role="alert">
            <p>
              netui cannot tell which network you use. If it is {src}, this cuts you off and the router undoes it after
              30 seconds.
            </p>
            <label class="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} />I understand
            </label>
          </Banner>
        )}
        {c.rules.length > 0 && (
          <div>
            <h3 class="pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Rules for this pair</h3>
            <ul class="divide-y divide-line rounded-md border border-line">
              {c.rules.map((r) => (
                <li key={r.section} class="flex h-9 items-center gap-2 px-3">
                  <Dot tone={r.target === 'ACCEPT' || r.target === 'DNAT' ? 'ok' : 'bad'} />
                  <span class="min-w-0 flex-1 truncate">{r.name}</span>
                  <span class="text-xs text-muted">{r.target === 'DNAT' ? 'Port forward' : r.target === 'ACCEPT' ? 'Allow' : 'Block'}</span>
                </li>
              ))}
            </ul>
            <p class="pt-1 text-xs text-muted">Rules are checked first and override the policy for what they match.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RouterAccess({ fw }: { fw: UciConfig }) {
  const apply = useApply();
  const ping = pingRule(fw);
  const others = wanInputRules(fw).filter((r) => r.section !== ping?.section);
  return (
    <Card title="Router Access from the Internet">
      <ToggleRow
        label="Respond to ping from the internet"
        hint="IPv4 only. IPv6 ping stays on: IPv6 needs ICMPv6."
        checked={!!ping?.enabled}
        disabled={apply.busy}
        onChange={(on) => void apply.start(pingOps(fw, on), PLAN)}
      />
      <h3 class="pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Other rules opening the router to the internet</h3>
      {others.length === 0 ? (
        <p class="text-muted">None.</p>
      ) : (
        <ul class="divide-y divide-line">
          {others.map((r) => (
            <li key={r.section} class="flex min-h-9 items-center gap-2 py-1">
              <Dot tone={r.enabled ? 'ok' : 'neutral'} />
              <span class="min-w-0 flex-1 truncate">{r.name}</span>
              <span class="font-mono text-xs text-muted">
                {r.proto.toUpperCase()}
                {r.ports && ` ${r.ports}`}
                {r.family && ` · ${r.family === 'ipv6' ? 'IPv6' : 'IPv4'}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p class="pt-2 text-xs text-muted">
        Managed in{' '}
        <a class="inline-flex items-center gap-1 text-accent hover:underline" href={LUCI_RULES} target="_blank" rel="noreferrer">
          LuCI <IconExternal size={12} />
        </a>
        .
      </p>
    </Card>
  );
}

export function PolicyTab({ fw, uiZone }: { fw: UciConfig; uiZone?: string }) {
  const m = useMemo(() => policyMatrix(fw, uiZone), [fw, uiZone]);
  const [sel, setSel] = useState<PolicyCell | null>(null);
  const zones = m.sources;

  return (
    <div class="space-y-4">
      <Card title="Zone Policies" flush>
        <p class="px-4 pt-3 text-xs text-muted">Which zone may open connections to which: rows are sources, columns destinations.</p>
        <div class="overflow-x-auto p-2">
          <table class="table">
            <thead>
              <tr>
                <th>From \ To</th>
                {m.dests.map((d) => (
                  <th key={typeof d === 'string' ? d : d.name}>{zoneLabel(d, zones)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.sources.map((s) => (
                <tr key={s.name}>
                  <td class="font-medium">
                    {zoneLabel(s, zones)}
                    {s.networks.length > 1 && !s.internet && (
                      <div class="text-[11px] font-normal text-muted">{s.networks.map(networkLabel).join(', ')}</div>
                    )}
                    {s.name === uiZone && <div class="text-[11px] font-normal text-muted">You are here</div>}
                  </td>
                  {m.dests.map((d) => {
                    const dest = typeof d === 'string' ? d : d.name;
                    if (s.internet && dest === s.name) {
                      return (
                        <td key={dest} class="text-faint">
                          —
                        </td>
                      );
                    }
                    const c = m.cell(s.name, dest);
                    const label = `${zoneLabel(s, zones)} to ${zoneLabel(d, zones)}: ${c.rules.length ? 'Custom' : c.verdict === 'allow' ? 'Allow' : 'Block'}`;
                    return (
                      <td key={dest} class="py-1">
                        <button
                          type="button"
                          aria-label={label}
                          onClick={() => setSel(c)}
                          class={cx('rounded-md px-2 py-1 text-left hover:bg-hover', c.locked && 'opacity-80')}
                        >
                          <Verdicts c={c} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <RouterAccess fw={fw} />
      {sel && <CellDialog c={sel} zones={zones} fw={fw} uiKnown={uiZone !== undefined} onClose={() => setSel(null)} />}
    </div>
  );
}
