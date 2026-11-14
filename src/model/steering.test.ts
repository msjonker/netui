import { describe, expect, it } from 'vitest';
import type { UciGet } from '../api/types';
import usteerJson from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.usteer.json';
import wirelessJson from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.wireless.mesh.json';
import { readSteering, steeringOps } from './steering';

// Plain assignments: tsc checks the recordings against the types.
const usteer: UciGet = usteerJson;
const wireless: UciGet = wirelessJson;

describe('client steering', () => {
  it("reads usteer's stock config as band steering on, roaming assistant and minimum signal off", () => {
    expect(readSteering(usteer.values)).toEqual({ bandSteering: true, roaming: false, minSignal: 0 });
  });

  it('turns the roaming assistant on, with BSS transition and 802.11k on the LAN WiFi', () => {
    const ops = steeringOps({ bandSteering: true, roaming: true, minSignal: -75 }, usteer.values, wireless.values);
    expect(ops[0]).toEqual({
      op: 'set',
      config: 'usteer',
      section: 'cfg01ef5d',
      values: { band_steering_threshold: '5', roam_scan_snr: '-70', roam_trigger_snr: '-75', min_snr: '-75' },
    });
    // Both recorded LAN networks have 802.11k already but not BSS transition; the mesh is left alone.
    expect(ops.slice(1)).toEqual([
      { op: 'set', config: 'wireless', section: 'default_radio0', values: { bss_transition: '1', ieee80211k: '1' } },
      { op: 'set', config: 'wireless', section: 'default_radio1', values: { bss_transition: '1', ieee80211k: '1' } },
    ]);
  });

  it('turns band steering off without touching WiFi, and changes nothing when nothing changed', () => {
    const off = steeringOps({ bandSteering: false, roaming: false, minSignal: 0 }, usteer.values, wireless.values);
    expect(off).toEqual([
      { op: 'set', config: 'usteer', section: 'cfg01ef5d', values: { band_steering_threshold: '0', roam_scan_snr: '0', roam_trigger_snr: '0', min_snr: '0' } },
    ]);
    const cfg = structuredClone(usteer.values);
    Object.assign(cfg.cfg01ef5d!, { band_steering_threshold: '5', roam_scan_snr: '0', roam_trigger_snr: '0', min_snr: '0' });
    expect(steeringOps({ bandSteering: true, roaming: false, minSignal: 0 }, cfg, wireless.values)).toEqual([]);
  });
});
