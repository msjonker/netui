import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { fastDeps, renderApp } from '../../../test/renderApp';
import { type } from '../../../test/dom';
import { applyReviewed, review } from '../../../test/applyFlow';
import { TransportError, UbusError, UbusStatus } from '../../api/ubus';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

async function openLan(deps = fastDeps()) {
  renderApp('#/settings/networks', deps);
  fireEvent.click(await screen.findByText('10.231.1.2'));
  return screen.findByRole('complementary');
}

beforeEach(() => {
  resetRouter();
});

describe('Networks', () => {
  it('shows the LAN with its DHCP range', async () => {
    renderApp('#/settings/networks');
    await screen.findByText('10.231.1.2');
    expect(screen.getByText('10.231.1.0/24')).toBeTruthy();
    expect(screen.getByText('10.231.1.100 – 249')).toBeTruthy();
  });

  it('changes the DHCP range as start/limit', async () => {
    const drawer = await openLan();
    type(drawer, 'Range start', '10.231.1.20');
    type(drawer, 'Range end', '10.231.1.69');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.dhcp!.lan).toMatchObject({ start: '20', limit: '50', leasetime: '12h' });
    // A DHCP change does not move the router: normal holdoff.
    expect(router.configs.network!.lan!.ipaddr).toEqual(['10.231.1.2/24']);
  });

  it('moving the router address keeps the pool and treats the apply as disruptive', async () => {
    const deps = fastDeps();
    const sleep = vi.spyOn(deps, 'sleep');
    const drawer = await openLan(deps);
    type(drawer, 'Router IP', '10.231.5.1');
    expect((within(drawer).getByLabelText('Range start') as HTMLInputElement).value).toBe('10.231.5.100');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    expect((await review()).textContent).toContain('10.231.5.1');
    await applyReviewed();
    expect(router.configs.network!.lan!.ipaddr).toEqual(['10.231.5.1/24']);
    expect(router.configs.dhcp!.lan).toMatchObject({ start: '100', limit: '150' });
    // Not loaded from 10.231.1.2, so the UI stays where it is: no probing.
    expect(deps.probe).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(4_000);
  });

  it('refuses a subnet that overlaps another network', async () => {
    const drawer = await openLan();
    type(drawer, 'Router IP', '10.231.0.1');

    expect((await within(drawer).findAllByRole('alert'))[0]!.textContent).toMatch(/overlap/i);
    expect((within(drawer).getByRole('button', { name: 'Apply Changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a fixed IP and adds another', async () => {
    const drawer = await openLan();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove laptop' }));
    type(drawer, 'MAC address', 'aa:bb:cc:dd:ee:ff');
    type(drawer, 'Fixed IP', '10.231.1.60');
    type(drawer, 'Name', 'printer');
    fireEvent.click(within(drawer).getByRole('button', { name: /Add/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    const hosts = Object.values(router.configs.dhcp!).filter((s) => s['.type'] === 'host');
    expect(hosts).toEqual([expect.objectContaining({ mac: ['AA:BB:CC:DD:EE:FF'], ip: '10.231.1.60', name: 'printer' })]);
  });
});

describe('apply dialog', () => {
  it('reports a rollback when the router never confirms, and reverts what came back', async () => {
    // confirm keeps failing as if the router were unreachable; then the
    // router rolls back on its own, restoring the staged changes.
    router.overrides.push((c) => {
      if (c.object !== 'uci' || c.method !== 'confirm') return undefined;
      router.rollBack();
      return new TransportError('Router unreachable');
    });
    const drawer = await openLan();
    type(drawer, 'Range start', '10.231.1.20');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    fireEvent.click(within(await review()).getByRole('button', { name: 'Apply Changes' }));

    const done = await screen.findByRole('dialog', { name: 'Changes not applied' });
    expect(done.textContent).toMatch(/revert/i);
    expect(router.configs.dhcp!.lan!.start).toBe('100');
    // The restored staged changes were reverted, so nothing is left behind.
    expect(router.calls.some((c) => c.method === 'revert')).toBe(true);
    expect(router.current('dhcp')).toEqual(router.configs.dhcp);
  });

  it('offers to retry when another apply is still pending', async () => {
    // Status 6 on apply: the router still holds an unconfirmed apply.
    let busy = true;
    router.overrides.push((c) =>
      busy && c.object === 'uci' && c.method === 'apply' ? new UbusError(UbusStatus.PERMISSION_DENIED, 'uci', 'apply') : undefined,
    );
    const drawer = await openLan();
    type(drawer, 'Range start', '10.231.1.20');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));
    fireEvent.click(within(await review()).getByRole('button', { name: 'Apply Changes' }));

    const blocked = await screen.findByRole('dialog', { name: 'Changes not applied' });
    expect(router.configs.dhcp!.lan!.start).toBe('100');
    busy = false;
    fireEvent.click(within(blocked).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('dialog', { name: 'Done' });
    expect(router.configs.dhcp!.lan!.start).toBe('20');
  });
});

describe('VLAN networks', () => {
  beforeEach(() => {
    resetRouter({}, 'vlan');
  });

  const section = (pkg: string, f: (s: Record<string, unknown>) => boolean) => Object.values(router.configs[pkg]!).find(f);

  it('shows the VLAN of each network', async () => {
    renderApp('#/settings/networks');
    const row = (await screen.findByText('10.232.20.1')).closest('tr')!;
    expect(row.textContent).toContain('20');
    expect((await screen.findByText('10.232.1.1')).closest('tr')!.textContent).toContain('1');
  });

  it('creates an isolated network on a new VLAN tagged on every port', async () => {
    const deps = fastDeps();
    const sleep = vi.spyOn(deps, 'sleep');
    renderApp('#/settings/networks', deps);
    fireEvent.click(await screen.findByRole('button', { name: /Create New Network/ }));
    const drawer = await screen.findByRole('complementary');
    type(drawer, 'Name', 'guest');
    type(drawer, 'VLAN ID', '30');
    type(drawer, 'Router IP', '10.232.30.1');
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Isolated' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Create Network' }));

    await applyReviewed();
    expect(router.configs.network!.guest).toMatchObject({ device: 'br-lan.30', ipaddr: ['10.232.30.1/24'] });
    expect(section('network', (s) => s['.type'] === 'bridge-vlan' && s.vlan === '30')!.ports).toEqual([
      'eth0:t',
      'eth2:t',
      'eth3:t',
      'eth4:t',
    ]);
    expect(router.configs.dhcp!.guest).toMatchObject({ interface: 'guest', start: '100' });
    expect(section('firewall', (s) => s['.type'] === 'zone' && s.name === 'guest')).toMatchObject({ input: 'REJECT' });
    expect(sleep).toHaveBeenCalledWith(4_000);
  });

  it('will not create a network with a taken name or VLAN', async () => {
    renderApp('#/settings/networks');
    fireEvent.click(await screen.findByRole('button', { name: /Create New Network/ }));
    const drawer = await screen.findByRole('complementary');
    type(drawer, 'Name', 'iot');
    type(drawer, 'VLAN ID', '20');
    expect(within(drawer).getByText(/already used/)).toBeTruthy();
    expect(within(drawer).getByText(/VLAN 20 is already in use/)).toBeTruthy();
    expect((within(drawer).getByRole('button', { name: 'Create Network' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renumbers a VLAN, moving the interface and the port memberships', async () => {
    renderApp('#/settings/networks');
    fireEvent.click(await screen.findByText('10.232.20.1'));
    const drawer = await screen.findByRole('complementary');
    type(drawer, 'VLAN ID', '25');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.network!.iot!.device).toBe('br-lan.25');
    expect(router.configs.network!.cfg08a1b0).toMatchObject({ vlan: '25', ports: ['eth2:t', 'eth3', 'eth4'] });
  });

  it('deletes a network with its VLAN and pool', async () => {
    renderApp('#/settings/networks');
    fireEvent.click(await screen.findByText('10.232.20.1'));
    const drawer = await screen.findByRole('complementary');
    fireEvent.click(within(drawer).getByRole('button', { name: /Delete/ }));

    await applyReviewed();
    expect(router.configs.network!.iot).toBeUndefined();
    expect(router.configs.network!.cfg08a1b0).toBeUndefined();
    expect(router.configs.dhcp!.iot).toBeUndefined();
  });

  it('does not offer to delete the LAN', async () => {
    renderApp('#/settings/networks');
    fireEvent.click(await screen.findByText('10.232.1.1'));
    const drawer = await screen.findByRole('complementary');
    expect(within(drawer).queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});

describe('network DNS, IPv6 and multicast', () => {
  it('hands out two DNS servers and a domain, keeping other DHCP options', async () => {
    router.configs.dhcp!.lan!.dhcp_option = ['tag:kids,6,1.1.1.3', '42,10.231.1.2'];
    const drawer = await openLan();
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Manual' }));
    type(drawer, 'DNS server 1', '1.1.1.1');
    type(drawer, 'DNS server 2', '9.9.9.9');
    type(drawer, 'Domain name', 'home.arpa');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.dhcp!.lan!.dhcp_option).toEqual([
      'tag:kids,6,1.1.1.3',
      '42,10.231.1.2',
      '6,1.1.1.1,9.9.9.9',
      '15,home.arpa',
    ]);
  });

  it('will not apply a bad DNS server', async () => {
    const drawer = await openLan();
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Manual' }));
    type(drawer, 'DNS server 1', 'dns.google');
    expect((within(drawer).getByRole('button', { name: 'Apply Changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an option 6 it did not write as-is', async () => {
    router.configs.dhcp!.lan!.dhcp_option = ['option:dns-server,10.0.0.53'];
    const drawer = await openLan();
    expect(within(drawer).getByRole('tab', { name: 'Custom' }).getAttribute('aria-selected')).toBe('true');
    expect(drawer.textContent).toContain('option:dns-server,10.0.0.53');
  });

  it('turns IPv6 off and IGMP snooping on as a disruptive apply', async () => {
    const deps = fastDeps();
    const sleep = vi.spyOn(deps, 'sleep');
    const drawer = await openLan(deps);
    fireEvent.click(within(drawer).getByRole('tab', { name: 'None' }));
    fireEvent.click(within(drawer).getByRole('switch', { name: 'IGMP snooping' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply Changes' }));

    await applyReviewed();
    expect(router.configs.network!.lan).not.toHaveProperty('ip6assign');
    expect(router.configs.dhcp!.lan).not.toHaveProperty('ra');
    expect(router.configs.network!.cfg030f15!.igmp_snooping).toBe('1');
    expect(sleep).toHaveBeenCalledWith(4_000);
  });
});
