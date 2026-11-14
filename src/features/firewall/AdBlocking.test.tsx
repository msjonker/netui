import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { type } from '../../../test/dom';
import type { UciGet } from '../../api/types';
import recorded from '../../../test/fixtures/ubus/bench-v2/gateway.uci.get.adblock-fast.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const adblock = () => structuredClone((recorded as UciGet).values);

async function card() {
  renderApp('#/settings/security');
  fireEvent.click(await screen.findByRole('tab', { name: 'Ad Blocking & Filtering' }));
  return (await screen.findByRole('heading', { name: 'Ad blocking' })).closest('section') as HTMLElement;
}

describe('ad blocking', () => {
  beforeEach(() => {
    resetRouter({ 'adblock-fast': adblock() });
  });

  it('turns blocking on with the suggested list, then downloads it after the apply', async () => {
    const c = await card();
    expect(await within(c).findByText('Off')).toBeTruthy();
    fireEvent.click(within(c).getByRole('switch', { name: 'Block ads and trackers' }));
    const lists = within(c).getByRole('group', { name: 'Block lists' });
    expect((within(lists).getByRole('checkbox', { name: /Hagezi - Pro/ }) as HTMLInputElement).checked).toBe(true);
    type(c, 'Never block', 'shop.example.com');
    fireEvent.click(within(c).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    const cfg = router.configs['adblock-fast']!;
    expect(cfg.config).toMatchObject({ enabled: '1', allowed_domain: ['cdn.jsdelivr.net', 'shop.example.com'] });
    expect(Object.values(cfg).find((s) => s.name === 'Hagezi - Pro')!.enabled).toBe('1');
    expect(router.calls.some((x) => x.object === 'netui.services' && x.method === 'adblock_apply')).toBe(true);
    expect(await screen.findByText(/Blocking 227,848 domains/, {}, { timeout: 8000 })).toBeTruthy();
  }, 12_000);

  it('does not accept a bad domain', async () => {
    const c = await card();
    fireEvent.click(await within(c).findByRole('switch', { name: 'Block ads and trackers' }));
    type(c, 'Also block', 'not a domain!');
    expect(within(c).getByText(/is not a domain name/)).toBeTruthy();
    expect((within(c).getByRole('button', { name: 'Apply Changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('without adblock-fast', () => {
  it('says what to install', async () => {
    resetRouter();
    const c = await card();
    expect(c.textContent).toMatch(/Install adblock-fast/);
  });
});
