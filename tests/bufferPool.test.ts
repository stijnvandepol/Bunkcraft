import { describe, expect, it } from 'vitest';
import { BufferPool } from '../src/workers/BufferPool';

describe('BufferPool', () => {
  it('hands out power-of-two buffers and reuses released ones', () => {
    const pool = new BufferPool();
    const a = pool.acquire(5000);
    expect(a.byteLength).toBe(8192);
    expect(pool.release(a)).toBe(true);
    expect(pool.acquire(8000)).toBe(a);
    expect(pool.reused).toBe(1);
    expect(pool.fresh).toBe(1);
  });

  it('ignores buffers it cannot size-class and caps each class', () => {
    const pool = new BufferPool(2);
    expect(pool.release(new ArrayBuffer(3000))).toBe(false);
    expect(pool.release(new ArrayBuffer(16))).toBe(false);
    expect(pool.release(new ArrayBuffer(4096))).toBe(true);
    expect(pool.release(new ArrayBuffer(4096))).toBe(true);
    expect(pool.release(new ArrayBuffer(4096))).toBe(false);
  });

  it('refuses detached buffers', () => {
    const pool = new BufferPool();
    const b = new ArrayBuffer(4096);
    structuredClone(b, { transfer: [b] });
    expect(pool.release(b)).toBe(false);
  });
});
