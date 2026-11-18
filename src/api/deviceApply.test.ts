import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRouter, router } from '../../test/fakeRouter';
import { recorded, seedDevices } from '../../test/fakeReads/devices';
import { deviceApplyDeps, deviceApplyTarget } from './devices';
import { TransportError, UbusError } from './ubus';

vi.mock('./ubus', async (orig) => (await import('../../test/fakeRouter')).fakeUbusModule(await orig()));

const mac = recorded.device.mac;

beforeEach(() => {
  resetRouter();
  seedDevices(router, { managed: [recorded.device] });
});

describe('applying on an access point', () => {
  it('stages through the relay and lists the staged changes for review', async () => {
    const t = deviceApplyTarget(mac);
    await t.stage([{ op: 'set', config: 'network', section: 'lan', values: { device: 'br-lan.1' } }]);
    expect(await t.changes()).toEqual({ network: [['set', 'lan', 'device', 'br-lan.1']] });
    await t.revert(['network']);
    expect(await t.changes()).toEqual({});
  });

  it('treats an access point that does not answer as a dropped connection, to retry until the deadline', async () => {
    router.overrides.push((c) => (c.object === 'netui.devices' && c.method === 'call' ? { error: 'unreachable' } : undefined));
    await expect(deviceApplyDeps(mac).confirm()).rejects.toBeInstanceOf(TransportError);
  });

  it('passes on "nothing pending": the access point already rolled back', async () => {
    router.overrides.push((c) => (c.object === 'netui.devices' && c.method === 'call' ? { status: 5 } : undefined));
    await expect(deviceApplyDeps(mac).confirm()).rejects.toSatisfy((e) => e instanceof UbusError && e.status === 5);
  });
});
