import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/preact';
import { resetRouter, router } from '../../../test/fakeRouter';
import { renderApp } from '../../../test/renderApp';
import { applyReviewed, review } from '../../../test/applyFlow';
import { sectionsOfType } from '../../api/uci';

vi.mock('../../api/ubus', async (orig) => (await import('../../../test/fakeRouter')).fakeUbusModule(await orig()));

const people = () => sectionsOfType(router.configs.firewall!, 'netui_person');
// Wednesday 2026-11-18 at noon.
const NOW = new Date('2026-11-18T12:00:00');

beforeEach(() => {
  resetRouter();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('People', () => {
  it('adds a person with devices and a bedtime', async () => {
    renderApp('#/people');
    await screen.findByText('No one here yet.');
    fireEvent.click(screen.getByRole('button', { name: /Add Person/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Add Person' });
    fireEvent.input(within(drawer).getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.click(within(drawer).getByText('laptop').closest('label')!.querySelector('input')!);
    fireEvent.click(within(drawer).getByRole('switch', { name: /Internet off at night/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add Person' }));
    const dialog = await review();
    expect(dialog.textContent).toContain('limits.sh');
    await applyReviewed();
    const [sam] = people();
    expect(sam).toMatchObject({ name: 'Sam', bedtime: '1', bed_start: '21:00', bed_stop: '07:00', bed_day: ['Mon', 'Tue', 'Wed', 'Thu', 'Sun'] });
    expect(sam!.mac).toHaveLength(1);
    expect(router.configs.firewall!.netui_limits).toMatchObject({ '.type': 'include', path: '/usr/share/netui/limits.sh' });
    await screen.findByText('Bedtime: Sun–Thu, 21:00 to 07:00.');
  });

  it('pauses for an hour and resumes', async () => {
    router.configs.firewall!.sam = {
      '.anonymous': true,
      '.index': 50,
      '.name': 'sam',
      '.type': 'netui_person',
      name: 'Sam',
      mac: ['DA:A1:19:00:01:11'],
    };
    renderApp('#/people');
    const card = (await screen.findByText('Sam')).closest('section')!;
    await within(card).findByText('Internet on');
    fireEvent.click(within(card).getByText('Pause Internet'));
    fireEvent.click(within(card).getByRole('menuitem', { name: '1 hour' }));
    await applyReviewed();
    expect(people()[0]).toMatchObject({ paused: '1', paused_until: String(NOW.getTime() / 1000 + 3600) });
    await within(card).findByText(/^Paused until/);
    fireEvent.click(within(card).getByRole('button', { name: 'Resume Internet' }));
    await applyReviewed();
    expect(people()[0]!.paused).toBeUndefined();
    expect(people()[0]!.paused_until).toBeUndefined();
  });

  it('shows a pause that ran out as over, and bedtime when it is on', async () => {
    router.configs.firewall!.sam = {
      '.anonymous': true,
      '.index': 50,
      '.name': 'sam',
      '.type': 'netui_person',
      name: 'Sam',
      mac: ['DA:A1:19:00:01:11'],
      paused: '1',
      paused_until: String(NOW.getTime() / 1000 - 60),
      bedtime: '1',
      bed_day: ['Wed'],
      bed_start: '11:00',
      bed_stop: '13:00',
    };
    renderApp('#/people');
    const card = (await screen.findByText('Sam')).closest('section')!;
    await within(card).findByText('Bedtime until 13:00');
    expect(within(card).getByText('Pause Internet')).toBeTruthy();
  });
});
