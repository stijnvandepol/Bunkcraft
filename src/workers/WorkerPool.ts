import type { WorkerRequest, WorkerResponse } from './protocol';

type Callback = (res: WorkerResponse) => void;

interface Job {
  request: WorkerRequest;
  transfer: Transferable[];
  callback: Callback;
}

/**
 * Small fixed-size pool of chunk workers with a two-level priority queue.
 * Edits (player breaks/places a block) jump the queue so feedback stays instant
 * even while the world is still streaming in.
 */
export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly high: Job[] = [];
  private readonly normal: Job[] = [];
  private readonly callbacks = new Map<number, Callback>();
  private readonly busy = new Map<Worker, number>();
  private nextId = 1;
  /** Rolling averages for the debug overlay. */
  genMs = 0;
  meshMs = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onResult(w, e.data);
      w.onerror = (e) => console.error('Chunk worker error', e);
      this.workers.push(w);
      this.idle.push(w);
    }
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

  submit(request: WorkerRequest, callback: Callback, transfer: Transferable[] = [], priority = false): void {
    request.id = this.nextId++;
    const job = { request, transfer, callback };
    if (priority) this.high.push(job);
    else this.normal.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.idle.length > 0) {
      const job = this.high.shift() ?? this.normal.shift();
      if (!job) return;
      const w = this.idle.pop()!;
      this.callbacks.set(job.request.id, job.callback);
      this.busy.set(w, job.request.id);
      w.postMessage(job.request, job.transfer);
    }
  }

  private onResult(w: Worker, res: WorkerResponse): void {
    this.busy.delete(w);
    this.idle.push(w);
    if (res.type === 'generate') this.genMs = this.genMs * 0.9 + res.ms * 0.1;
    else this.meshMs = this.meshMs * 0.9 + res.ms * 0.1;
    const cb = this.callbacks.get(res.id);
    this.callbacks.delete(res.id);
    this.pump();
    cb?.(res);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}
