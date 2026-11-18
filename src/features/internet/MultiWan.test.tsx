import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed } from '../../../test/applyFlow';
import { pick } from '../../../test/dom';
import type { UciGet } from '../../api/types';
import mwan3Recorded from '../../../test/fixtures/ubus/bench-v2/gateway.uci.get.mwan3.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const mwan3 = () => structuredClone((mwan3Recorded as UciGet).values);

const findCard = async () => (await screen.findByRole('heading', { name: /^Multi-WAN/ })).closest('section') as HTMLElement;

async function card() {
  renderApp('#/settings/internet');
  return findCard();
}

describe('multi-WAN', () => {
  beforeEach(() => {
    // The VM recording: eth0, eth2-eth4 on br-lan, WAN on eth1.
    resetRouter({ mwan3: mwan3() }, 'plain');
  });

  it('adds WAN2 on a spare port with failover, then shows both connections', async () => {
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Add WAN2' }));
    const drawer = await screen.findByRole('complementary', { name: /WAN2/ });
    pick(drawer, 'Port', 'eth4');
    fireEvent.click(within(drawer).getByRole('radio', { name: /Failover/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    expect(router.configs.network!.wanb).toMatchObject({ proto: 'dhcp', device: 'eth4', metric: '20' });
    expect(router.configs.network!.cfg030f15!.ports).not.toContain('eth4');
    expect(router.configs.mwan3!.wanb!.enabled).toBe('1');
    expect(router.configs.mwan3!.default_rule_v4!.use_policy).toBe('wan_wanb');
    const after = await findCard();
    expect(await within(after).findByText('WAN2 (eth4)')).toBeTruthy();
    expect(within(after).getByText('Failover')).toBeTruthy();
    expect(await within(after).findByText('No connection')).toBeTruthy();
  });

  it('removes WAN2 and gives the port back to the LAN', async () => {
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Add WAN2' }));
    const drawer = await screen.findByRole('complementary', { name: /WAN2/ });
    pick(drawer, 'Port', 'eth4');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    await applyReviewed();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Done' })).getByRole('button', { name: 'OK' }));
    const after = await findCard();
    fireEvent.click(await within(after).findByRole('button', { name: 'Remove WAN2' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove WAN2?' })).getByRole('button', { name: 'Remove' }));
    await applyReviewed();
    expect(router.configs.network!.wanb).toBeUndefined();
    expect(router.configs.network!.cfg030f15!.ports).toContain('eth4');
    expect(router.configs.mwan3!.wanb!.enabled).toBe('0');
  });
});

describe('without mwan3', () => {
  it('offers the add-on', async () => {
    resetRouter({}, 'plain');
    const c = await card();
    expect(c.textContent).toMatch(/second internet connection/);
    expect(within(c).getByRole('heading').textContent).toMatch(/Not installed/);
    expect(within(c).getByRole('button', { name: 'Install' })).toBeTruthy();
  });
});
