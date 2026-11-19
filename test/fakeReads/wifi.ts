// iwinfo reads for the WiFi page, served from the DL-WRX36 recordings
// (phy0 = 5 GHz, phy1 = 2.4 GHz). A wifi-device name ("radio0") is resolved
// through the router's wireless config by band, so test/wireless.ts (radio0 =
// 2.4 GHz) gets the 2.4 GHz lists. iwinfo devices stays [] (built in); tests
// that want live interfaces override it.

import type { FakeReadHandler } from '../fakeRouter';
import type {
  AssocList,
  IwinfoCountryList,
  IwinfoFreqList,
  IwinfoInfo,
  IwinfoSurvey,
  IwinfoTxPowerList,
} from '../../src/api/types';
import freq0 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.freqlist.phy0-ap0.json';
import freq1 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.freqlist.phy1-ap0.json';
import tx0 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.txpowerlist.phy0-ap0.json';
import tx1 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.txpowerlist.phy1-ap0.json';
import cl0 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.countrylist.phy0-ap0.json';
import cl1 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.countrylist.phy1-ap0.json';
import info0 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy0-ap0.json';
import info1 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy1-ap0.json';
import survey0 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy0-ap0.json';
import survey1 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy1-ap0.json';
import assoc0 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.assoclist.phy0-ap0.json';
import assoc1 from '../fixtures/ubus/dl-wrx36/plain/iwinfo.assoclist.phy1-ap0.json';

interface Phy {
  freqlist: IwinfoFreqList;
  txpowerlist: IwinfoTxPowerList;
  countrylist: IwinfoCountryList;
  info: IwinfoInfo;
  survey: IwinfoSurvey;
  assoclist: AssocList;
}

const fiveG: Phy = { freqlist: freq0, txpowerlist: tx0, countrylist: cl0, info: info0, survey: survey0, assoclist: assoc0 };
const twoG: Phy = { freqlist: freq1, txpowerlist: tx1, countrylist: cl1, info: info1, survey: survey1, assoclist: assoc1 };

export const wifiFixtures = { fiveG, twoG };

export const handle: FakeReadHandler = (object, method, args, router) => {
  if (object !== 'iwinfo' || !['freqlist', 'txpowerlist', 'countrylist', 'info', 'survey', 'assoclist'].includes(method)) {
    return undefined;
  }
  const device = String(args.device ?? '');
  const radio = router.current('wireless')?.[device];
  const band = radio ? radio.band : device.startsWith('phy1') ? '2g' : '5g';
  const phy = band === '2g' ? twoG : fiveG;
  return structuredClone(phy[method as keyof Phy]);
};
