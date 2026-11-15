import { describe, expect, it } from 'vitest';
import fresh from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.fresh.json';
import configured from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.wireless.json';
import zonesRec from '../../test/fixtures/ubus/dl-wrx36/plain/luci.getTimezones.json';
import { FakeRouter, stageOn } from '../../test/fakeRouter';
import type { UciConfig } from '../api/types';
import { normalizeTimezones } from './system';
import {
  browserCountry,
  browserZone,
  isFreshWifi,
  setupWifiOps,
  validateRootPassword,
  validateSetupWifi,
} from './setup';

const freshWifi = (): UciConfig => structuredClone(fresh.values);

describe('first-run setup', () => {
  it('recognises WiFi as a fresh install leaves it, and nothing else', () => {
    expect(isFreshWifi(freshWifi())).toBe(true);
    expect(isFreshWifi(structuredClone(configured.values))).toBe(false);
    const named = freshWifi();
    named.default_radio1!.ssid = 'Home';
    expect(isFreshWifi(named)).toBe(false);
  });

  it('turns every radio on with a name, a password and the country', () => {
    const d = { ssid: 'Home', password: 'correct horse', country: 'US' };
    expect(validateSetupWifi(d)).toEqual({});
    const w = new FakeRouter({ wireless: freshWifi() });
    stageOn(w, setupWifiOps(d, freshWifi()));
    const after = w.current('wireless')!;
    for (const r of ['radio0', 'radio1']) expect(after[r]).toMatchObject({ country: 'US' });
    for (const i of ['default_radio0', 'default_radio1']) {
      expect(after[i]).toMatchObject({ ssid: 'Home', encryption: 'sae-mixed', key: 'correct horse' });
      expect(after[i]!.disabled).toBeUndefined();
    }
    expect(isFreshWifi(after)).toBe(false);
  });

  it('checks the WiFi and the router password', () => {
    expect(validateSetupWifi({ ssid: '', password: 'short', country: '' })).toEqual({
      ssid: 'Give your WiFi a name.',
      password: 'Use 8 to 63 characters.',
      country: 'Choose your country.',
    });
    expect(validateSetupWifi({ ssid: 'x'.repeat(33), password: 'long enough', country: 'NL' }).ssid).toMatch(/32/);
    expect(validateRootPassword('short', 'short')).toMatch(/8/);
    expect(validateRootPassword('long enough', 'long enougH')).toMatch(/match/);
    expect(validateRootPassword('long enough', 'long enough')).toBeUndefined();
  });

  it("starts from the browser's country and timezone", () => {
    expect(browserCountry(['nl', 'en-GB'])).toBe('GB');
    expect(browserCountry(['en'])).toBe('');
    const zones = normalizeTimezones(zonesRec);
    expect(browserZone(zones, 'America/New_York')).toBe('America/New York');
    expect(browserZone(zones, 'Mars/Olympus')).toBeUndefined();
  });
});
