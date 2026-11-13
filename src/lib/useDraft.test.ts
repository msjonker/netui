import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/preact';
import { deepEqual, useDraft } from './useDraft';

describe('useDraft', () => {
  it('follows the source while clean', () => {
    const { result, rerender } = renderHook(({ s }) => useDraft(s), { initialProps: { s: { a: 1 } } });
    rerender({ s: { a: 2 } });
    expect(result.current.draft).toEqual({ a: 2 });
    expect(result.current.dirty).toBe(false);
  });

  it('keeps the draft and flags stale when the router changes under an edit', () => {
    const { result, rerender } = renderHook(({ s }) => useDraft(s), { initialProps: { s: { a: 1 } } });
    act(() => result.current.update({ a: 5 }));
    expect(result.current.dirty).toBe(true);
    rerender({ s: { a: 2 } });
    expect(result.current.draft).toEqual({ a: 5 });
    expect(result.current.stale).toBe(true);
    act(() => result.current.reset());
    expect(result.current.draft).toEqual({ a: 2 });
    expect(result.current.stale).toBe(false);
  });

  it('is clean again when edited back to the original', () => {
    const { result } = renderHook(() => useDraft({ a: 1 }));
    act(() => result.current.update({ a: 3 }));
    act(() => result.current.update({ a: 1 }));
    expect(result.current.dirty).toBe(false);
  });
});

describe('deepEqual', () => {
  it('compares nested structures', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1] }, { a: [1, 2] })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});
