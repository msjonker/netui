import { Link } from 'wouter-preact';
import { useApply } from '../../api/useApply';
import { allFindings, summary, type Finding, type Severity } from '../../model/health';
import { useHealthChecks } from '../../model/healthHooks';
import { IconCheckCircle } from '../../components/icons';
import { Button, Card, Empty, LoadError, Page, Pill, Spinner, cx } from '../../components/ui';

const RETURN = '/settings/health';

const SEVERITY: Record<Severity, { label: string; tone: 'bad' | 'warn' | 'neutral' }> = {
  risk: { label: 'Risk', tone: 'bad' },
  warn: { label: 'Check', tone: 'warn' },
  info: { label: 'Note', tone: 'neutral' },
};

const linkClass = 'inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover';

function FindingRow({ f, onIgnore, ignored }: { f: Finding; onIgnore: () => void; ignored?: boolean }) {
  const apply = useApply();
  // Firewall changes can briefly drop connections: give the router more time before confirming.
  const disruptive = !!f.fix?.ops.some((o) => o.config === 'firewall');
  return (
    <li class="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <Pill tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Pill>
          <span class={cx('font-medium', ignored && 'text-muted')}>{f.title}</span>
        </div>
        <p class="mt-1 text-xs text-muted">{f.detail}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <Button onClick={onIgnore}>{ignored ? 'Restore' : 'Ignore'}</Button>
        {!ignored && f.link && (
          <Link href={f.link.href} class={linkClass}>
            {f.link.label}
          </Link>
        )}
        {!ignored && f.fix && f.fix.ops.length > 0 && (
          <Button variant="primary" disabled={apply.busy} onClick={() => void apply.start(f.fix!.ops, { returnTo: RETURN, disruptive })}>
            {f.fix.label}
          </Button>
        )}
      </div>
    </li>
  );
}

export function HealthPage() {
  const { checks, ignoredFindings, setIgnore, error, loading } = useHealthChecks();
  if (!checks) {
    return (
      <Page title="Health Check" subtitle="Risky or ineffective settings, and how to fix them">
        <LoadError error={error} />
        {loading && <Spinner class="m-6" />}
      </Page>
    );
  }
  const s = summary(checks);
  const findings = allFindings(checks);
  const passed = checks.filter((c) => !c.findings.length);
  const headline =
    s.risk + s.warn === 0
      ? 'Nothing needs your attention.'
      : [s.risk && `${s.risk} ${s.risk === 1 ? 'risk' : 'risks'}`, s.warn && `${s.warn} to check`].filter(Boolean).join(', ') + '.';

  return (
    <Page title="Health Check" subtitle="Risky or ineffective settings, and how to fix them">
      <div class="space-y-4">
        <Card>
          <div class="flex items-center gap-4">
            <span
              class={cx(
                'grid size-12 shrink-0 place-items-center rounded-2xl',
                s.risk ? 'bg-bad-soft text-bad' : s.warn ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok',
              )}
            >
              <IconCheckCircle size={26} />
            </span>
            <div>
              <p class="text-lg font-semibold">{headline}</p>
              <p class="text-xs text-muted">
                {passed.length} of {checks.length} checks passed. Read from the router's settings just now; fixes go through the
                usual review and are undone automatically if the router stops answering.
              </p>
            </div>
          </div>
        </Card>

        {findings.length > 0 && (
          <Card title="Findings" flush>
            <ul class="divide-y divide-line">
              {findings.map((f) => (
                <FindingRow key={f.id} f={f} onIgnore={() => setIgnore(f.id, true)} />
              ))}
            </ul>
          </Card>
        )}

        <Card title="Passed" flush>
          {passed.length ? (
            <ul class="divide-y divide-line">
              {passed.map((c) => (
                <li key={c.id} class="flex items-center gap-3 px-5 py-2.5">
                  <IconCheckCircle size={18} class="shrink-0 text-ok" />
                  {c.label}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No check passed yet.</Empty>
          )}
        </Card>

        {ignoredFindings.length > 0 && (
          <Card title="Ignored in this browser" flush>
            <ul class="divide-y divide-line">
              {ignoredFindings.map((f) => (
                <FindingRow key={f.id} f={f} ignored onIgnore={() => setIgnore(f.id, false)} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </Page>
  );
}
