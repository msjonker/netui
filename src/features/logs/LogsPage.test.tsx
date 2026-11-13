import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

// The fake router serves the recorded DL-WRX36 log plus the synthetic
// supplement (test/fakeReads/logs.ts) next to the dev container's clients.

async function openLogs() {
  renderApp('#/logs');
  await screen.findByRole('heading', { name: 'System Log' });
  await screen.findAllByText(/Internet connection lost/);
  return screen.getByRole('main');
}

const listed = () => screen.queryAllByRole('listitem').map((li) => li.textContent ?? '');

beforeEach(() => {
  localStorage.clear();
  resetRouter();
});

describe('System Log', () => {
  it('reads the log and lists recognized events in plain English', async () => {
    const main = await openLogs();
    expect(router.calls).toContainEqual({ object: 'log', method: 'read', args: { lines: 500, stream: false, oneshot: true } });
    expect(within(main).getByText('Internet connected')).toBeTruthy();
    expect(within(main).getAllByText(/Admin login from 192\.168\.1\.137 \(SSH, no password set\)/).length).toBeGreaterThan(0);
    // Repeated ssh logins collapse into one row with a count.
    expect(within(main).getAllByText(/^×\d+$/).length).toBeGreaterThan(0);
    // Kernel chatter stays out of the event list.
    expect(within(main).queryByText(/entered blocking state/)).toBeNull();
  });

  it('links client names to the client', async () => {
    const main = await openLogs();
    fireEvent.click(within(main).getAllByRole('link', { name: 'workstation' })[0]!);
    await waitFor(() => expect(location.hash).toBe('#/clients/00:00:5e:00:53:01'));
  });

  it('filters by category, severity and search text', async () => {
    const main = await openLogs();

    fireEvent.click(within(main).getByRole('button', { name: /^Internet \d+$/ }));
    expect(listed().some((t) => t.includes('Internet connection lost'))).toBe(true);
    expect(listed().some((t) => t.includes('Assigned 192.168.1.137'))).toBe(false);

    fireEvent.click(within(main).getByRole('button', { name: /^All \d+$/ }));
    fireEvent.click(within(main).getByRole('tab', { name: 'Errors' }));
    expect(listed().length).toBeGreaterThan(0);
    expect(listed().every((t) => !t.includes('Internet connected'))).toBe(true);
    expect(listed().some((t) => t.includes('Permission denied'))).toBe(true);

    fireEvent.click(within(main).getByRole('tab', { name: 'All' }));
    fireEvent.input(within(main).getByLabelText('Search events'), { target: { value: 'iphone' } });
    expect(listed()).toEqual([expect.stringContaining('Assigned 192.168.1.142 to iPhone')]);
  });

  it('shows the raw syslog on request', async () => {
    const main = await openLogs();
    fireEvent.click(within(main).getByRole('switch', { name: 'Show raw syslog' }));
    const raw = await within(main).findByRole('list', { name: 'Raw syslog' });
    expect(within(raw).getAllByText(/entered blocking state/).length).toBeGreaterThan(0);
    expect(within(raw).getAllByText('kern.info').length).toBeGreaterThan(0);
  });
});
