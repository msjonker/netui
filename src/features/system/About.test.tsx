import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { AboutCard } from './About';

describe('AboutCard', () => {
  it('shows the build version and links to the project', () => {
    render(<AboutCard />);
    expect(screen.getByText(__NETUI_VERSION__)).toBeTruthy();
    expect(__NETUI_VERSION__).toMatch(/^\d+(\.\d+)*$/);
    expect(screen.getByText('Matt Jonker')).toBeTruthy();
    const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href('MIT License')).toBe('https://github.com/msjonker/netui/blob/main/LICENSE');
    expect(href('github.com/msjonker/netui')).toBe('https://github.com/msjonker/netui');
    expect(href('Report a problem')).toBe('https://github.com/msjonker/netui/issues');
    expect(href('Third-party licenses')).toBe('licenses.txt');
  });
});
