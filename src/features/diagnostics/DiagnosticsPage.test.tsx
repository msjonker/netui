import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import rec from '../../../test/fixtures/ubus/dl-wrx36/plain/file.exec.diagnostics.json';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const execs = () =>
  router.calls
    .filter((c) => c.object === 'file')
    .map((c) => [c.args.command, ...(c.args.params as string[])].join(' '));

async function runCheck(card: HTMLElement) {
  const run = await within(card).findByRole('button', { name: 'Run Check' });
  await vi.waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(run);
}

beforeEach(() => {
  resetRouter();
});

describe('Diagnostics', () => {
  it('runs the connection check from the gateway to name lookup', async () => {
    router.overrides.push((c) =>
      c.object !== 'file' ? undefined : c.args.command === '/usr/bin/nslookup' ? rec.nslookupOk : rec.pingOk,
    );
    renderApp('#/settings/diagnostics');
    const card = (await screen.findByRole('heading', { name: 'Connection check' })).closest('section')!;
    await runCheck(card);
    await within(card).findByText(/internet connection works/);
    expect(within(card).getByText('Names resolve (DNS)')).toBeTruthy();
    // The dev router's WAN gateway, then the internet, then a name.
    expect(execs()).toEqual([
      '/bin/ping -c 3 -W 2 10.231.0.1',
      '/bin/ping -c 3 -W 2 1.1.1.1',
      '/usr/bin/nslookup openwrt.org',
    ]);
    expect(router.writes()).toHaveLength(0);
  });

  it('tries a second address and gives advice when the internet does not answer', async () => {
    router.overrides.push((c) =>
      c.object !== 'file' ? undefined : c.args.command === '/usr/bin/nslookup' ? rec.nslookupNxdomain : rec.pingLost,
    );
    renderApp('#/settings/diagnostics');
    const card = (await screen.findByRole('heading', { name: 'Connection check' })).closest('section')!;
    await runCheck(card);
    await within(card).findByText(/problem is probably on your provider/);
    expect(execs()).toContain('/bin/ping -c 3 -W 2 9.9.9.9');
  });

  it('pings a host and summarises the answers; refuses option-like targets', async () => {
    router.overrides.push((c) => (c.object === 'file' ? rec.pingOk : undefined));
    renderApp('#/settings/diagnostics');
    const card = (await screen.findByRole('heading', { name: 'Tools' })).closest('section')!;
    const host = within(card).getByLabelText('Host name or IP address');
    fireEvent.input(host, { target: { value: '-f' } });
    expect((within(card).getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(host, { target: { value: '192.168.0.1' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Run' }));
    await within(card).findByText(/3 of 3 answered/);
    expect(execs()).toEqual(['/bin/ping -c 4 -W 2 192.168.0.1']);
  });
});
