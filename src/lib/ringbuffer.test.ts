import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringbuffer';

describe('RingBuffer', () => {
  it('keeps insertion order until full', () => {
    const r = new RingBuffer<number>(3);
    r.push(1);
    r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    expect(r.last()).toBe(2);
  });

  it('overwrites the oldest entry past capacity', () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
    expect(r.last()).toBe(5);
  });

  it('clears', () => {
    const r = new RingBuffer<number>(2);
    r.push(1);
    r.clear();
    expect(r.size).toBe(0);
    expect(r.last()).toBeUndefined();
  });
});
