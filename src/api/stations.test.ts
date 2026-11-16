import { describe, expect, it } from 'vitest';
import { sampleStations, stationRate } from './queries';
import type { AssocStation } from './types';

const sta = (mac: string, down: number, up: number): AssocStation => ({
  mac,
  signal: -50,
  noise: -95,
  inactive: 0,
  // The AP's view: tx is what it sent to the client.
  rx: { rate: 866700, packets: 1, bytes: up },
  tx: { rate: 866700, packets: 1, bytes: down },
});

describe('station rates', () => {
  it('samples each interface at its own poll, so one updating first does not zero the other', () => {
    const a = (down: number, at: number) => ({ ifname: 'phy0-ap0', stations: [sta('AA:00:00:00:00:01', down, 0)], at });
    const b = (down: number, at: number) => ({ ifname: 'phy1-ap0', stations: [sta('AA:00:00:00:00:02', down, 0)], at });
    sampleStations([a(0, 1000), b(0, 1000)]);
    // phy0-ap0's next poll lands first; phy1-ap0 still shows the previous one.
    sampleStations([a(3000, 4000), b(0, 1000)]);
    sampleStations([a(3000, 4000), b(6000, 4010)]);
    expect(stationRate('aa:00:00:00:00:01')?.down).toBe(1000);
    expect(stationRate('aa:00:00:00:00:02')?.down).toBeCloseTo(6000 / 3.01, 3);
  });
});
