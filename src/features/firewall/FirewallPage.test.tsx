import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { pick, type } from '../../../test/dom';
import { applyReviewed } from '../../../test/applyFlow';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const redirects = () => Object.values(router.configs.firewall!).filter((s) => s['.type'] === 'redirect');
const ofType = (t: string) => Object.values(router.configs.firewall!).filter((s) => s['.type'] === t);

async function openTab(name: string) {
  renderApp('#/settings/security');
  fireEvent.click(await screen.findByRole('tab', { name }));
}

beforeEach(() => {
  resetRouter();
});

describe('Firewall & Security', () => {
  it('lists the recorded port forward with the device behind it', async () => {
    await openTab('Port Forwarding');
    const row = (await screen.findByText('Web server')).closest('tr')!;
    expect(row.textContent).toContain('8080');
    expect(row.textContent).toContain('10.231.1.128:80');
    expect(row.textContent).toContain('laptop');
  });

  it('creates a port forward into the LAN zone', async () => {
    await openTab('Port Forwarding');
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create Port Forward' });
    type(drawer, 'Name', 'Game');
    pick(drawer, 'Protocol', 'udp');
    type(drawer, 'External port', '27015');
    type(drawer, 'Device IP', '10.231.1.192');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));

    await applyReviewed();
    // dest_port is left out when it matches: fw4 defaults it to src_dport.
    expect(redirects()).toContainEqual(
      expect.objectContaining({
        name: 'Game',
        proto: 'udp',
        src: 'wan',
        src_dport: '27015',
        dest: 'lan',
        dest_ip: '10.231.1.192',
        target: 'DNAT',
      }),
    );
  });

  it('shows errors only after the first submit of a new rule', async () => {
    await openTab('Port Forwarding');
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create Port Forward' });
    expect(within(drawer).queryAllByRole('alert')).toHaveLength(0);

    type(drawer, 'Device IP', '10.231.1.2');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));

    expect(within(drawer).getAllByRole('alert').length).toBeGreaterThan(0);
    expect(router.writes()).toHaveLength(0);
  });

  it('removes a port forward after confirmation', async () => {
    await openTab('Port Forwarding');
    fireEvent.click(await screen.findByText('Web server'));
    const drawer = await screen.findByRole('complementary', { name: 'Web server' });
    fireEvent.click(within(drawer).getByRole('button', { name: /Remove/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Remove/ })).getByRole('button', { name: 'Remove' }));

    await applyReviewed();
    expect(redirects()).toHaveLength(0);
  });

  it('turns the DMZ on for a device, around the router\'s ports and the forwards, and off again', async () => {
    await openTab('Port Forwarding');
    const card = (await screen.findByRole('heading', { name: 'DMZ' })).closest('section')!;
    pick(card, 'Device', '10.231.1.128');
    fireEvent.click(within(card).getByRole('button', { name: 'Turn On' }));
    await applyReviewed();
    const dmz = () => redirects().filter((r) => r.name === 'netui: DMZ');
    expect(dmz().map((r) => [r.src_dport, r.dest_ip, r.dest])).toEqual([
      ['1-67', '10.231.1.128', 'lan'],
      ['69-8079', '10.231.1.128', 'lan'],
      ['8081-65535', '10.231.1.128', 'lan'],
    ]);
    // Still one port forward in the list: the DMZ is not one.
    expect(screen.getAllByRole('row')).toHaveLength(2);

    fireEvent.click(await within(card).findByRole('button', { name: 'Turn Off' }));
    await applyReviewed();
    expect(dmz()).toHaveLength(0);
  });

  it('blocks LAN from the internet from the zone matrix', async () => {
    renderApp('#/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'LAN to Internet: Allow' }));
    const dialog = await screen.findByRole('dialog', { name: 'LAN → Internet' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Block' }));
    expect(dialog.textContent).toContain('lose internet access');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));

    await applyReviewed();
    expect(ofType('forwarding')).toEqual([]);
    expect(await screen.findByRole('button', { name: 'LAN to Internet: Block' })).toBeTruthy();
  });

  it('keeps internet sources locked and asks before closing the router', async () => {
    renderApp('#/settings/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Internet to LAN: Custom' }));
    const locked = await screen.findByRole('dialog', { name: 'Internet → LAN' });
    expect(locked.textContent).toContain('Port Forwarding');
    expect(within(locked).queryByRole('tab', { name: 'Allow' })).toBeNull();
    fireEvent.click(within(locked).getByRole('button', { name: 'Done' }));

    fireEvent.click(await screen.findByRole('button', { name: 'LAN to Router: Allow' }));
    const dialog = await screen.findByRole('dialog', { name: 'LAN → Router' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Block' }));
    // jsdom's hostname is no router address: netui cannot tell where the browser is.
    const go = within(dialog).getByRole('button', { name: 'Block' });
    expect(go.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand/ }));
    fireEvent.click(go);

    await applyReviewed();
    const lan = ofType('zone').find((z) => z.name === 'lan')!;
    expect(lan.input).toBe('REJECT');
    expect(ofType('rule').map((r) => r.name)).toEqual(expect.arrayContaining(['Allow-lan-DHCP', 'Allow-lan-DNS']));
  });

  it('turns off ping from the internet', async () => {
    renderApp('#/settings/security');
    fireEvent.click(await screen.findByRole('switch', { name: 'Respond to ping from the internet' }));
    await applyReviewed();
    expect(ofType('rule').find((r) => r.name === 'Allow-Ping')!.enabled).toBe('0');
  });

  it('creates a scheduled block rule for a client', async () => {
    await openTab('Traffic Rules');
    fireEvent.click(await screen.findByRole('button', { name: /Create New/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create Traffic Rule' });
    type(drawer, 'Name', 'Laptop bedtime');
    pick(drawer, 'Source', 'devices');
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /laptop/ }));
    pick(drawer, 'Schedule', 'custom');
    for (const d of ['Mon', 'Tue', 'Wed']) fireEvent.click(within(drawer).getByRole('button', { name: d }));
    type(drawer, 'From', '21:00');
    type(drawer, 'Until', '07:00');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));

    await applyReviewed();
    expect(ofType('rule')).toContainEqual(
      expect.objectContaining({
        name: 'netui: rule Laptop bedtime',
        src: '*',
        src_mac: ['02:4E:55:00:01:10'],
        dest: 'wan',
        proto: 'all',
        target: 'REJECT',
        weekdays: 'Mon Tue Wed',
        start_time: '21:00',
        stop_time: '07:00',
      }),
    );
    const row = (await screen.findByText('Laptop bedtime')).closest('tr')!;
    expect(row.textContent).toContain('laptop');
    expect(row.textContent).toContain('Mon-Wed 21:00-07:00');
  });

  it('lists rules made elsewhere read-only', async () => {
    await openTab('Traffic Rules');
    const row = (await screen.findByText('Allow-ISAKMP')).closest('tr')!;
    expect(row.hasAttribute('data-clickable')).toBe(false);
    expect(within(row).getByRole('link')).toBeTruthy();
  });

  it('enables family filtering on a network', async () => {
    await openTab('Ad Blocking & Filtering');
    pick(document.body, 'Content filter for LAN', 'family');

    await applyReviewed();
    expect(router.configs.dhcp!.lan!.dhcp_option).toEqual(['6,1.1.1.3,1.0.0.3']);
    expect(router.configs.dhcp!.lan!.dns).toEqual(['2606:4700:4700::1113', '2606:4700:4700::1003']);
    expect(ofType('rule')).toContainEqual(
      expect.objectContaining({ name: 'netui: filter lan', src: 'lan', dest: 'wan', dest_port: ['53', '853'], target: 'REJECT' }),
    );
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Content filter for LAN' })).toHaveProperty('value', 'family'));
  });
});
