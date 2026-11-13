// Drive the apply dialog from a component test: review the staged changes,
// apply, and wait for the result.

import { fireEvent, screen, within } from '@testing-library/preact';
import { router } from './fakeRouter';

/** Waits for the review dialog and returns its text. */
export async function review(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Review changes' });
}

/** Applies from the review dialog and waits for the confirmed result. */
export async function applyReviewed(): Promise<void> {
  const dialog = await review();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Changes' }));
  await screen.findByRole('dialog', { name: 'Done' });
  const confirmed = router.calls.some((c) => c.object === 'uci' && c.method === 'confirm');
  if (!confirmed) throw new Error('apply finished without uci confirm');
}
