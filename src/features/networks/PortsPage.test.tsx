import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { fastDeps, renderApp } from '../../../test/renderApp';
import { pick } from '../../../test/dom';
import { applyReviewed, review } from '../../../test/applyFlow';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

async function openPort(name: string, deps = fastDeps()) {
  renderApp('#/settings/ports', deps);
  fireEvent.click(await screen.findByRole('button', { name: `Port ${name}` }));
  return screen.findByRole('complementary');
}

const vlanPorts = (vid: string) =>
  Object.values(router.configs.network!).find((s) => s['.type'] === 'bridge-vlan' && s.vlan === vid)?.ports;

describe('Ports on a VLAN-filtering bridge', () => {
  beforeEach(() => {
    resetRouter({}, 'vlan');
  });

  it('shows each port with its native network and tagged VLANs', async () => {
    renderApp('#/settings/ports');
    const row = (name: string) => screen.getAllByRole('row').find((r) => r.querySelector('td')?.textContent?.trim().startsWith(name))!;
    await screen.findByRole('button', { name: 'Port eth4' });
    expect(row('eth4').textContent).toContain('IOT (20)');
    expect(row('eth2').textContent).toMatch(/LAN \(1\)IOT \(20\)/);
    expect(row('eth1').textContent).toContain('Internet');
  });

  it('tags every other network on a port with Allow All, as a disruptive apply', async () => {
    const deps = fastDeps();
    const sleep = vi.spyOn(deps, 'sleep');
    const drawer = await openPort('eth0', deps);
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Allow All' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    expect((await review()).textContent).toContain('VLAN 20 on br-lan');
    await applyReviewed();
    expect(vlanPorts('20')).toEqual(['eth2:t', 'eth3', 'eth4', 'eth0:t']);
    expect(vlanPorts('1')).toEqual(['eth0:u*', 'eth2:u*', 'eth3:u*']);
    expect(sleep).toHaveBeenCalledWith(4_000);
  });

  it('keeps an extra untagged membership until it is removed', async () => {
    const drawer = await openPort('eth3');
    expect(within(drawer).getByRole('status').textContent).toMatch(/untagged/);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(vlanPorts('20')).toEqual(['eth2:t', 'eth4']);
  });

  it('moves a port to another native network', async () => {
    const drawer = await openPort('eth4');
    pick(drawer, 'Untagged traffic', '1');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(vlanPorts('1')).toEqual(['eth0:u*', 'eth2:u*', 'eth3:u*', 'eth4:u*']);
    expect(vlanPorts('20')).toEqual(['eth2:t', 'eth3']);
  });

  it('does not offer to edit the WAN port', async () => {
    const drawer = await openPort('eth1');
    expect(within(drawer).queryByRole('button', { name: 'Apply Changes' })).toBeNull();
    expect(within(drawer).queryByLabelText('Untagged traffic')).toBeNull();
  });
});

describe('Ports on a plain bridge', () => {
  beforeEach(() => {
    resetRouter({}, 'plain');
  });

  it('takes a port out of the bridge without turning on VLAN filtering', async () => {
    const drawer = await openPort('eth4');
    expect(within(drawer).getByText(/only one network on this bridge/)).toBeTruthy();
    pick(drawer, 'Untagged traffic', '');
    expect(within(drawer).getByText(/taken out of br-lan/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    const bridge = Object.values(router.configs.network!).find((s) => s['.type'] === 'device' && s.name === 'br-lan');
    expect(bridge!.ports).toEqual(['eth0', 'eth2', 'eth3']);
    expect(Object.values(router.configs.network!).some((s) => s['.type'] === 'bridge-vlan')).toBe(false);
  });
});
