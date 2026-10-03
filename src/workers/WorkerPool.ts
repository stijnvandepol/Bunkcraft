import type { WorkerRequest, WorkerResponse } from './protocol';

type Callback = (res: WorkerResponse) => void;

interface Job {
  request: WorkerRequest;
  transfer: Transferable[];
  callback: Callback;
  onFail?: () => void;
  priority: boolean;
  attempts: number;
}

/** The subset of `Worker` the pool uses, so tests can inject a fake. */
export interface WorkerLike {
  onmessage: ((e: { data: WorkerResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

/** A job that crashes its worker this many times is dropped (poison job). */
const MAX_ATTEMPTS = 3;

function createChunkWorker(): WorkerLike {
  return new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

/**
 * Small fixed-size pool of chunk workers with a two-level priority queue.
 * Edits (player breaks/places a block) jump the queue so feedback stays instant
 * even while the world is still streaming in.
 */
export class WorkerPool {
  private readonly workers: WorkerLike[] = [];
  private readonly idle: WorkerLike[] = [];
  private readonly high: Job[] = [];
  private readonly normal: Job[] = [];
  private readonly busy = new Map<WorkerLike, Job>();
  private disposed = false;
  private nextId = 1;
  /** Rolling averages for the debug overlay. */
  genMs = 0;
  meshMs = 0;

  constructor(size: number, private readonly factory: () => WorkerLike = createChunkWorker) {
    for (let i = 0; i < size; i++) {
      const w = this.spawn();
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private spawn(): WorkerLike {
    const w = this.factory();
    w.onmessage = (e) => this.onResult(w, e.data);
    w.onerror = (e) => this.onCrash(w, e);
    w.onmessageerror = (e) => this.onCrash(w, e);
    return w;
  }

  /** Replace a crashed worker and put its in-flight job back in the queue (or fail it after too many tries). */
  private onCrash(w: WorkerLike, err: unknown): void {
    const idx = this.workers.indexOf(w);
    if (this.disposed || idx < 0) return; // already replaced (error + messageerror both fire)
    console.error('Chunk worker crashed', err);
    w.terminate();
    const job = this.busy.get(w);
    this.busy.delete(w);
    const i = this.idle.indexOf(w);
    if (i >= 0) this.idle.splice(i, 1);
    const fresh = this.spawn();
    this.workers[idx] = fresh;
    this.idle.push(fresh);
    if (job) {
      // A job with transferred buffers cannot be rerun (the buffers are detached): fail it, the caller rebuilds it.
      if (job.transfer.length > 0 || ++job.attempts >= MAX_ATTEMPTS) job.onFail?.();
      else (job.priority ? this.high : this.normal).unshift(job);
    }
    this.pump();
  }

  get size(): number {
    return this.workers.length;
  }

  get pending(): number {
    return this.high.length + this.normal.length + this.busy.size;
  }

  get queued(): number {
    return this.high.length + this.normal.length;
  }

  /**
   * `onFail` runs when the job crashed its worker too often and was dropped. A job with a transfer
   * list is never retried (its buffers are detached): it fails on the first crash.
   */
  submit(
    request: WorkerRequest, callback: Callback, transfer: Transferable[] = [], priority = false,
    onFail?: () => void,
  ): void {
    request.id = this.nextId++;
    const job: Job = { request, transfer, callback, onFail, priority, attempts: 0 };
    if (priority) this.high.push(job);
    else this.normal.push(job);
    this.pump();
  }

  private recycling: ArrayBuffer[] = [];
  private nextRecycle = 0;

  /** Hand a buffer that the main thread no longer needs back to a worker's pool (sent on the next `flushRecycle`). */
  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength > 0) this.recycling.push(buffer);
  }

  /** Send the collected buffers to one worker in a single zero-copy message. Call once per frame. */
  flushRecycle(): void {
    if (this.recycling.length === 0 || this.disposed || this.workers.length === 0) return;
    const buffers = this.recycling;
    this.recycling = [];
    const w = this.workers[this.nextRecycle++ % this.workers.length];
    w.postMessage({ type: 'recycle', id: 0, buffers }, buffers);
  }

  private pump(): void {
    while (this.idle.length > 0) {
      const job = this.high.shift() ?? this.normal.shift();
      if (!job) return;
      const w = this.idle.pop()!;
      this.busy.set(w, job);
      w.postMessage(job.request, job.transfer);
    }
  }

  private onResult(w: WorkerLike, res: WorkerResponse): void {
    const job = this.busy.get(w);
    this.busy.delete(w);
    this.idle.push(w);
    if (res.type === 'generate') this.genMs = this.genMs * 0.9 + res.ms * 0.1;
    else this.meshMs = this.meshMs * 0.9 + res.ms * 0.1;
    this.pump();
    job?.callback(res);
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}
