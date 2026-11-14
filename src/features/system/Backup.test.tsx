import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { tarball } from '../../../test/tarball';
import { SessionExpiredError } from '../../api/ubus';
import { rebootDeps } from './reboot';
import { moveDeps } from './Backup';
import network from '../../../test/fixtures/backup/dl-wrx36.network?raw';
import system from '../../../test/fixtures/backup/dl-wrx36.system?raw';
import rpcd from '../../../test/fixtures/backup/dl-wrx36.rpcd?raw';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  resetRouter();
  vi.spyOn(rebootDeps, 'sleep').mockResolvedValue(undefined);
  vi.spyOn(rebootDeps, 'probe').mockResolvedValueOnce(false).mockResolvedValue(true);
  vi.spyOn(rebootDeps, 'check').mockRejectedValue(new SessionExpiredError());
  URL.createObjectURL = vi.fn(() => 'blob:backup');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function card() {
  renderApp('#/settings/system');
  return (await screen.findByRole('heading', { name: 'Backup' })).closest('section') as HTMLElement;
}

async function choose(files: Record<string, string>) {
  const file = new File([await tarball(files)], 'backup-OpenWrt-2026-11-14.tar.gz');
  const input = screen.getByLabelText('Backup file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  // What the browser's file picker does. (@testing-library/preact turns
  // fireEvent.change into an input event; see pick() in test/dom.ts.)
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const backup = { 'etc/config/network': network, 'etc/config/system': system, 'etc/config/rpcd': rpcd, 'lib/upgrade/keep.d/netui': '' };

describe('backup', () => {
  it('downloads the router backup', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Download' }));
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    expect(router.calls.some((x) => x.object === 'cgi-io' && x.method === 'backup')).toBe(true);
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toMatch(/^backup-[\w-]+-\d{4}-\d\d-\d\d\.tar\.gz$/);
  });

  it('shows what a backup restores, then restores it and restarts', async () => {
    await card();
    await choose(backup);
    const dialog = await screen.findByRole('dialog', { name: 'Restore this backup?' });
    expect(dialog.textContent).toMatch(/192\.168\.1\.1/);
    expect(dialog.textContent).toMatch(/network, rpcd, system/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore and restart' }));
    expect(await screen.findByText('The backup was restored and the router restarted. Sign in again to continue.')).toBeTruthy();
    const steps = router.calls.filter((x) => ['cgi-io', 'file', 'system'].includes(x.object) && x.method !== 'board' && x.method !== 'info');
    expect(steps.map((x) => `${x.object} ${x.method}`)).toEqual(['cgi-io upload', 'file exec', 'system reboot']);
    expect(steps[0]!.args).toEqual({ path: '/tmp/backup.tar.gz' });
    expect(steps[1]!.args).toEqual({ command: '/sbin/sysupgrade', params: ['--restore-backup', '/tmp/backup.tar.gz'] });
    expect(router.uploads.get('/tmp/backup.tar.gz')).toBeTruthy();
  });

  it('warns when the router moves or the netui login is missing, and follows it', async () => {
    vi.spyOn(moveDeps, 'probe').mockResolvedValue(true);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hostname: '10.231.1.2', assign } as Location);
    await card();
    const moved = network.replace("list ipaddr '192.168.1.1/24'", "list ipaddr '10.0.0.1/24'");
    await choose({ ...backup, 'etc/config/network': moved, 'etc/config/rpcd': rpcd.replace(/config login 'netui'[\s\S]*/, '') });
    const dialog = await screen.findByRole('dialog', { name: 'Restore this backup?' });
    // The fake router's LAN (dev-container recording) is 10.231.1.2.
    expect(dialog.textContent).toMatch(/moves from 10\.231\.1\.2 to 10\.0\.0\.1/);
    expect(dialog.textContent).toMatch(/cannot sign in to netui afterwards/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore and restart' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/10\.0\.0\.1(:\d+)?\//)));
  });

  it('refuses a file that is not a backup', async () => {
    const c = await card();
    await choose({ 'notes.txt': 'hello' });

    expect((await within(c).findByRole('alert')).textContent).toMatch(/not an OpenWrt settings backup/);
    expect(router.calls.some((x) => x.object === 'cgi-io' && x.method === 'upload')).toBe(false);
  });
});
