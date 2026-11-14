import { describe, expect, it } from 'vitest';
import { tarball } from '../../test/tarball';
import { BackupError, readBackup, uciValues } from './backup';
import network from '../../test/fixtures/backup/dl-wrx36.network?raw';
import system from '../../test/fixtures/backup/dl-wrx36.system?raw';
import list from '../../test/fixtures/backup/dl-wrx36.list.txt?raw';
import rpcd from '../../test/fixtures/backup/dl-wrx36.rpcd?raw';

/** The recorded backup's file list, with the recorded network and system configs. */
async function recordedBackup(over: Record<string, string> = {}) {
  const files: Record<string, string> = {};
  for (const f of list.split('\n').filter(Boolean)) files[f] = '';
  return tarball({ ...files, 'etc/config/network': network, 'etc/config/system': system, 'etc/config/rpcd': rpcd, ...over });
}

describe('backup', () => {
  it('reads what a DL-WRX36 backup would restore', async () => {
    const info = await readBackup(await recordedBackup());
    expect(info).toMatchObject({ hostname: 'OpenWrt', lanAddress: '192.168.1.1', netui: true });
    expect(info.configs).toEqual(expect.arrayContaining(['network', 'wireless', 'firewall', 'dhcp', 'rpcd', 'usteer']));
    expect(info.logins).toEqual(['root', 'netui']);
  });

  it('notices a backup that moves the router', async () => {
    const moved = network.replace("list ipaddr '192.168.1.1/24'", "option ipaddr '10.0.0.1'");
    expect((await readBackup(await recordedBackup({ 'etc/config/network': moved }))).lanAddress).toBe('10.0.0.1');
    const dhcp = network.replace("option proto 'static'\n\tlist ipaddr '192.168.1.1/24'", "option proto 'dhcp'");
    expect((await readBackup(await recordedBackup({ 'etc/config/network': dhcp }))).lanAddress).toBeUndefined();
  });

  it('refuses files that are not settings backups', async () => {
    await expect(readBackup(new Blob(['hello']))).rejects.toBeInstanceOf(BackupError);
    await expect(readBackup(await tarball({ 'photos/cat.jpg': 'x' }))).rejects.toThrow(/no network or system settings/);
  });

  it('reads UCI options and lists', () => {
    expect(uciValues(network, 'device', 'ports')).toEqual(['lan1', 'lan2', 'lan3', 'lan4']);
    expect(uciValues(network, 'interface', 'proto', 'wan')).toEqual(['dhcp']);
    expect(uciValues(system, 'timeserver', 'server', 'ntp')).toHaveLength(4);
  });
});
