import { describe, expect, it } from 'vitest';
import type { NlbwTable } from '../api/types';
import recorded from '../../test/fixtures/ubus/bench-v2/gateway.nlbw.json.mac-layer7.json';
import { mergeHosts, normalizeUsage, periodLabel } from './usage';

const table: NlbwTable = recorded;

describe('usage', () => {
  it('sums the recorded rows per host and application', () => {
    const u = normalizeUsage(table);
    // The all-zero MAC and empty rows are dropped.
    expect(u.hosts.map((h) => h.mac)).toEqual(['f4:52:46:08:dc:a5', 'f4:52:46:08:dc:a6', '8c:de:f9:b6:f3:24']);
    const wan = u.hosts[0]!;
    expect(wan.rx).toBe(4956757829 + 1821480687 + 85118 + 21084);
    expect(wan.apps.map((a) => a.name)).toEqual(['HTTPS', 'Other', 'HTTP', 'ICMP']);
    expect(u.apps[0]).toMatchObject({ name: 'HTTPS', rx: 4956757829 });
    expect(u.rx).toBe(u.hosts.reduce((n, h) => n + h.rx, 0));
  });

  it('reads the columns by name, whatever their order', () => {
    const u = normalizeUsage({ columns: ['mac', 'tx_bytes', 'rx_bytes', 'conns'], data: [['AA:BB:CC:DD:EE:FF', 5, 10, 1]] });
    expect(u.hosts[0]).toMatchObject({ mac: 'aa:bb:cc:dd:ee:ff', rx: 10, tx: 5, apps: [{ name: 'Other', rx: 10, tx: 5 }] });
  });

  it("merges the router's own addresses into one device", () => {
    const u = normalizeUsage(table);
    const merged = mergeHosts(u.hosts, new Set(['f4:52:46:08:dc:a5', 'f4:52:46:08:dc:a6']), 'router');
    expect(merged.map((h) => h.mac)).toEqual(['router', '8c:de:f9:b6:f3:24']);
    expect(merged[0]!.tx).toBe(u.hosts[0]!.tx + u.hosts[1]!.tx);
  });

  it('labels periods', () => {
    expect(periodLabel('2026-10-01')).toMatch(/October 2026/);
    expect(periodLabel('2026-10-15')).toMatch(/^From /);
  });
});
