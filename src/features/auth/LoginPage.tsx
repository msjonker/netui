import { useState } from 'preact/hooks';
import { LoginError, TransportError, login, type Session } from '../../api/ubus';
import { Logo } from '../../components/icons';
import { Banner, Button } from '../../components/ui';

export function LoginPage({ notice, onLogin }: { notice?: string | null; onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState('netui');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(username, password));
    } catch (err) {
      setError(
        err instanceof LoginError
          ? err.message
          : err instanceof TransportError
            ? 'Cannot reach the router.'
            : `Login failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setBusy(false);
    }
  };

  const insecure = location.protocol === 'http:' && location.hostname !== 'localhost';

  return (
    <div class="flex min-h-screen items-center justify-center p-4">
      <div class="w-full max-w-[360px]">
        <div class="mb-6 flex flex-col items-center gap-3">
          <Logo size={44} />
          <h1 class="text-xl font-semibold tracking-tight">Sign in to Network</h1>
        </div>
        <form onSubmit={submit} class="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-pop">
          {notice && !error && (
            <Banner tone="warn" role="status">
              {notice}
            </Banner>
          )}
          {error && (
            <Banner tone="bad" role="alert">
              {error}
            </Banner>
          )}
          <label class="block space-y-1.5">
            <span class="text-muted">Username</span>
            <input
              class="input h-10"
              name="username"
              autocomplete="username"
              required
              value={username}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
          </label>
          <label class="block space-y-1.5">
            <span class="text-muted">Password</span>
            <input
              class="input h-10"
              type="password"
              name="password"
              autocomplete="current-password"
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy} class="h-10 w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        {insecure && (
          <p class="mt-4 text-center text-xs text-muted">
            Not encrypted: the session token travels in the clear. Serve netui over HTTPS.
          </p>
        )}
      </div>
    </div>
  );
}
