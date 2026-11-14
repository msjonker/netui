import { useMemo } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import { filterOps, normalizeFilters, RESOLVERS, type FilterLevel } from '../../model/contentFilter';
import { networkLabel, type Subnet } from '../../model/network';
import { Button, Card, Dot, Empty } from '../../components/ui';
import { PLAN } from './shared';
import { AdBlockingCard } from './AdBlocking';

const LEVELS: { value: FilterLevel; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'malware', label: 'Malware blocking' },
  { value: 'family', label: 'Family (adult + malware)' },
];

export function ContentFilterTab({
  networks,
  dhcp,
  fw,
  subnets,
}: {
  networks: string[];
  dhcp: UciConfig;
  fw: UciConfig;
  subnets: Subnet[];
}) {
  const apply = useApply();
  const filters = useMemo(() => normalizeFilters(networks, dhcp, fw), [networks, dhcp, fw]);

  return (
    <div class="space-y-4">
      <AdBlockingCard filtered={filters.some((f) => f.level !== 'none')} />
      <Card title="Content Filtering" flush>
        <div class="space-y-2 px-4 pt-3 pb-1 text-xs text-muted">
          <p>
            A filter gives the network’s devices Cloudflare’s filtering DNS servers (replacing any custom DNS set under
            Networks) and blocks other DNS servers on the internet (ports 53 and 853), so devices cannot simply switch.
            Devices pick it up when they renew their address.
          </p>
          <p>
            Not covered: DNS-over-HTTPS in browsers and apps, VPNs, and devices set by hand to use the router for DNS.
            Local names like <span class="font-mono">nas.lan</span> stop resolving on a filtered network.
          </p>
        </div>
        {filters.length === 0 ? (
          <Empty>No local networks.</Empty>
        ) : (
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>Network</th>
                  <th>Filter</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filters.map((f) => {
                  const label = networkLabel(f.network);
                  return (
                    <tr key={f.network}>
                      <td class="font-medium">{label}</td>
                      <td>
                        <select
                          class="input max-w-64"
                          aria-label={`Content filter for ${label}`}
                          value={f.level}
                          disabled={apply.busy}
                          onChange={(e) => {
                            const level = e.currentTarget.value as FilterLevel;
                            void apply.start(filterOps(f, level, { dhcp, fw, subnets }), PLAN);
                          }}
                        >
                          {LEVELS.map((l) => (
                            <option key={l.value} value={l.value} disabled={l.value !== 'none' && !!f.blocker && l.value !== f.level}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td class="whitespace-normal">
                        {f.blocker && f.level === 'none' ? (
                          <span class="text-xs text-muted">{f.blocker}</span>
                        ) : f.incomplete ? (
                          <span class="inline-flex items-center gap-2 text-warn">
                            <Dot tone="warn" /> Partly applied
                            <Button disabled={apply.busy} onClick={() => void apply.start(filterOps(f, f.level, { dhcp, fw, subnets }), PLAN)}>
                              Repair
                            </Button>
                          </span>
                        ) : f.level === 'none' ? (
                          <span class="inline-flex items-center gap-1.5 text-muted">
                            <Dot tone="neutral" /> Off{f.foreignDns.length > 0 && ` · custom DNS ${f.foreignDns.join(', ')}`}
                          </span>
                        ) : (
                          <span class="inline-flex items-center gap-1.5">
                            <Dot tone="ok" /> Cloudflare {RESOLVERS[f.level].v4.join(' / ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
