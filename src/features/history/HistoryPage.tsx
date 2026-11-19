import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useHistory, useHistoryEntry } from '../../api/history';
import { getConfig, type UciOp } from '../../api/uci';
import { getSession } from '../../api/ubus';
import { useApply } from '../../api/useApply';
import type { HistoryEntry, HistoryList, UciConfig } from '../../api/types';
import { dayLabel, relativeTime } from '../../model/events';
import { DISRUPTIVE, diffConfigs, packageLabel, pageLabel, restoreOps, type SectionChange } from '../../model/history';
import { sectionLabelFor } from '../../components/ApplyDialog';
import { Modal } from '../../components/overlay';
import { IconChevronRight } from '../../components/icons';
import { Banner, Button, Card, Empty, LoadError, Page, Pill, Spinner, cx } from '../../components/ui';

const RETURN = '/settings/history';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Changes({ pkg, before, after }: { pkg: string; before: UciConfig | null; after: UciConfig | null }) {
  const changes = diffConfigs(before, after);
  if (!changes.length) return <p class="text-xs text-muted">No visible change.</p>;
  const mark = (c: SectionChange) => (c.kind === 'add' ? '+' : c.kind === 'remove' ? '−' : '~');
  return (
    <ul class="space-y-1.5">
      {changes.map((c, i) => (
        <li key={i} class="text-xs">
          <div class="flex gap-1.5 font-medium">
            <span class={cx('w-3 font-bold', c.kind === 'add' ? 'text-ok' : c.kind === 'remove' ? 'text-bad' : 'text-accent')}>{mark(c)}</span>
            <span>
              {c.kind === 'add' ? 'New ' : c.kind === 'remove' ? 'Removed ' : ''}
              {sectionLabelFor(c.section, c.section['.name'], pkg)}
            </span>
          </div>
          {c.kind !== 'remove' && (
            <dl class="ml-4.5 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px] text-muted">
              {c.options.map((o) => (
                <Fragment key={o.option}>
                  <dt>{o.option}</dt>
                  <dd class="break-all">
                    {c.kind === 'change' && o.before !== undefined && <span class="line-through">{o.before}</span>}
                    {c.kind === 'change' && (o.before !== undefined ? ' → ' : '(new) ')}
                    <span class="text-fg">{o.after ?? '(removed)'}</span>
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Ops that turn each package back into `target`, read against the router now. */
async function opsBackTo(target: Record<string, UciConfig | null>): Promise<{ ops: UciOp[]; skipped: string[] }> {
  const ops: UciOp[] = [];
  const skipped: string[] = [];
  for (const [pkg, cfg] of Object.entries(target)) {
    if (!cfg) {
      skipped.push(pkg);
      continue;
    }
    ops.push(...restoreOps(pkg, await getConfig(pkg), cfg));
  }
  return { ops, skipped };
}

function useUndo() {
  const apply = useApply();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const run = async (target: Record<string, UciConfig | null>) => {
    setError(undefined);
    setWorking(true);
    try {
      const { ops, skipped } = await opsBackTo(target);
      if (!ops.length) {
        setError(skipped.length ? `${skipped.map(packageLabel).join(', ')} cannot be put back from here.` : 'The settings already read like that.');
        return;
      }
      const disruptive = ops.some((o) => DISRUPTIVE.has(o.config));
      await apply.start(ops, { returnTo: RETURN, disruptive });
    } catch (e) {
      setError(message(e));
    } finally {
      setWorking(false);
    }
  };
  return { run, error, busy: working || apply.busy };
}

function EntryDetail({ entry, later }: { entry: HistoryEntry; later: HistoryEntry[] }) {
  const detail = useHistoryEntry(entry.id);
  const undo = useUndo();
  const [confirm, setConfirm] = useState(false);
  if (detail.isPending) return <Spinner class="m-3" />;
  if (detail.error) return <p class="text-xs text-bad">{message(detail.error)}</p>;
  const d = detail.data!;
  // Later changes to the same packages are undone too: the packages go back as a whole.
  const overlapping = later.filter((l) => l.packages.some((p) => entry.packages.includes(p)));
  return (
    <div class="space-y-3">
      {entry.packages.map((pkg) => (
        <div key={pkg}>
          <p class="pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{packageLabel(pkg)}</p>
          <Changes pkg={pkg} before={d.before[pkg] ?? null} after={d.after[pkg] ?? null} />
        </div>
      ))}
      {undo.error && (
        <p class="text-xs text-bad" role="alert">
          {undo.error}
        </p>
      )}
      <div class="flex justify-end">
        <Button disabled={undo.busy} onClick={() => (overlapping.length ? setConfirm(true) : void undo.run(d.before))}>
          {entry.outside ? 'Put Back as Before' : 'Undo This Change'}
        </Button>
      </div>
      {confirm && (
        <Modal
          title="Undo later changes too?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirm(false);
                  void undo.run(d.before);
                }}
              >
                Review Changes
              </Button>
            </>
          }
        >
          <p class="text-muted">
            {entry.packages.map(packageLabel).join(', ')} {entry.packages.length > 1 ? 'go' : 'goes'} back to how{' '}
            {entry.packages.length > 1 ? 'they were' : 'it was'} before this change, which also undoes {overlapping.length} later{' '}
            {overlapping.length === 1 ? 'change' : 'changes'} to {entry.packages.length > 1 ? 'them' : 'it'}. You see every change
            before it is applied.
          </p>
        </Modal>
      )}
    </div>
  );
}

function EntryRow({ entry, later, admin, now }: { entry: HistoryEntry; later: HistoryEntry[]; admin: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const t = entry.time * 1000;
  const title = entry.outside ? 'Changed outside netui' : `Applied from ${pageLabel(entry.page) ?? 'netui'}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        class="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-hover"
      >
        <IconChevronRight size={16} class={cx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{title}</span>
            {entry.outside && <Pill tone="warn">Outside</Pill>}
          </span>
          <span class="block text-xs text-muted">
            {entry.packages.map(packageLabel).join(', ')}
            {entry.user && ` · ${entry.user}`}
          </span>
        </span>
        <span class="shrink-0 text-right text-xs text-muted" title={new Date(t).toLocaleString()}>
          {relativeTime(t, now)}
          <span class="block">{new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </span>
      </button>
      {open && (
        <div class="border-t border-line bg-subtle/40 px-5 py-3 pl-12">
          {admin ? <EntryDetail entry={entry} later={later} /> : <p class="text-xs text-muted">An admin login shows what changed.</p>}
        </div>
      )}
    </li>
  );
}

/** Packages changed since the last recorded state, and putting them back. */
function OutsideChanges({ list, admin }: { list: HistoryList; admin: boolean }) {
  const [open, setOpen] = useState(false);
  if (!list.changed.length) return null;
  // The newest entry holding each changed package has its last recorded state.
  const source = list.changed.map((pkg) => [pkg, list.entries.find((e) => e.packages.includes(pkg))!] as const);
  return (
    <div class="mb-4 space-y-2">
      <Banner
        tone="warn"
        role="status"
        actions={admin && <Button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>}
      >
        Changed outside netui since its last change: {list.changed.map(packageLabel).join(', ')}. Another tool (LuCI, ssh) or a
        service changed {list.changed.length > 1 ? 'them' : 'it'}; it is recorded here with the next change.
      </Banner>
      {open && (
        <Card>
          {source.map(([pkg, entry]) => (
            <OutsideDiff key={pkg} pkg={pkg} entry={entry} />
          ))}
        </Card>
      )}
    </div>
  );
}

function OutsideDiff({ pkg, entry }: { pkg: string; entry: HistoryEntry }) {
  const detail = useHistoryEntry(entry.id);
  const [now, setNow] = useState<UciConfig>();
  const [error, setError] = useState<string>();
  const undo = useUndo();
  const recorded = detail.data?.after[pkg] ?? null;
  // Read fresh from the router, never from a cache.
  useEffect(() => {
    getConfig(pkg).then(setNow, (e) => setError(message(e)));
  }, [pkg]);
  return (
    <div class="py-2">
      <p class="pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{packageLabel(pkg)}</p>
      {error || detail.error ? (
        <p class="text-xs text-bad">{error ?? message(detail.error)}</p>
      ) : !now || !detail.data ? (
        <Spinner />
      ) : (
        <>
          <Changes pkg={pkg} before={recorded} after={now} />
          {undo.error && <p class="text-xs text-bad">{undo.error}</p>}
          <div class="flex justify-end pt-2">
            <Button disabled={undo.busy} onClick={() => void undo.run({ [pkg]: recorded })}>
              Put Back as netui Left It
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function HistoryPage() {
  const history = useHistory();
  const admin = !getSession()?.readOnly;
  const now = Date.now();
  const entries = history.data?.entries ?? [];
  // Group by day, newest first (as the plugin lists them).
  const days: [string, HistoryEntry[]][] = [];
  for (const e of entries) {
    const label = dayLabel(e.time * 1000, now);
    const last = days.at(-1);
    if (last && last[0] === label) last[1].push(e);
    else days.push([label, [e]]);
  }
  return (
    <Page title="Change History" subtitle="Every change applied from netui, and what else changed the settings">
      <LoadError error={history.error} />
      {history.isPending && <Spinner class="m-6" />}
      {history.data && (
        <>
          <OutsideChanges list={history.data} admin={admin} />
          {entries.length === 0 ? (
            <Card>
              <Empty>
                <p class="font-medium text-fg">No changes recorded yet.</p>
                <p class="mx-auto mt-1 max-w-md">
                  From now on every change applied from netui appears here with what it changed, and a way to undo it.
                </p>
              </Empty>
            </Card>
          ) : (
            <div class="space-y-4">
              {days.map(([label, list]) => (
                <Card key={label} title={label} flush>
                  <ul class="divide-y divide-line">
                    {list.map((e) => (
                      <EntryRow key={e.id} entry={e} later={entries.filter((x) => x.id > e.id)} admin={admin} now={now} />
                    ))}
                  </ul>
                </Card>
              ))}
              <p class="px-1 text-xs text-muted">
                The router keeps the latest changes (up to about 100, fewer when they are large) in /etc/netui/history.
              </p>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
