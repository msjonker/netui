// DOM helpers for component tests.

import { fireEvent, within } from '@testing-library/preact';
import { fireEvent as dispatch } from '@testing-library/dom';
import { act } from 'preact/test-utils';

/** Types into the field labelled `label` inside `el`. */
export function type(el: HTMLElement, label: string, value: string): void {
  fireEvent.input(within(el).getByLabelText(label), { target: { value } });
}

/**
 * Chooses an option in the select labelled `label`. @testing-library/preact
 * turns fireEvent.change into an `input` event, which a select's onChange
 * never sees, so dispatch a real `change` the way a browser does.
 */
export function pick(el: HTMLElement, label: string, value: string): void {
  const select = within(el).getByLabelText(label);
  act(() => {
    dispatch.change(select, { target: { value } });
  });
}
