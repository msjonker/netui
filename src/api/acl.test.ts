import { describe, expect, it } from 'vitest';
import acl from '../../openwrt/files/usr/share/rpcd/acl.d/netui.json';

// The viewer group is written out in full (rpcd has no group inheritance):
// keep it equal to the admin group's reads, minus what viewers must not get.
describe('ACL', () => {
  it('gives viewers every read except the backup and the user list, and no writes', () => {
    const admin = structuredClone(acl.netui.read) as Record<string, unknown> & { ubus: Record<string, string[]> };
    delete admin['cgi-io'];
    delete admin.ubus['netui.users'];
    expect(acl['netui-viewer'].read).toEqual(admin);
    expect('write' in acl['netui-viewer']).toBe(false);
  });

  it('lets a session ask about its own access (role detection)', () => {
    expect(acl.netui.read.ubus.session).toEqual(['access']);
  });
});
