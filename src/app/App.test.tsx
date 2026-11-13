import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../api/queries';
import * as ubus from '../api/ubus';
import { resetRouter } from '../../test/fakeRouter';
import { renderApp, session } from '../../test/renderApp';
import { App } from './App';

vi.mock('../api/ubus', async (orig) => ({
  ...(await import('../../test/fakeRouter')).fakeUbusModule(await orig()),
  login: vi.fn(),
}));

function renderSignedOut() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  location.hash = '';
  resetRouter();
  vi.mocked(ubus.login).mockReset();
});

describe('App', () => {
  it('shows login without a session, then the dashboard after signing in', async () => {
    vi.mocked(ubus.login).mockResolvedValue(session);
    renderSignedOut();

    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(ubus.login).toHaveBeenCalledWith('netui', 'pw');
  });

  it('shows a credential error on LoginError', async () => {
    vi.mocked(ubus.login).mockRejectedValue(new ubus.LoginError());
    renderSignedOut();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Invalid username or password');
  });

  it('reports an unreachable router', async () => {
    vi.mocked(ubus.login).mockRejectedValue(new ubus.TransportError('Router unreachable'));
    renderSignedOut();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Cannot reach the router.');
  });

  it('routes to login with a notice when the session expires, keeping the current route', async () => {
    renderApp('#/clients');
    await screen.findByRole('heading', { name: 'Client Devices' });

    ubus.expireSession();

    expect((await screen.findByRole('status')).textContent).toContain('Your session expired');
    expect(location.hash).toBe('#/clients');

    vi.mocked(ubus.login).mockResolvedValue(session);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => screen.getByRole('heading', { name: 'Client Devices' }));
  });

  it('signs out', async () => {
    renderApp();

    fireEvent.click(await screen.findByTitle('Sign out netui'));

    await screen.findByRole('button', { name: 'Sign in' });
  });

  it('renders the dashboard from the recorded router', async () => {
    renderApp();
    await screen.findByText('Online');
    // Hostname from system.board, the LAN subnet from the live interface.
    const board = (await import('../../test/fixtures')).fixtures.systemBoard();
    expect((await screen.findAllByText(board.hostname)).length).toBeGreaterThan(0);
    await screen.findByText('10.231.1.0/24');
  });

  it('offers to review changes left staged on the router', async () => {
    const r = resetRouter();
    r.handle('uci', 'set', { config: 'dhcp', section: 'lan', values: { leasetime: '1h' } });
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));

    await screen.findByText(/leasetime/);
  });
});
