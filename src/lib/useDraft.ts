import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Local edit state for a settings form backed by router data.
 *
 * While the form is clean it follows `source`, so a refetch (window focus,
 * after apply) shows what is on the router now. Once edited it holds the
 * user's draft and sets `stale` if the router's copy changes underneath, so
 * the page can offer to reload rather than silently overwrite.
 *
 * Changes to `source` are detected by value, so callers may rebuild it each
 * render, though memoizing it over query data saves the comparison.
 */
export function useDraft<T>(source: T | undefined) {
  const [draft, setDraft] = useState<T | undefined>(source);
  const base = useRef<T | undefined>(source);
  const [stale, setStale] = useState(false);
  const dirty = draft !== undefined && !deepEqual(draft, base.current);

  useEffect(() => {
    if (source === undefined || deepEqual(source, base.current)) return;
    // Clean, or the router now holds exactly the draft (it was just applied).
    if (base.current === undefined || !dirty || deepEqual(source, draft)) {
      base.current = source;
      setDraft(source);
      setStale(false);
    } else {
      setStale(true);
    }
    // `dirty` and `draft` are read deliberately at the time the source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const reset = useCallback(() => {
    base.current = source;
    setDraft(source);
    setStale(false);
  }, [source]);

  const update = useCallback((patch: Partial<T> | ((d: T) => T)) => {
    setDraft((d) => (d === undefined ? d : typeof patch === 'function' ? patch(d) : { ...d, ...patch }));
  }, []);

  return { draft, base: base.current, dirty, stale, reset, update, set: setDraft };
}
