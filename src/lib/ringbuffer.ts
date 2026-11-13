/** Fixed-capacity FIFO. Pushing past capacity overwrites the oldest entry. */
export class RingBuffer<T> {
  readonly capacity: number;
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`Bad capacity ${capacity}`);
    this.capacity = capacity;
    this.buf = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    this.buf[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }

  /** Most recent entry. */
  last(): T | undefined {
    return this.count === 0 ? undefined : this.buf[(this.head + this.count - 1) % this.capacity];
  }

  /** Oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.buf[(this.head + i) % this.capacity] as T);
    return out;
  }

  clear(): void {
    this.buf = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
