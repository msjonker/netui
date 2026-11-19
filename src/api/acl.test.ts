import { describe, expect, it } from 'vitest';
import acl from '../../openwrt/files/usr/share/rpcd/acl.d/netui.json';

// The viewer group is written out in full (rpcd has no group inheritance):
// keep it equal to the admin group's reads, minus what viewers must not get.
describe('ACL', () => {
  it('gives viewers every read except the backup, the user list and secrets, and no writes', () => {
    const admin = structuredClone(acl.netui.read) as Record<string, unknown> & { ubus: Record<string, string[]>; uci?: string[] };
    delete admin['cgi-io'];
    delete admin.ubus['netui.users'];
    // No uci at all: configs hold passwords and keys (WireGuard, PPPoE, DDNS,
    // WiFi), and rpcd grants a package whole. Viewers read through
    // netui.config, which leaves those out; cloudflared (all token) not even that.
    delete admin.ubus.uci;
    delete admin.uci;
    expect(acl['netui-viewer'].read).toEqual(admin);
    expect('write' in acl['netui-viewer']).toBe(false);
  });

  it('has viewers read configs only through netui.config', () => {
    const viewer = acl['netui-viewer'].read as { ubus: Record<string, string[]>; uci?: string[] };
    expect(viewer.ubus.uci).toBeUndefined();
    expect(viewer.uci).toBeUndefined();
    expect(viewer.ubus['netui.config']).toEqual(['get']);
  });

  it('lets a session ask about its own access (role detection) and end itself (sign out)', () => {
    expect(acl.netui.read.ubus.session).toEqual(['access', 'destroy']);
  });
});
