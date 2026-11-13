import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { QrCode } from './QrCode';

describe('QrCode', () => {
  it('renders a labelled square SVG with modules drawn', () => {
    render(<QrCode value="WIFI:T:WPA;S:Home;P:hunter22;;" label="Join Home" />);
    const svg = screen.getByRole('img', { name: 'Join Home' });
    const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(25);
    expect(svg.querySelector('path')!.getAttribute('d')!.length).toBeGreaterThan(100);
  });
});
