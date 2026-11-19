// netui.config get: what read-only sessions read instead of `uci get`.

import type { FakeReadHandler } from '../fakeRouter';
import { CONFIG_PACKAGES, maskConfig } from '../../src/demo/configMask';

export const handle: FakeReadHandler = (object, method, args, router) => {
  if (object !== 'netui.config' || method !== 'get') return undefined;
  const config = String(args.config ?? '');
  const cfg = CONFIG_PACKAGES.includes(config) ? router.current(config) : undefined;
  return cfg ? { values: maskConfig(structuredClone(cfg)) } : { error: 'not found' };
};
