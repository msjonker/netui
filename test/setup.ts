import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/preact';

// findBy*/waitFor default to 1 s. Pages that wait on several fake queries can
// take longer than that on a busy machine (or a CI runner): allow 5 s.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

// jsdom lacks the layout and canvas APIs uPlot touches at import and render.
// These stubs let charts mount without drawing anything.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const noop = () => {};
const ctx2d = new Proxy(
  { measureText: () => ({ width: 0 }), getLineDash: () => [], createLinearGradient: () => ({ addColorStop: noop }) },
  { get: (target, key) => (key in target ? target[key as keyof typeof target] : noop), set: () => true },
);
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
