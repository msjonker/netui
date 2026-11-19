import { render } from 'preact';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './api/queries';
import { acceptHandoff, takeHandoff, type Handoff } from './api/apply';
import { App } from './app/App';
import { applyTheme } from './lib/theme';
import './index.css';

// The saved light/dark choice, before the first render.
applyTheme();

// Nothing renders inside another site's frame (a page could otherwise trick
// a click on Apply).
const framed = window.top !== window.self;

// Arriving at a new router address mid-apply: adopt the session handed over
// in the URL fragment (stripped from the address bar by takeHandoff) so this
// origin can confirm the change, once the router vouches for it.
const pending = framed ? null : takeHandoff();

const queryClient = createQueryClient();

const render_ = (handoff: Handoff | undefined) =>
  render(
    <QueryClientProvider client={queryClient}>
      <App handoff={handoff} />
    </QueryClientProvider>,
    document.getElementById('app')!,
  );

// The demo build (`npm run build:demo`) answers /ubus from a simulated router
// in the page. The condition is a build-time constant: production drops it.
// Not a top-level await: the demo chunk imports this one, which would wait
// on itself.
const start = () => {
  if (framed) {
    document.getElementById('app')!.textContent = 'netui cannot be shown inside another page. Open it directly.';
    return;
  }
  if (!pending) return render_(undefined);
  void acceptHandoff(pending).then((ok) => render_(ok ? pending : undefined));
};

if (import.meta.env.MODE === 'demo') void import('./demo').then((m) => (m.installDemo(), start()));
else start();
