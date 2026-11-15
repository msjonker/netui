import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, getTheme, isDark, onThemeChange, setTheme } from './theme';

afterEach(() => {
  setTheme('system');
  localStorage.clear();
});

describe('theme', () => {
  it('follows the system until a choice is made', () => {
    expect(getTheme()).toBe('system');
    applyTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('keeps a manual choice, marks <html> and tells listeners', () => {
    const fn = vi.fn();
    const off = onThemeChange(fn);
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(getTheme()).toBe('dark');
    expect(isDark()).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    off();
    setTheme('light');
    expect(isDark()).toBe(false);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('forgets the choice when set back to system', () => {
    setTheme('light');
    setTheme('system');
    expect(localStorage.getItem('netui.theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
