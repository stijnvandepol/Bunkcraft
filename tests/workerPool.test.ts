import { describe, expect, it, vi } from 'vitest';
import { WorkerPool, type WorkerLike } from '../src/workers/WorkerPool';
import type { WorkerRequest, WorkerResponse } from '../src/workers/protocol';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  posted: WorkerRequest[] = [];
  terminated = false;
  postMessage(m: WorkerRequest): void { this.posted.push(m); }
  terminate(): void { this.terminated = true; }
  reply(id: number): void {
    const res = { type: 'generate', id, blocks: new Uint8Array(0), biomes: new Uint8Array(0), ms: 1 } as WorkerResponse;
    this.onmessage?.({ data: res });
  }
}

const gen = (): WorkerRequest => ({ type: 'generate', id: 0, seed: 1, cx: 0, cz: 0 });

function setup(size = 1) {
  const made: FakeWorker[] = [];
  const pool = new WorkerPool(size, () => { const w = new FakeWorker(); made.push(w); return w; });
  return { pool, made };
}

describe('WorkerPool crash recovery', () => {
  it('replaces a crashed worker and reruns its job', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool, made } = setup();
    const cb = vi.fn();
    pool.submit(gen(), cb);
    expect(made[0].posted).toHaveLength(1);
    made[0].onerror?.(new Error('boom'));
    expect(made[0].terminated).toBe(true);
    expect(made).toHaveLength(2);
    expect(made[1].posted).toHaveLength(1);
    expect(pool.pending).toBe(1);
    made[1].reply(made[1].posted[0].id);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(pool.pending).toBe(0);
  });

  it('handles error and messageerror of the same worker once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool, made } = setup();
    pool.submit(gen(), vi.fn());
    made[0].onerror?.(1);
    made[0].onmessageerror?.(2);
    expect(made).toHaveLength(2);
    expect(pool.size).toBe(1);
  });

  it('drops a poison job after repeated crashes and keeps serving others', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool, made } = setup();
    const onFail = vi.fn();
    const other = vi.fn();
    pool.submit(gen(), vi.fn(), [], false, onFail);
    pool.submit(gen(), other);
    for (let i = 0; i < 3; i++) made[i].onerror?.(1);
    expect(onFail).toHaveBeenCalledTimes(1);
    const last = made[made.length - 1];
    expect(last.posted).toHaveLength(1);
    last.reply(last.posted[0].id);
    expect(other).toHaveBeenCalledTimes(1);
    expect(pool.pending).toBe(0);
  });
});
