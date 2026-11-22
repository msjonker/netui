import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryScript, newBuildServed, reloadForUpdate, takeUpdateNotice } from './build';

const page = (hash: string) =>
  `<!doctype html><html><head><link rel="modulepreload" crossorigin href="./assets/vendor-AAAA.js"><script type="module" crossorigin src="./assets/index-${hash}.js"></script></head><body></body></html>`;

const docWith = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const URL_ = 'http://192.168.1.1/netui/#/devices';

describe('entryScript', () => {
  it("finds a built page's entry script, not a preload, and nothing on the dev server's page", () => {
    expect(entryScript(page('DCJYN8RV'))).toBe('./assets/index-DCJYN8RV.js');
    expect(entryScript('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });
});

describe('newBuildServed', () => {
  it('compares the open page with the one the router serves now', async () => {
    const fetchFn = vi.fn(async () => new Response(page('NEW00000')));
    expect(await newBuildServed(docWith(page('OLD00000')), fetchFn as unknown as typeof fetch, URL_)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('http://192.168.1.1/netui/', { cache: 'no-store' });
    expect(await newBuildServed(docWith(page('NEW00000')), fetchFn as unknown as typeof fetch, URL_)).toBe(false);
  });

  it('says no when it cannot tell', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await newBuildServed(docWith(page('OLD00000')), down as unknown as typeof fetch, URL_)).toBe(false);
    const missing = vi.fn(async () => new Response('', { status: 404 }));
    expect(await newBuildServed(docWith(page('OLD00000')), missing as unknown as typeof fetch, URL_)).toBe(false);
    expect(await newBuildServed(docWith('<script type="module" src="/src/main.tsx"></script>'), missing as unknown as typeof fetch, URL_)).toBe(false);
  });
});

describe('reloadForUpdate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves a notice for the sign-in page, shown once', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    reloadForUpdate();
    expect(reload).toHaveBeenCalledOnce();
    expect(takeUpdateNotice()).toMatch(/updated/);
    expect(takeUpdateNotice()).toBeNull();
  });
});
