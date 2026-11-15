import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { pick } from '../../../test/dom';
import type { UciConfig } from '../../api/types';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

/** /etc/config/nlbwmon as installed (bench-v2), without the noise. */
const nlbwmon: UciConfig = {
  cfg015d22: {
    '.anonymous': true,
    '.type': 'nlbwmon',
    '.name': 'cfg015d22',
    '.index': 0,
    database_directory: '/var/lib/nlbwmon',
    database_interval: '1',
    local_network: ['192.168.0.0/16', '172.16.0.0/12', '10.0.0.0/8', 'lan'],
  },
};

async function usageTab() {
  renderApp('#/insights');
  fireEvent.click(await screen.findByRole('tab', { name: 'Usage history' }));
}

describe('usage history', () => {
  beforeEach(() => {
    resetRouter({ nlbwmon: structuredClone(nlbwmon) });
  });

  it('ranks devices and applications for this period', async () => {
    await usageTab();
    const devices = (await screen.findByRole('heading', { name: 'Top devices' })).closest('section')!;
    const rows = await within(devices).findAllByRole('listitem');
    // The recorded router WAN traffic is largest; the dev-container laptop is a named client.
    expect(rows[0]!.textContent).toMatch(/f4:52:46:08:dc:a5|This router/);
    expect(within(devices).getByRole('link', { name: 'laptop' })).toBeTruthy();
    const apps = screen.getByRole('heading', { name: 'Top applications' }).closest('section')!;
    expect(within(apps).getAllByRole('listitem')[0]!.textContent).toMatch(/^HTTPS/);
    const exec = router.calls.filter((c) => c.object === 'file' && c.method === 'exec').map((c) => c.args);
    expect(exec).toContainEqual({ command: '/usr/sbin/nlbw', params: ['-c', 'json', '-g', 'mac,layer7'] });
  });

  it('shows an earlier period', async () => {
    await usageTab();
    const select = (await screen.findByRole('combobox', { name: 'Period' })) as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options).toHaveLength(3));
    expect(select.options[1]!.textContent).toMatch(/October 2026/);
    pick(document.body, 'Period', '2026-10-01');
    await vi.waitFor(() =>
      expect(router.calls.some((c) => c.object === 'file' && (c.args.params as string[])?.includes('2026-10-01'))).toBe(true),
    );
  });

  it('moves the database to flash through the apply flow', async () => {
    await usageTab();
    fireEvent.click(await screen.findByRole('switch', { name: 'Keep history across restarts' }));
    await applyReviewed();
    expect(router.configs.nlbwmon!.cfg015d22!.database_directory).toBe('/etc/nlbwmon');
  });

  it('shows a client usage this period in its panel', async () => {
    renderApp('#/clients/02:4e:55:00:01:10');
    expect((await screen.findByText('Usage this period')).nextElementSibling!.textContent).toMatch(/↓ 1\.9 GB \/ ↑ 286\.1 MB/);
  });
});

describe('without nlbwmon', () => {
  it('offers the add-on', async () => {
    resetRouter();
    await usageTab();
    expect(await screen.findByText(/per-application usage by month/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  });
});
