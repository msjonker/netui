import { describe, expect, it } from 'vitest';
import acl from '../../openwrt/files/usr/share/rpcd/acl.d/netui.json';

// The viewer group is written out in full (rpcd has no group inheritance):
// keep it equal to the admin group's reads, minus what viewers must not get.
describe('ACL', () => {
  it('gives viewers every read except the backup, the user list and secrets, and no writes', () => {
    const admin = structuredClone(acl.netui.read) as Record<string, unknown> & { ubus: Record<string, string[]>; uci: string[] };
    delete admin['cgi-io'];
    delete admin.ubus['netui.users'];
    // cloudflared's config is the tunnel's token; viewers see its state through netui.services tunnel.
    admin.uci = admin.uci.filter((p) => p !== 'cloudflared');
    expect(acl['netui-viewer'].read).toEqual(admin);
    expect('write' in acl['netui-viewer']).toBe(false);
  });

  it('lets a session ask about its own access (role detection)', () => {
    expect(acl.netui.read.ubus.session).toEqual(['access']);
  });
});
