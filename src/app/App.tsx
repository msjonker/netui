import { useCallback, useEffect, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { useQueryClient } from '@tanstack/react-query';
import { Redirect, Route, Router, Switch } from 'wouter-preact';
import { useHashLocation } from 'wouter-preact/use-hash-location';
import { clearSession, getSession, onSessionExpired, type Session } from '../api/ubus';
import { browserDeps, completeHandoff, takeRollbackNotice, type ApplyDeps, type ApplyResult, type Handoff } from '../api/apply';
import { confirm } from '../api/uci';
import { keys, useStagedChanges } from '../api/queries';
import { ApplyContext, useApply, useApplyController } from '../api/useApply';
import type { UciConfig } from '../api/types';
import { ApplyDialog, sectionLabelFor } from '../components/ApplyDialog';
import { Banner, Button, Spinner } from '../components/ui';
import { LoginPage } from '../features/auth/LoginPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { ClientsPage } from '../features/clients/ClientsPage';
import { NetworksPage } from '../features/networks/NetworksPage';
import { PortsPage } from '../features/networks/PortsPage';
import { WifiPage } from '../features/wifi/WifiPage';
import { InternetPage } from '../features/networks/InternetPage';
import { FirewallPage } from '../features/firewall/FirewallPage';
import { TopologyPage } from '../features/topology/TopologyPage';
import { InsightsPage } from '../features/insights/InsightsPage';
import { LogsPage } from '../features/logs/LogsPage';
import { DevicesPage } from '../features/devices/DevicesPage';
import { SettingsLayout } from './SettingsLayout';

// Rarely opened screens load on demand (not counted in the initial bundle budget).
const DiagnosticsPage = lazy(() => import('../features/diagnostics/DiagnosticsPage').then((m) => ({ default: m.DiagnosticsPage })));
const SetupPage = lazy(() => import('../features/setup/SetupPage').then((m) => ({ default: m.SetupPage })));
const VpnPage = lazy(() => import('../features/vpn/VpnPage').then((m) => ({ default: m.VpnPage })));
const RoutingPage = lazy(() => import('../features/routing/RoutingPage').then((m) => ({ default: m.RoutingPage })));
const HealthPage = lazy(() => import('../features/health/HealthPage').then((m) => ({ default: m.HealthPage })));
const SystemPage = lazy(() => import('../features/system/SystemPage').then((m) => ({ default: m.SystemPage })));
import { Shell } from './Shell';

const SESSION_EXPIRED = 'Your session expired. Sign in again.';

/** Readable label for a UCI section in the review dialog. */
function useSectionLabel() {
  const qc = useQueryClient();
  return useCallback(
    (pkg: string, section: string) => {
      return sectionLabelFor(qc.getQueryData<UciConfig>(keys.uci(pkg))?.[section], section, pkg);
    },
    [qc],
  );
}

function StagedChangesBanner() {
  const staged = useStagedChanges();
  const apply = useApply();
  const pending = Object.entries(staged.data ?? {}).filter(([, c]) => c.length > 0);
  if (pending.length === 0 || apply.busy) return null;
  return (
    <div class="border-b border-line bg-surface px-5 py-2">
      <Banner
        tone="warn"
        role="status"
        actions={
          <Button variant="primary" onClick={() => apply.review(pending.map(([p]) => p))}>
            Review
          </Button>
        }
      >
        There are changes staged on the router that were never applied ({pending.map(([p]) => p).join(', ')}).
      </Banner>
    </div>
  );
}

function HandoffBanner({ handoff }: { handoff: Handoff }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    completeHandoff(handoff, {
      confirm: () => confirm(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    }).then((r) => {
      setResult(r);
      void qc.invalidateQueries();
    });
  }, [handoff, qc]);

  if (hidden) return null;
  const old = `${location.protocol}//${handoff.from}${location.pathname}`;
  return (
    <div class="border-b border-line bg-surface px-5 py-2">
      {!result ? (
        <Banner role="status">
          <span class="inline-flex items-center gap-2">
            <Spinner /> Confirming the change from the router's new address…
          </span>
        </Banner>
      ) : result.outcome === 'confirmed' ? (
        <Banner tone="ok" role="status" actions={<Button onClick={() => setHidden(true)}>Dismiss</Button>}>
          Changes applied. The router is now at {location.host}.
        </Banner>
      ) : (
        <Banner tone="warn" role="alert">
          The change could not be confirmed in time, so the router reverted to its previous address.{' '}
          <a class="text-accent underline" href={old}>
            Go back to {handoff.from}
          </a>
          .
        </Banner>
      )}
    </div>
  );
}

function SignedIn({
  session,
  onLogout,
  handoff,
  applyDeps,
}: {
  session: Session;
  onLogout: () => void;
  handoff?: Handoff;
  applyDeps: () => ApplyDeps;
}) {
  const ctl = useApplyController(applyDeps);
  const label = useSectionLabel();
  return (
    <ApplyContext.Provider value={ctl}>
      <Shell
        username={session.username}
        onLogout={onLogout}
        banner={
          <>
            {handoff && <HandoffBanner handoff={handoff} />}
            {!handoff && <StagedChangesBanner />}
          </>
        }
      >
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/clients/:mac?" component={ClientsPage} />
          <Route path="/topology" component={TopologyPage} />
          <Route path="/devices/:mac?" component={DevicesPage} />
          <Route path="/insights" component={InsightsPage} />
          <Route path="/logs" component={LogsPage} />
          <Route path="/setup">
            <Suspense fallback={<Spinner class="m-6" />}>
              <SetupPage />
            </Suspense>
          </Route>
          <Route path="/settings">
            <Redirect to="/settings/wifi" replace />
          </Route>
          <Route path="/settings/*">
            <SettingsLayout>
              <Suspense fallback={<Spinner class="m-6" />}>
                <Switch>
                  <Route path="/settings/wifi" component={WifiPage} />
                  <Route path="/settings/networks" component={NetworksPage} />
                  <Route path="/settings/ports" component={PortsPage} />
                  <Route path="/settings/ports/:mac" component={PortsPage} />
                  <Route path="/settings/internet" component={InternetPage} />
                  <Route path="/settings/security" component={FirewallPage} />
                  <Route path="/settings/vpn" component={VpnPage} />
                  <Route path="/settings/routing" component={RoutingPage} />
                  <Route path="/settings/system" component={SystemPage} />
                  <Route path="/settings/diagnostics" component={DiagnosticsPage} />
                  <Route path="/settings/health" component={HealthPage} />
                  <Route>
                    <NotFound />
                  </Route>
                </Switch>
              </Suspense>
            </SettingsLayout>
          </Route>
          <Route>
            <NotFound />
          </Route>
        </Switch>
      </Shell>
      <ApplyDialog ctl={ctl} sectionLabel={label} />
    </ApplyContext.Provider>
  );
}

function NotFound() {
  return <p class="p-6 text-muted">Page not found.</p>;
}

// Hash routing: uhttpd serves /www/netui/ as plain files with no SPA fallback,
// so path-based deep links would 404 on reload.
export function App({ handoff, applyDeps = browserDeps }: { handoff?: Handoff; applyDeps?: () => ApplyDeps }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(getSession);
  const [notice, setNotice] = useState<string | null>(() => takeRollbackNotice());

  useEffect(
    () =>
      onSessionExpired((why) => {
        queryClient.clear();
        setSession(null);
        setNotice(why ?? SESSION_EXPIRED);
      }),
    [queryClient],
  );

  const logout = () => {
    clearSession();
    queryClient.clear();
    setNotice(null);
    setSession(null);
  };

  return (
    <Router hook={useHashLocation}>
      {session ? (
        <SignedIn session={session} onLogout={logout} handoff={handoff} applyDeps={applyDeps} />
      ) : (
        // Rendered in place of any route so the user lands back where they were.
        <LoginPage
          notice={notice}
          onLogin={(s) => {
            setNotice(null);
            setSession(s);
          }}
        />
      )}
    </Router>
  );
}
