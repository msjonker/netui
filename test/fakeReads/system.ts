// luci getTimezones/getLocaltime and system reboot, from the DL-WRX36 recordings.
import type { FakeReadHandler } from '../fakeRouter';
import type { LuciLocaltime, LuciTimezones } from '../../src/api/types';
import timezones from '../fixtures/ubus/dl-wrx36/plain/luci.getTimezones.json';
import localtime from '../fixtures/ubus/dl-wrx36/plain/luci.getLocaltime.json';

const zones: LuciTimezones = timezones;
const time: LuciLocaltime = localtime;

export const handle: FakeReadHandler = (object, method) => {
  if (object === 'luci' && method === 'getTimezones') return structuredClone(zones);
  if (object === 'luci' && method === 'getLocaltime') return { ...time };
  // The real call returns no data; any value marks it handled.
  if (object === 'system' && method === 'reboot') return {};
  return undefined;
};
