import { createContext } from 'preact';
import { useCallback, useContext, useMemo, useRef, useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { browserDeps, runApply, type ApplyDeps, type ApplyPhase, type ApplyPlan, type ApplyResult } from './apply';
import { getChanges, revert, stage, type UciOp } from './uci';
import { getSession } from './ubus';
import { runServiceHooks } from './services';
import type { UciChange } from './types';

// The UI side of the apply/rollback contract:
//   start(ops) stages them and loads `uci changes` for review,
//   confirm() runs apply with rollback, discard() reverts.
// One instance lives at the app root; features reach it with useApply().

export type ApplyState =
  | { step: 'idle' }
  | { step: 'staging' }
  | { step: 'review'; changes: Record<string, UciChange[]>; plan: ApplyPlan }
  | { step: 'running'; phase: ApplyPhase; plan: ApplyPlan }
  | { step: 'done'; result: ApplyResult; plan: ApplyPlan; failedServices?: string[] }
  | { step: 'error'; message: string; packages: string[] };

export interface ApplyApi {
  /** Stage `ops` and open the review dialog. Resolves once staged. */
  start(ops: UciOp[], plan?: Omit<ApplyPlan, 'packages'>): Promise<void>;
  /** Review changes already staged in this session (e.g. left by an interrupted apply). */
  review(packages?: string[]): Promise<void>;
  busy: boolean;
}

export const ApplyContext = createContext<ApplyApi | null>(null);

export function useApply(): ApplyApi {
  const api = useContext(ApplyContext);
  if (!api) throw new Error('useApply outside ApplyContext');
  return api;
}

export interface ApplyController extends ApplyApi {
  state: ApplyState;
  confirm(): Promise<void>;
  discard(): Promise<void>;
  close(): void;
}

/** Second re-read after a confirmed apply, once service reloads have finished. */
const SETTLE_MS = 4_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useApplyController(deps: () => ApplyDeps = browserDeps): ApplyController {
  const qc = useQueryClient();
  const [state, setState] = useState<ApplyState>({ step: 'idle' });
  const planRef = useRef<ApplyPlan | null>(null);

  const refresh = useCallback(() => qc.invalidateQueries(), [qc]);

  const openReview = useCallback(async (plan: ApplyPlan) => {
    const all = await getChanges();
    // Show every staged package, not only the ones just touched: anything
    // staged in this session goes out with the apply.
    const changes = Object.fromEntries(Object.entries(all).filter(([, c]) => c.length > 0));
    const packages = [...new Set([...plan.packages, ...Object.keys(changes)])];
    const full = { ...plan, packages };
    planRef.current = full;
    setState({ step: 'review', changes, plan: full });
  }, []);

  const start = useCallback<ApplyApi['start']>(
    async (ops, extra = {}) => {
      const packages = [...new Set(ops.map((o) => o.config))];
      setState({ step: 'staging' });
      try {
        await stage(ops);
        await openReview({ ...extra, packages });
      } catch (err) {
        // Leave nothing half-staged behind.
        await revert(packages).catch(() => {});
        setState({ step: 'error', message: message(err), packages });
      }
    },
    [openReview],
  );

  const review = useCallback<ApplyApi['review']>(
    async (packages = []) => {
      setState({ step: 'staging' });
      try {
        await openReview({ packages });
      } catch (err) {
        setState({ step: 'error', message: message(err), packages });
      }
    },
    [openReview],
  );

  const confirm = useCallback(async () => {
    const plan = planRef.current;
    if (!plan) return;
    setState({ step: 'running', phase: { phase: 'applying' }, plan });
    try {
      const result = await runApply(plan, deps(), (phase) => setState({ step: 'running', phase, plan }));
      if (result.outcome === 'redirected' || result.outcome === 'expired') return;
      const failed = result.outcome === 'confirmed' ? await runServiceHooks(plan.packages) : [];
      setState({ step: 'done', result, plan, ...(failed.length ? { failedServices: failed } : {}) });
      if (result.outcome === 'confirmed') plan.onConfirmed?.();
      if (result.outcome !== 'busy') await refresh();
      // Services reload asynchronously after apply (hostname, radios, interfaces
      // coming up): read again once they have settled.
      if (result.outcome === 'confirmed') setTimeout(() => void refresh(), SETTLE_MS);
    } catch (err) {
      setState({ step: 'error', message: message(err), packages: [...plan.packages] });
      await refresh();
    }
  }, [deps, refresh]);

  const discard = useCallback(async () => {
    const packages = planRef.current?.packages ?? (state.step === 'error' ? state.packages : []);
    setState({ step: 'staging' });
    try {
      await revert(packages);
      planRef.current = null;
      setState({ step: 'idle' });
    } catch (err) {
      setState({ step: 'error', message: message(err), packages: [...packages] });
    }
    await refresh();
  }, [refresh, state]);

  const close = useCallback(() => {
    planRef.current = null;
    setState({ step: 'idle' });
  }, []);

  return useMemo(
    // A read-only login changes nothing: every Apply button stays disabled.
    () => ({ state, start, review, confirm, discard, close, busy: state.step !== 'idle' || !!getSession()?.readOnly }),
    [state, start, review, confirm, discard, close],
  );
}
