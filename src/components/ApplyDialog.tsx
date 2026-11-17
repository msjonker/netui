import { useEffect, useState } from 'preact/hooks';
import type { ApplyPhase, ApplyResult } from '../api/apply';
import type { UciChange } from '../api/types';
import type { ApplyController } from '../api/useApply';
import { Modal } from './overlay';
import { Banner, Button, Spinner, cx } from './ui';

// Review-and-apply dialog for the apply/rollback flow. Purely presentational:
// all behaviour comes from the ApplyController passed in.

export interface ChangeLine {
  kind: 'add' | 'set' | 'remove';
  section: string;
  option?: string;
  value?: string;
  /** For a section created in this change set: its options, folded in. */
  fields?: { option: string; value: string }[];
}

/**
 * Collapse rpcd's change list into one line per option (list ops merged).
 * Options set on a section created in the same change set are folded into
 * that section's add line instead of reading as edits to an unknown id.
 */
export function describeChanges(changes: UciChange[]): ChangeLine[] {
  const out: ChangeLine[] = [];
  const added = new Map<string, ChangeLine>();
  // Lines that later list-add entries append to, keyed by section.option.
  const lists = new Map<string, { value?: string }>();
  const setOption = (section: string, option: string, value: string, list: boolean) => {
    const key = `${section}.${option}`;
    const existing = list ? lists.get(key) : undefined;
    if (existing) {
      existing.value = `${existing.value}, ${value}`;
      return;
    }
    const parent = added.get(section);
    let line: { value?: string };
    if (parent) {
      const field = { option, value };
      parent.fields = [...(parent.fields ?? []).filter((f) => f.option !== option), field];
      line = field;
    } else {
      // A list set is staged as remove + list-add; drop the remove.
      const i = out.findIndex((l) => l.kind === 'remove' && l.section === section && l.option === option);
      if (i >= 0) out.splice(i, 1);
      const set: ChangeLine = { kind: 'set', section, option, value };
      out.push(set);
      line = set;
    }
    if (list) lists.set(key, line);
  };
  const addSection = (section: string, type: string) => {
    const line: ChangeLine = { kind: 'add', section, value: type };
    added.set(section, line);
    out.push(line);
  };
  for (const [op, section, a, b] of changes) {
    switch (op) {
      case 'add':
        addSection(section, a ?? '');
        break;
      case 'set':
        // ["set", sec, type] creates a named section; ["set", sec, opt, val] sets an option.
        if (b === undefined) addSection(section, a ?? '');
        else setOption(section, a!, b, false);
        break;
      case 'list-add':
        setOption(section, a!, b ?? '', true);
        break;
      case 'remove': {
        const parent = added.get(section);
        if (parent && a) {
          parent.fields = parent.fields?.filter((f) => f.option !== a);
          lists.delete(`${section}.${a}`);
        } else if (parent) {
          // Created and deleted again: nothing reaches the router.
          out.splice(out.indexOf(parent), 1);
          added.delete(section);
        } else out.push({ kind: 'remove', section, option: a });
        break;
      }
      default:
        out.push({ kind: 'set', section, option: op, value: [a, b].filter(Boolean).join(' ') });
    }
  }
  return out;
}

const PACKAGE_LABEL: Record<string, string> = {
  network: 'Networks',
  wireless: 'WiFi',
  dhcp: 'DHCP',
  firewall: 'Firewall',
};

const TYPE_LABEL: Record<string, string> = {
  host: 'Fixed IP',
  redirect: 'Port forward',
  rule: 'Firewall rule',
  zone: 'Firewall zone',
  forwarding: 'Zone forwarding',
  'wifi-iface': 'WiFi network',
  'wifi-device': 'Radio',
  interface: 'Network',
  device: 'Device',
  'bridge-vlan': 'VLAN',
  dhcp: 'DHCP pool',
};

/** Types that mean something else in the network package. */
const NETWORK_TYPE_LABEL: Record<string, string> = { rule: 'Routing rule', route: 'Static route' };

/** Friendly name for a UCI section type, e.g. host → "Fixed IP". */
export function sectionTypeLabel(type: string, pkg?: string): string {
  return (pkg === 'network' ? NETWORK_TYPE_LABEL[type] : undefined) ?? TYPE_LABEL[type] ?? type;
}

const SECRET = /(^|_)(key|password|psk|token)$/;
const shown = (option: string | undefined, value: string | undefined) => (SECRET.test(option ?? '') ? '••••••••' : value);

function Marker({ kind }: { kind: ChangeLine['kind'] }) {
  return (
    <span
      class={cx('w-3 shrink-0 font-bold', kind === 'add' ? 'text-ok' : kind === 'remove' ? 'text-bad' : 'text-accent')}
      aria-label={kind}
    >
      {kind === 'add' ? '+' : kind === 'remove' ? '−' : '~'}
    </span>
  );
}

function ChangeList({
  changes,
  label,
}: {
  changes: Record<string, UciChange[]>;
  label: (pkg: string, section: string) => string;
}) {
  return (
    <div class="space-y-3">
      {Object.entries(changes).map(([pkg, list]) => (
        <section key={pkg}>
          <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{PACKAGE_LABEL[pkg] ?? pkg}</h3>
          <ul class="divide-y divide-line rounded-md border border-line font-mono text-xs">
            {describeChanges(list).map((l, i) =>
              l.kind === 'add' ? (
                <li key={i} class="px-3 py-1.5">
                  <div class="flex gap-2">
                    <Marker kind="add" />
                    <span class="min-w-0 flex-1 font-sans font-medium break-all">
                      New {sectionTypeLabel(l.value ?? '', pkg).toLowerCase()}
                      {(() => {
                        const name = l.fields?.find((f) => f.option === 'name' || f.option === 'ssid')?.value;
                        return name ? <span class="text-muted"> "{name}"</span> : null;
                      })()}
                    </span>
                  </div>
                  {!!l.fields?.length && (
                    <dl class="mt-1 ml-5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      {l.fields.map((f) => (
                        <div key={f.option} class="contents">
                          <dt class="text-muted">{f.option}</dt>
                          <dd class="break-all text-fg">{shown(f.option, f.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              ) : (
                <li key={i} class="flex gap-2 px-3 py-1.5">
                  <Marker kind={l.kind} />
                  <span class="min-w-0 flex-1 break-all">
                    <span class="text-muted">{label(pkg, l.section)}</span>
                    {l.option && <span>.{l.option}</span>}
                    {l.kind === 'set' && (
                      <>
                        {' = '}
                        <span class="text-fg">{shown(l.option, l.value)}</span>
                      </>
                    )}
                    {l.kind === 'remove' && !l.option && <span class="text-muted"> (deleted)</span>}
                  </span>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return <span class="tabular-nums">{Math.max(0, Math.ceil((deadline - now) / 1000))}s</span>;
}

function phaseText(p: ApplyPhase) {
  switch (p.phase) {
    case 'applying':
      return 'Sending changes to the router…';
    case 'waiting':
      return (
        <>
          Router is applying changes. They revert automatically in <Countdown deadline={p.deadline} /> unless confirmed.
        </>
      );
    case 'confirming':
      return (
        <>
          Checking the connection before confirming (<Countdown deadline={p.deadline} /> left)…
        </>
      );
    case 'probing':
      return (
        <>
          Waiting for the router at <strong>{p.address}</strong> (<Countdown deadline={p.deadline} /> left)…
        </>
      );
    case 'reverting':
      return 'The change was not confirmed in time. Waiting for the router to restore the previous settings…';
  }
}

function resultView(r: ApplyResult) {
  switch (r.outcome) {
    case 'confirmed':
      return <Banner tone="ok" role="status">Changes applied.</Banner>;
    case 'nothing':
      return <Banner role="status">There was nothing to apply.</Banner>;
    case 'busy':
      return (
        <Banner tone="warn" role="alert">
          Another session is applying changes right now. Your changes are still staged; try again in a moment.
        </Banner>
      );
    case 'rolledback':
      return (
        <Banner tone="warn" role="alert">
          {r.address
            ? `The router did not answer at ${r.address}, so it reverted to the previous settings. `
            : 'The router could not be reached after the change, so it reverted to the previous settings. '}
          Nothing was changed.
        </Banner>
      );
    default:
      return null;
  }
}

export function ApplyDialog({
  ctl,
  sectionLabel,
}: {
  ctl: ApplyController;
  sectionLabel: (pkg: string, section: string) => string;
}) {
  const s = ctl.state;

  // A plain success closes itself.
  useEffect(() => {
    if (s.step === 'done' && (s.result.outcome === 'confirmed' || s.result.outcome === 'nothing')) {
      const t = setTimeout(ctl.close, 1200);
      return () => clearTimeout(t);
    }
  }, [s, ctl.close]);

  if (s.step === 'idle') return null;

  if (s.step === 'staging') {
    return (
      <Modal title="Preparing changes" onClose={() => {}} locked>
        <div class="flex items-center gap-3 py-3 text-muted">
          <Spinner /> Staging changes on the router…
        </div>
      </Modal>
    );
  }

  if (s.step === 'review') {
    const empty = Object.keys(s.changes).length === 0;
    return (
      <Modal
        title="Review changes"
        wide
        onClose={ctl.discard}
        footer={
          <>
            <Button onClick={ctl.discard}>Discard</Button>
            <Button variant="primary" onClick={ctl.confirm} disabled={empty}>
              Apply Changes
            </Button>
          </>
        }
      >
        {empty ? (
          <p class="py-3 text-muted">These edits match what is already on the router.</p>
        ) : (
          <>
            <ChangeList changes={s.changes} label={sectionLabel} />
            <p class="mt-4 text-xs text-muted">
              The router applies these with a 30 second safety timer and reverts them on its own unless netui can reach it
              afterwards and confirm.
              {s.plan.newAddress && (
                <>
                  {' '}
                  This moves the router to <strong class="text-fg">{s.plan.newAddress}</strong>; netui will follow it there.
                </>
              )}
            </p>
          </>
        )}
      </Modal>
    );
  }

  if (s.step === 'running') {
    return (
      <Modal title="Applying changes" onClose={() => {}} locked>
        <div class="flex items-start gap-3 py-3">
          <Spinner class="mt-0.5" />
          <p role="status">{phaseText(s.phase)}</p>
        </div>
      </Modal>
    );
  }

  if (s.step === 'done') {
    const busy = s.result.outcome === 'busy';
    return (
      <Modal
        title={s.result.outcome === 'confirmed' ? 'Done' : 'Changes not applied'}
        onClose={busy ? ctl.discard : ctl.close}
        footer={
          busy ? (
            <>
              <Button onClick={ctl.discard}>Discard</Button>
              <Button variant="primary" onClick={ctl.confirm}>
                Try again
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={ctl.close}>
              OK
            </Button>
          )
        }
      >
        <div class="py-2">{resultView(s.result)}</div>
        {s.failedServices && (
          <p class="pb-2 text-xs text-warn" role="status">
            Saved, but updating {s.failedServices.join(', ')} failed.{' '}
            {s.failedServices.includes('access points')
              ? 'Copy the WiFi again from the Devices page once they are reachable.'
              : 'The change takes effect after the next restart of the router.'}
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title="Something went wrong"
      onClose={ctl.discard}
      footer={
        <Button variant="primary" onClick={ctl.discard}>
          Discard staged changes
        </Button>
      }
    >
      <div class="py-2">
        <Banner tone="bad" role="alert">
          {s.message}
        </Banner>
      </div>
    </Modal>
  );
}
