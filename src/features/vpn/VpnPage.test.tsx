import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { TransportError } from '../../api/ubus';
import { resetRouter, router, stageOn } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { type } from '../../../test/dom';
import { applyReviewed, review } from '../../../test/applyFlow';
import { fakeKey } from '../../../test/fakeReads/vpn';
import { createServerOps, fwSection } from '../../model/vpn';
import tsRec from '../../../test/fixtures/ubus/dl-wrx36/plain/tailscale.status.json';
import tunnelRec from '../../../test/fixtures/ubus/dl-wrx36/plain/netui.services.tunnel.json';
import cloudflaredRec from '../../../test/fixtures/ubus/dl-wrx36/plain/uci.get.cloudflared.json';
import type { UciConfig } from '../../api/types';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

/** A router that already runs wg0 (internet-only access off: full). */
function withServer() {
  const r = resetRouter();
  const ops = createServerOps(
    { name: 'wg0', port: '51820', cidr: '10.6.0.1/24', dns: '', access: 'full', endpoint: 'vpn.example.net' },
    fakeKey('SERVER-PRIVATE'),
    { network: r.configs.network!, firewall: r.configs.firewall! },
  );
  stageOn(r, ops);
  r.handle('uci', 'apply', {});
  r.calls = [];
  return r;
}

const peers = () => Object.values(router.configs.network!).filter((s) => s['.type'] === 'wireguard_wg0');

describe('VPN', () => {
  beforeEach(() => {
    resetRouter();
  });

  it('shows the empty state without an error when rpcd returns no data for zero instances', async () => {
    renderApp('#/settings/vpn');
    await screen.findByRole('button', { name: /Create VPN Server/ });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Live status unavailable/)).toBeNull();
  });

  it('creates a server: interface, zone, forwardings and wan rule in one review', async () => {
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: /Create VPN Server/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Create VPN Server' });
    expect((within(drawer).getByLabelText('Name') as HTMLInputElement).value).toBe('wg0');
    type(drawer, 'Endpoint', 'vpn.example.net');
    fireEvent.click(within(drawer).getByLabelText(/Internet only/));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Create' }));

    const dialog = await review();
    expect(dialog.textContent).toMatch(/network/i);
    expect(dialog.textContent).toMatch(/firewall/i);
    expect(dialog.textContent).toContain('wireguard');
    await applyReviewed();

    const wg0 = router.configs.network!.wg0!;
    expect(wg0).toMatchObject({ proto: 'wireguard', listen_port: '51820', netui_endpoint: 'vpn.example.net' });
    // The private key is the one the router generated.
    const gen = router.calls.find((c) => c.object === 'luci.wireguard' && c.method === 'generateKeyPair');
    expect(gen).toBeDefined();
    expect(String(wg0.private_key)).toHaveLength(44);
    const fw = router.configs.firewall!;
    expect(fw[fwSection.zone('wg0')]).toMatchObject({ name: 'vpn', network: ['wg0'], input: 'REJECT' });
    expect(fw[fwSection.wan('wg0')]).toMatchObject({ src: 'vpn', dest: 'wan' });
    expect(fw[fwSection.dns('wg0')]).toMatchObject({ dest_port: '53' });
    expect(fw[fwSection.port('wg0')]).toMatchObject({ src: 'wan', proto: 'udp', dest_port: '51820', target: 'ACCEPT' });

    // The page now shows the running server.
    expect(await screen.findByText(/WireGuard VPN Server/)).toBeDefined();
    expect(await screen.findByText('Internet only')).toBeDefined();
  });

  it('adds a client and shows its configuration once, without sending the private key to the router', async () => {
    withServer();
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: /Add Client/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Add Client' });
    expect((within(drawer).getByLabelText('IP address') as HTMLInputElement).value).toBe('10.6.0.2');
    type(drawer, 'Name', 'Phone');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    await applyReviewed();

    const modal = await screen.findByRole('dialog', { name: 'Client configuration: Phone' }, { timeout: 4000 });
    const text = within(modal).getByLabelText('Configuration file').textContent ?? '';
    const priv = /PrivateKey = (\S+)/.exec(text)?.[1];
    expect(priv).toHaveLength(44);
    expect(text).toContain('Address = 10.6.0.2/32');
    expect(text).toContain('DNS = 10.6.0.1');
    expect(text).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(text).toContain('Endpoint = vpn.example.net:51820');
    expect(within(modal).getByRole('img', { name: /WireGuard QR code for Phone/ })).toBeDefined();
    expect(within(modal).getByRole('button', { name: /Download .conf/ })).toBeDefined();

    // The router has the public half only.
    const [peer] = peers();
    expect(peer).toMatchObject({ description: 'Phone', allowed_ips: ['10.6.0.2/32'], route_allowed_ips: '1' });
    expect(peer!.private_key).toBeUndefined();
    expect(text).toContain(`PresharedKey = ${String(peer!.preshared_key)}`);
    for (const c of router.calls.filter((c) => c.object === 'uci')) {
      expect(JSON.stringify(c.args)).not.toContain(priv!);
    }
    // The interface is nudged so netifd loads the new peer.
    expect(router.configs.network!.wg0!.mtu).toBe('1420');

    // Split tunnel limits AllowedIPs to the VPN and home subnets.
    fireEvent.click(within(modal).getByRole('tab', { name: 'Home networks only' }));
    expect(within(modal).getByLabelText('Configuration file').textContent).toMatch(/AllowedIPs = 10\.6\.0\.0\/24, /);

    fireEvent.click(within(modal).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: /Client configuration/ })).toBeNull();
    expect(await screen.findByText('Phone')).toBeDefined();
  });

  it('drops the keys when the change is discarded', async () => {
    withServer();
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: /Add Client/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Add Client' });
    type(drawer, 'Name', 'Laptop');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(await review()).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByText(/keys were discarded/)).toBeDefined();
    expect(screen.queryByRole('dialog', { name: /Client configuration/ })).toBeNull();
    expect(peers()).toHaveLength(0);
  });

  it('drops the keys when the router rolls back', async () => {
    withServer();
    router.overrides.push((c) => {
      if (c.object !== 'uci' || c.method !== 'confirm') return undefined;
      router.rollBack();
      return new TransportError('Router unreachable');
    });
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: /Add Client/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Add Client' });
    type(drawer, 'Name', 'Laptop');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(await review()).getByRole('button', { name: 'Apply Changes' }));
    const done = await screen.findByRole('dialog', { name: 'Changes not applied' });
    fireEvent.click(within(done).getByRole('button', { name: 'OK' }));

    expect(await screen.findByText(/keys were discarded/)).toBeDefined();
    expect(screen.queryByRole('dialog', { name: /Client configuration/ })).toBeNull();
    expect(peers()).toHaveLength(0);
  });

  it('removes a client after confirmation', async () => {
    const r = withServer();
    stageOn(r, [
      {
        op: 'add',
        config: 'network',
        type: 'wireguard_wg0',
        values: { description: 'Tablet', public_key: fakeKey('TABLET'), allowed_ips: ['10.6.0.2/32'] },
      },
    ]);
    r.handle('uci', 'apply', {});
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Tablet' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Remove "Tablet"/ })).getByRole('button', { name: 'Remove' }));
    await applyReviewed();
    expect(peers()).toHaveLength(0);
  });

  it('deletes the server with everything netui created for it', async () => {
    withServer();
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('complementary', { name: 'WireGuard Server wg0' });
    fireEvent.click(within(drawer).getByRole('button', { name: /Delete/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Delete VPN server/ })).getByRole('button', { name: 'Delete' }));
    await applyReviewed();
    expect(router.configs.network!.wg0).toBeUndefined();
    expect(Object.keys(router.configs.firewall!).filter((k) => k.startsWith('netui_wg0'))).toEqual([]);
    expect(await screen.findByRole('button', { name: /Create VPN Server/ })).toBeDefined();
  });
});

describe('VPN service (the router as a client)', () => {
  beforeEach(() => {
    resetRouter();
  });

  const CONF = `[Interface]\nPrivateKey = ${fakeKey('CLIENT')}\nAddress = 10.66.0.2/32\nDNS = 10.66.0.1\n\n[Peer]\nPublicKey = ${fakeKey('PROVIDER')}\nAllowedIPs = 0.0.0.0/0\nEndpoint = vpn.example.net:51820\n`;

  it('sets up from a pasted provider file and shows it', async () => {
    renderApp('#/settings/vpn');
    fireEvent.click(await screen.findByRole('button', { name: 'Set Up' }));
    const drawer = await screen.findByRole('complementary');
    fireEvent.input(within(drawer).getByLabelText('Configuration'), { target: { value: 'nonsense' } });
    expect((await within(drawer).findByRole('alert')).textContent).toMatch(/Not a WireGuard/);
    fireEvent.input(within(drawer).getByLabelText('Configuration'), { target: { value: CONF } });
    await within(drawer).findByText('vpn.example.net:51820');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set Up' }));
    await applyReviewed();
    expect(router.configs.network!.vpnclient).toMatchObject({ proto: 'wireguard', addresses: ['10.66.0.2/32'], dns: ['10.66.0.1'] });
    expect(router.configs.firewall!.netui_vpnclient_lan).toMatchObject({ src: 'lan', dest: 'vpnclient' });
    expect(await screen.findByText('All devices')).toBeTruthy();
    // The private key only went to the router: never into the page after setup.
    expect(document.body.textContent).not.toContain(fakeKey('CLIENT'));
  });
});

describe('Tailscale', () => {
  beforeEach(() => {
    resetRouter();
  });

  it('connects: sets up the zone through an apply, signs in, then links to the sign-in page', async () => {
    let signingIn = false;
    router.overrides.push((c) => {
      if (c.object !== 'netui.tailscale') return undefined;
      if (c.method === 'login') return (signingIn = true), { result: true };
      return { installed: true, status: signingIn ? tsRec.authUrl : tsRec.needsLogin, prefs: tsRec.prefs, loggingIn: signingIn };
    });
    renderApp('#/settings/vpn');
    const card = (await screen.findByRole('heading', { name: /^Tailscale/ })).closest('section')!;
    fireEvent.click(await within(card).findByRole('button', { name: 'Connect' }));
    await applyReviewed();
    expect(router.configs.network!.tailscale).toMatchObject({ proto: 'none', device: 'tailscale0' });
    expect(router.configs.firewall!.netui_tailscale_zone).toMatchObject({ name: 'tailscale' });
    const link = await within(card).findByRole('link', { name: 'Sign in to Tailscale' }, { timeout: 8000 });
    expect(link.getAttribute('href')).toBe(tsRec.authUrl.AuthURL);
    expect(router.calls.filter((c) => c.object === 'netui.tailscale' && c.method === 'login')).toHaveLength(1);
  });

  it('offers the add-on when it is not installed', async () => {
    router.overrides.push((c) => (c.object === 'netui.tailscale' ? { installed: false } : undefined));
    renderApp('#/settings/vpn');
    const card = (await screen.findByRole('heading', { name: /^Tailscale/ })).closest('section')!;
    expect(await within(card).findByText(/Needs about 26 MB of storage/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Install' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Connect' })).toBeNull();
  });
});

describe('Cloudflare Tunnel', () => {
  const TOKEN = btoa(JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: tunnelRec.connected.tunnel, s: 'c2VjcmV0LXNlY3JldA==' }));

  /** Live state follows the committed UCI, as the package's reload trigger makes it. */
  function withCloudflared() {
    const r = resetRouter();
    r.configs.cloudflared = structuredClone(cloudflaredRec.values) as unknown as UciConfig;
    r.overrides.push((c) => {
      if (c.object !== 'netui.services' || c.method !== 'tunnel') return undefined;
      const s = r.configs.cloudflared?.config;
      if (!s?.token) return tunnelRec.notSetUp;
      return s.enabled === '1' ? tunnelRec.connected : tunnelRec.off;
    });
    return r;
  }
  const card = async () => (await screen.findByRole('heading', { name: /^Cloudflare Tunnel/ })).closest('section')!;

  it('sets up from a pasted install command, with the token hidden in the review', async () => {
    withCloudflared();
    renderApp('#/settings/vpn');
    const c = await card();
    await within(c).findByLabelText('Tunnel token');
    type(c, 'Tunnel token', `sudo cloudflared service install ${TOKEN}`);
    expect(await within(c).findByText(tunnelRec.connected.tunnel)).toBeTruthy();
    fireEvent.click(within(c).getByRole('button', { name: 'Connect' }));
    const dialog = await review();
    expect(dialog.textContent).not.toContain(TOKEN);
    expect(dialog.textContent).toContain('••••••••');
    await applyReviewed();
    expect(router.configs.cloudflared!.config).toMatchObject({ enabled: '1', token: TOKEN });
    expect(await within(c).findByText('Connected', {}, { timeout: 4000 })).toBeTruthy();
    expect(within(c).getByText('ord02, ord06, ord08, ord11')).toBeTruthy();
  });

  it('does not stage something that is not a token', async () => {
    withCloudflared();
    renderApp('#/settings/vpn');
    const c = await card();
    await within(c).findByLabelText('Tunnel token');
    type(c, 'Tunnel token', 'hello there');
    fireEvent.click(within(c).getByRole('button', { name: 'Connect' }));
    expect(await within(c).findByText(/This is not a tunnel token/)).toBeTruthy();
    expect(router.writes()).toHaveLength(0);
  });

  it('turns off and removes through applies', async () => {
    const r = withCloudflared();
    stageOn(r, [{ op: 'set', config: 'cloudflared', section: 'config', values: { enabled: '1', token: TOKEN } }]);
    r.handle('uci', 'apply', {});
    renderApp('#/settings/vpn');
    const c = await card();
    fireEvent.click(await within(c).findByRole('button', { name: 'Turn Off' }));
    await applyReviewed();
    expect(router.configs.cloudflared!.config!.enabled).toBe('0');
    fireEvent.click(await within(c).findByRole('button', { name: 'Turn On' }));
    await applyReviewed();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(await within(c).findByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Remove the tunnel/ })).getByRole('button', { name: 'Remove' }));
    await applyReviewed();
    expect(router.configs.cloudflared!.config).toMatchObject({ enabled: '0' });
    expect(router.configs.cloudflared!.config!.token).toBeUndefined();
  });

  it('explains a rejected token', async () => {
    resetRouter();
    router.overrides.push((c) => (c.object === 'netui.services' && c.method === 'tunnel' ? tunnelRec.rejected : undefined));
    renderApp('#/settings/vpn');
    const c = await card();
    expect(await within(c).findByText(/did not accept the token/)).toBeTruthy();
    expect(within(c).getByText('Not working')).toBeTruthy();
  });

  it('shows read-only users the state without actions', async () => {
    resetRouter();
    router.overrides.push((c) => (c.object === 'netui.services' && c.method === 'tunnel' ? tunnelRec.connected : undefined));
    renderApp('#/settings/vpn', undefined, { readOnly: true });
    const c = await card();
    expect(await within(c).findByText('Connected')).toBeTruthy();
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('offers the add-on when it is not installed', async () => {
    resetRouter();
    router.overrides.push((c) => (c.object === 'netui.services' && c.method === 'tunnel' ? { installed: false } : undefined));
    renderApp('#/settings/vpn');
    const c = await card();
    expect(await within(c).findByText(/Needs about 25 MB of storage/)).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Install' })).toBeTruthy();
  });
});
