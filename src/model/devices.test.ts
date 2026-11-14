import { describe, expect, it } from 'vitest';
import type { ManagedDeviceList, PendingDeviceList, SyncResult } from '../api/types';
import listJson from '../../test/fixtures/ubus/bench-v2/netui.devices.list.json';
import discoverJson from '../../test/fixtures/ubus/bench-v2/netui.devices.discover.json';
import syncJson from '../../test/fixtures/ubus/bench-v2/netui.devices.sync.json';
import { firmwareVersion, hostnameFor, sortDevices, suggestedName } from './devices';

// Plain assignments: tsc checks the recordings against the types.
const list: ManagedDeviceList = listJson;
const discovered: PendingDeviceList = discoverJson;
const synced: SyncResult = syncJson;

describe('devices', () => {
  it('reads the recorded adopted AX3600', () => {
    const [ap] = list.devices;
    expect(ap).toMatchObject({ name: 'Office AP', model: 'Xiaomi AX3600', online: true });
    expect(firmwareVersion(ap!.release)).toBe('25.12.6');
    expect(synced.devices[ap!.mac]).toMatchObject({ result: true, networks: 2, skipped: [] });
  });

  it('keeps the revision for snapshots and passes unknown strings through', () => {
    expect(firmwareVersion('OpenWrt SNAPSHOT r0-957029c3')).toBe('SNAPSHOT r0-957029c3');
    expect(firmwareVersion('Custom build')).toBe('Custom build');
    expect(firmwareVersion(undefined)).toBeUndefined();
  });

  it("suggests a name from the hostname unless it is OpenWrt's default", () => {
    const [p] = discovered.devices;
    expect(p!.hostname).toBe('OpenWrt');
    expect(suggestedName(p!)).toBe('Xiaomi AX3600 AP');
    expect(suggestedName({ ...p!, hostname: 'garage' })).toBe('garage');
  });

  it('puts online devices first, then sorts by name', () => {
    const d = (name: string, online: boolean) => ({ mac: name, name, online });
    expect(sortDevices([d('b', false), d('c', true), d('a', true)]).map((x) => x.name)).toEqual(['a', 'c', 'b']);
  });

  it('turns a name into the hostname the plugin sets', () => {
    expect(hostnameFor('Office AP')).toBe('Office-AP');
    expect(hostnameFor('  Kids room / upstairs ')).toBe('Kids-room-upstairs');
    expect(hostnameFor('!!!')).toBe('netui-ap');
  });
});
