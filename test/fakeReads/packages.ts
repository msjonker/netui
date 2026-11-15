// netui.packages for component tests: the recorded add-on states, per router
// and per access point. An install reports "installing" once, then the add-on
// is installed; installing ad blocking also creates its config, as the
// package does, so the feature appears afterwards.

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import type { AddonKey, PackagesStatus, UciGet } from '../../src/api/types';
import idle from '../fixtures/ubus/bench-v2/netui.packages.status.idle.json';
import installing from '../fixtures/ubus/bench-v2/netui.packages.status.installing.json';
import installed from '../fixtures/ubus/bench-v2/netui.packages.status.installed.json';
import adblockConfig from '../fixtures/ubus/bench-v2/gateway.uci.get.adblock-fast.json';

interface State {
  status: PackagesStatus;
  /** The job finishes on the next status read. */
  pending?: { addon: AddonKey; action: 'install' | 'remove' };
}

const states = new WeakMap<FakeRouter, Map<string, State>>();

function stateOf(r: FakeRouter, mac: string): State {
  let m = states.get(r);
  if (!m) states.set(r, (m = new Map()));
  let s = m.get(mac);
  if (!s) m.set(mac, (s = { status: structuredClone(idle) as PackagesStatus }));
  return s;
}

export function seedPackages(r: FakeRouter, mac: string, addons: Partial<Record<AddonKey, boolean>>): void {
  const s = stateOf(r, mac);
  for (const [k, v] of Object.entries(addons)) s.status.addons[k as AddonKey] = { installed: v };
}

export function packagesCall(router: FakeRouter, mac: string, method: string, args: Record<string, unknown>): unknown {
  const s = stateOf(router, mac);
  const addon = args.addon as AddonKey;
  if (method === 'install' || method === 'remove') {
    if (!(addon in s.status.addons)) return { error: 'unknown add-on' };
    if (method === 'remove' && addon === 'mesh') return { error: 'this add-on cannot be removed from netui' };
    s.pending = { addon, action: method };
    const job = structuredClone((installing as PackagesStatus).job!);
    s.status.job = { ...job, addon, action: method };
    return { result: true };
  }
  if (method !== 'status') return undefined;
  const out = structuredClone(s.status);
  if (s.pending) {
    const { addon, action } = s.pending;
    s.pending = undefined;
    const done = structuredClone((installed as PackagesStatus).job!);
    s.status.job = { ...done, addon, action };
    s.status.addons[addon] = { installed: action === 'install' };
    if (addon === 'adblock' && action === 'install' && !mac) router.configs['adblock-fast'] = structuredClone((adblockConfig as UciGet).values);
  }
  return out;
}

export const handle: FakeReadHandler = (object, method, args, router) =>
  object === 'netui.packages' ? packagesCall(router, '', method, args) : undefined;
