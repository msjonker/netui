import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { fastDeps, renderApp } from '../../../test/renderApp';
import { seedPackages } from '../../../test/fakeReads/packages';
import type { UciGet } from '../../api/types';
import wrxUhttpd from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.uhttpd.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const uhttpd = () => structuredClone((wrxUhttpd as UciGet).values);

beforeEach(() => {
  sessionStorage.removeItem('netui.insecure-dismissed');
  resetRouter({ uhttpd: uhttpd() });
  seedPackages(router, '', { https: true });
});

// The test page is http://localhost/, a plain HTTP visit.
describe('secure access', () => {
  it('tells an admin on plain HTTP that the connection is not encrypted, until dismissed', async () => {
    renderApp('#/');
    const banner = (await screen.findByText(/This connection is not encrypted/)).closest('div')!;
    expect(within(banner).getByRole('link', { name: 'Open netui over HTTPS' }).getAttribute('href')).toMatch(/^https:\/\/localhost\//);
    fireEvent.click(within(banner).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(/This connection is not encrypted/)).toBeNull();
  });

  it('says nothing to a viewer, nor where the router has no HTTPS', async () => {
    renderApp('#/', fastDeps(), { readOnly: true });
    await screen.findByText(/Read-only access/);
    expect(screen.queryByText(/This connection is not encrypted/)).toBeNull();
    expect(router.calls.some((c) => c.object === 'netui.config' && c.args.config === 'uhttpd')).toBe(false);
  });

  it('offers HTTPS on the System page, and the add-on where it is missing', async () => {
    renderApp('#/settings/system');
    const card = (await screen.findByText('Secure access (HTTPS)')).closest('section, div.rounded-xl, div')!;
    expect(await within(card.parentElement!).findByRole('button', { name: 'Open over HTTPS' })).toBeTruthy();
  });

  it('offers the add-on where HTTPS is missing', async () => {
    seedPackages(router, '', { https: false });
    renderApp('#/settings/system');
    expect(await screen.findByText(/Lets you open netui and LuCI over an encrypted connection, so nobody/)).toBeTruthy();
  });
});
