// Light, dark, or whatever the system uses. The choice is kept per browser
// (localStorage) and applied as data-theme on <html>; index.css switches the
// palette on it, and on the system setting when there is none.

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'netui.theme';
const EVENT = 'netui-theme';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme = getTheme()): void {
  const root = document.documentElement;
  if (t === 'system') {
    delete root.dataset.theme;
    root.style.colorScheme = '';
  } else {
    root.dataset.theme = t;
    // Native controls (selects, scrollbars) follow too.
    root.style.colorScheme = t;
  }
}

export function setTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Private mode: the choice lasts until the page reloads.
  }
  applyTheme(t);
  window.dispatchEvent(new Event(EVENT));
}

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export function isDark(t: Theme = getTheme()): boolean {
  return t === 'dark' || (t === 'system' && systemDark());
}

/** Calls `fn` when the effective theme may have changed (manual choice or system switch). */
export function onThemeChange(fn: () => void): () => void {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  window.addEventListener(EVENT, fn);
  mq?.addEventListener('change', fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    mq?.removeEventListener('change', fn);
  };
}
