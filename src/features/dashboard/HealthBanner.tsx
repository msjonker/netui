import { Link } from 'wouter-preact';
import { summary } from '../../model/health';
import { useHealthChecks } from '../../model/healthHooks';
import { Banner } from '../../components/ui';

/**
 * Risks and warnings from the health check, as one line on the dashboard.
 * Loaded on demand. The missing root password is left to SetupBanner, which
 * already says so here.
 */
export function HealthBanner() {
  const { checks } = useHealthChecks();
  if (!checks) return null;
  const s = summary(checks.map((c) => ({ ...c, findings: c.findings.filter((f) => f.id !== 'root-password') })));
  if (!s.risk && !s.warn) return null;
  const parts = [s.risk && `${s.risk} ${s.risk === 1 ? 'risk' : 'risks'}`, s.warn && `${s.warn} ${s.warn === 1 ? 'setting' : 'settings'} to check`];
  return (
    <div class="lg:col-span-3">
      <Banner
        tone={s.risk ? 'bad' : 'warn'}
        role="status"
        actions={
          <Link
            href="/settings/health"
            class="inline-flex h-8 items-center rounded-md border border-transparent bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover"
          >
            Review
          </Link>
        }
      >
        Health check: {parts.filter(Boolean).join(' and ')}.
      </Banner>
    </div>
  );
}
