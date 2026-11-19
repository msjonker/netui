import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { seedNoRootPassword } from '../../../test/fakeReads/users';
import { sectionsOfType } from '../../api/uci';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const wanZone = () => sectionsOfType(router.configs.firewall!, 'zone').find((z) => z.name === 'wan')!;

beforeEach(() => {
  resetRouter();
  localStorage.clear();
});

describe('Health Check', () => {
  it('finds an open internet zone and fixes it through the review', async () => {
    wanZone().input = 'ACCEPT';
    renderApp('#/settings/health');
    const findings = (await screen.findByRole('heading', { name: 'Findings' })).closest('section')!;
    expect(screen.getByText('1 risk.')).toBeTruthy();
    const row = within(findings).getByText('The router accepts connections from the internet').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Block' }));
    await applyReviewed();
    expect(wanZone().input).toBe('REJECT');
    await screen.findByText('Nothing needs your attention.');
  });

  it('ignores a finding in this browser and can restore it', async () => {
    seedNoRootPassword(router);
    renderApp('#/settings/health');
    const title = await screen.findByText('The router has no root password');
    fireEvent.click(within(title.closest('li')!).getByRole('button', { name: 'Ignore' }));
    await screen.findByText('Nothing needs your attention.');
    const ignored = screen.getByRole('heading', { name: 'Ignored in this browser' }).closest('section')!;
    fireEvent.click(within(ignored).getByRole('button', { name: 'Restore' }));
    await screen.findByText('1 risk.');
    expect(router.writes()).toHaveLength(0);
  });

  it('shows a banner on the dashboard', async () => {
    wanZone().forward = 'ACCEPT';
    renderApp('#/');
    await screen.findByText('Health check: 1 risk.');
  });
});
