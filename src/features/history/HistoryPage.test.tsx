import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed, review } from '../../../test/applyFlow';
import { sectionsOfType } from '../../api/uci';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const wanZone = () => sectionsOfType(router.configs.firewall!, 'zone').find((z) => z.name === 'wan')!;

beforeEach(() => {
  resetRouter();
  localStorage.clear();
});

describe('Change History', () => {
  it('records a change applied from netui and undoes it', async () => {
    // A change from the health check: close the open WAN zone.
    wanZone().input = 'ACCEPT';
    renderApp('#/settings/health');
    const row = (await screen.findByText('The router accepts connections from the internet')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Block' }));
    await applyReviewed();
    expect(wanZone().input).toBe('REJECT');
    const calls = router.calls.filter((c) => c.object === 'netui.history').map((c) => c.method);
    expect(calls).toEqual(['begin', 'record']);

    fireEvent.click(screen.getAllByRole('link', { name: 'Change History' })[0]!);
    const entry = await screen.findByRole('button', { name: /Applied from Health Check/ });
    expect(entry.textContent).toContain('Firewall');
    expect(entry.textContent).toContain('netui');
    fireEvent.click(entry);
    await screen.findByText('REJECT');
    fireEvent.click(screen.getByRole('button', { name: 'Undo This Change' }));
    const dialog = await review();
    expect(dialog.textContent).toContain('ACCEPT');
    await applyReviewed();
    expect(wanZone().input).toBe('ACCEPT');
  });

  it('shows what changed outside netui and records it with the next change', async () => {
    wanZone().input = 'ACCEPT';
    renderApp('#/settings/health');
    const row = (await screen.findByText('The router accepts connections from the internet')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Block' }));
    await applyReviewed();
    // Someone edits the firewall over ssh.
    wanZone().log = '1';
    fireEvent.click(screen.getAllByRole('link', { name: 'Change History' })[0]!);
    await screen.findByText(/Changed outside netui since its last change: Firewall/);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await screen.findByText('log');
    fireEvent.click(screen.getByRole('button', { name: 'Put Back as netui Left It' }));
    await applyReviewed();
    expect(wanZone().log).toBeUndefined();
    // The ssh edit became an entry of its own when the undo began.
    await screen.findByRole('button', { name: /Changed outside netui/ });
  });

  it('starts empty', async () => {
    renderApp('#/settings/history');
    await screen.findByText('No changes recorded yet.');
  });
});
