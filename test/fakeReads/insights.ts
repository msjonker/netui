// iwinfo scan for the Insights page, from the DL-WRX36 recordings (phy0 =
// 5 GHz, phy1 = 2.4 GHz; SSIDs and BSSIDs anonymised). info, survey and
// assoclist come from wifi.ts; iwinfo devices stays [] unless a test
// overrides it.

import type { FakeReadHandler } from '../fakeRouter';
import type { IwinfoScan } from '../../src/api/types';
import scan0Json from '../fixtures/ubus/dl-wrx36/plain/iwinfo.scan.phy0-ap0.json';
import scan1Json from '../fixtures/ubus/dl-wrx36/plain/iwinfo.scan.phy1-ap0.json';

const scan0: IwinfoScan = scan0Json;
const scan1: IwinfoScan = scan1Json;

export const scanFixtures = { fiveG: scan0, twoG: scan1 };

export const handle: FakeReadHandler = (object, method, args) => {
  if (object !== 'iwinfo' || method !== 'scan') return undefined;
  return structuredClone(String(args.device).startsWith('phy1') ? scan1 : scan0);
};
