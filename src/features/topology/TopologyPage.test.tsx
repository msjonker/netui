import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { resetRouter } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { wireless } from '../../../test/wireless';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

beforeEach(() => {
  localStorage.clear();
  // Dev container plus the synthetic two-radio wireless config.
  resetRouter({ wireless: wireless() });
});

async function openTopology() {
  renderApp('#/topology');
  await screen.findByRole('heading', { name: 'Topology' });
  return screen.getByRole('main');
}

describe('Topology', () => {
  it('draws internet, gateway, ports and both radios', async () => {
    const main = await openTopology();
    await within(main).findByText('Online');
    const ports = await within(main).findByLabelText('Ports');
    expect(within(ports).getAllByRole('link').length).toBeGreaterThan(0);
    await within(main).findByRole('link', { name: '2.4 GHz radio settings' });
    expect(within(main).getByRole('link', { name: '5 GHz radio settings' })).toBeTruthy();
    expect(within(main).getAllByText('Home').length).toBe(2);
    expect(within(main).getByText(/does not report which port/)).toBeTruthy();
  });

  it('links wired clients to their client page', async () => {
    const main = await openTopology();
    const lan = await within(main).findByRole('region', { name: 'LAN clients' });
    fireEvent.click(await within(lan).findByRole('link', { name: /laptop/ }));
    await waitFor(() => expect(location.hash).toBe('#/clients/02:4e:55:00:01:10'));
  });

  it('links ports to port settings and radios to WiFi settings', async () => {
    const main = await openTopology();
    const ports = await within(main).findByLabelText('Ports');
    fireEvent.click(within(ports).getAllByRole('link')[0]!);
    await waitFor(() => expect(location.hash).toBe('#/settings/ports'));

    location.hash = '#/topology';
    fireEvent.click(await screen.findByRole('link', { name: '5 GHz radio settings' }));
    await waitFor(() => expect(location.hash).toBe('#/settings/wifi'));
  });
});
