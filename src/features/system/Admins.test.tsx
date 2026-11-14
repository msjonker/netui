import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { fastDeps, renderApp } from '../../../test/renderApp';
import { pick, type } from '../../../test/dom';
import type { UciGet } from '../../api/types';
import uciSystem from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.system.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  resetRouter({ system: structuredClone((uciSystem as UciGet).values) });
});

async function card() {
  renderApp('#/settings/system');
  return (await screen.findByRole('heading', { name: 'Admins' })).closest('section') as HTMLElement;
}

const users = () => router.calls.filter((c) => c.object === 'netui.users' && c.method !== 'list');

describe('admins', () => {
  it('adds a read-only user, makes them an admin and removes them', async () => {
    const c = await card();
    const me = within(await within(c).findByRole('list', { name: 'Users' })).getByRole('listitem');
    expect(me.textContent).toMatch(/netui\s*You/);
    // Nobody removes or demotes themselves.
    expect((within(me).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(me).getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);

    fireEvent.click(within(c).getByRole('button', { name: 'Add user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add user' });
    type(dialog, 'Username', 'guest_admin');
    type(dialog, 'Password', 'short');
    expect(within(dialog).getByText('At least 8 characters.')).toBeTruthy();
    type(dialog, 'Password', 'long enough');
    type(dialog, 'Repeat password', 'long enough');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    const row = (await within(c).findByText('guest_admin')).closest('li')!;
    expect(users()[0]!.args).toEqual({ username: 'guest_admin', password: 'long enough', role: 'viewer' });

    pick(row as HTMLElement, 'Role of guest_admin', 'admin');
    await vi.waitFor(() => expect(users()[1]).toMatchObject({ method: 'role', args: { username: 'guest_admin', role: 'admin' } }));

    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove guest_admin?' })).getByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => expect(within(c).queryByText('guest_admin')).toBeNull());
  });
});

describe('read-only users', () => {
  it('see a notice, cannot apply, and get neither backups nor the user list', async () => {
    renderApp('#/settings/system', fastDeps(), { readOnly: true });
    expect(await screen.findByText(/Read-only access/)).toBeTruthy();
    const name = (await screen.findByLabelText('Device name')) as HTMLInputElement;
    fireEvent.input(name, { target: { value: 'changed' } });
    expect((screen.getByRole('button', { name: 'Apply Changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Backup' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Admins' })).toBeNull();
    expect(router.calls.some((c) => c.object === 'netui.users')).toBe(false);
  });
});
