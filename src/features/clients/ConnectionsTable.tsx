import { formatBitrate, formatBytes } from '../../lib/format';
import { traffic } from '../../model/traffic';
import { Empty } from '../../components/ui';

const LIMIT = 100;

/** A client's open connections from the latest connection-table poll, busiest first. */
export function ConnectionsTable({ ips }: { ips: string[] }) {
  const mine = new Set(ips);
  const conns = traffic.conns.filter((c) => mine.has(c.local)).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.bytes - a.bytes);
  if (!conns.length) return <Empty>No open connections.</Empty>;
  return (
    <div class="px-5 py-3">
      <p class="mb-2 text-xs text-muted">
        {conns.length} open connection{conns.length === 1 ? '' : 's'}. Bytes are both directions since the connection opened.
      </p>
      <table class="table text-xs">
        <thead>
          <tr>
            <th>Destination</th>
            <th>Service</th>
            <th class="text-right">Rate</th>
            <th class="text-right">Bytes</th>
          </tr>
        </thead>
        <tbody>
          {conns.slice(0, LIMIT).map((c, i) => (
            <tr key={i}>
              <td class="max-w-[170px] truncate font-mono" title={c.outbound ? undefined : `Inbound from ${c.remote}`}>
                {c.outbound ? '' : '← '}
                {c.remote.includes(':') ? `[${c.remote}]` : c.remote}
                {c.outbound && c.port !== undefined && `:${c.port}`}
              </td>
              <td>
                {c.service} <span class="text-faint">{c.proto.toUpperCase()}</span>
              </td>
              <td class="text-right tabular-nums">{c.rate ? formatBitrate(c.rate, 0) : '—'}</td>
              <td class="text-right tabular-nums">{formatBytes(c.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {conns.length > LIMIT && <p class="mt-2 text-xs text-muted">Showing the busiest {LIMIT}.</p>}
    </div>
  );
}
