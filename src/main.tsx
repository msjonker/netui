import { render } from 'preact';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './api/queries';
import { takeHandoff } from './api/apply';
import { saveSession } from './api/ubus';
import { App } from './app/App';
import { applyTheme } from './lib/theme';
import './index.css';

// The saved light/dark choice, before the first render.
applyTheme();

// Arriving at a new router address mid-apply: adopt the session handed over
// in the URL fragment (stripped from the address bar by takeHandoff) so this
// origin can confirm the change.
const handoff = takeHandoff() ?? undefined;
if (handoff) saveSession({ ...handoff.session, expiresAt: Date.now() + handoff.session.timeoutMs });

const queryClient = createQueryClient();

const start = () =>
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
if (import.meta.env.MODE === 'demo') void import('./demo').then((m) => (m.installDemo(), start()));
else start();
