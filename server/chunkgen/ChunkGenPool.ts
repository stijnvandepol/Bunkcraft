/**
 * Server-side chunk generation off the main thread: a few worker_threads run the shared terrain generator, so a
 * player exploring new land no longer stalls the game ticks of everyone on the server (docs/research/SERVER-DEPLOY.md, A).
 *
 * One pool per process, shared by all games. Requests carry a priority (the chunk's ring distance to the nearest
 * player: 0 first), are de-duplicated per world and chunk, and wait in a bounded queue. Results come back with their
 * buffers transferred and are handed to the world that asked (ServerWorld installs them on its next tick).
 */
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { GenSpec, GeneratedChunk } from './genChunk';
import type { GenRequest, GenResponse } from './protocol';

/** The world side of a request (ServerWorld). */
export interface GenClient {
  readonly genSpec: GenSpec;
  /** A requested chunk is ready. Not called for cancelled requests. */
  chunkGenerated(cx: number, cz: number, key: number, chunk: GeneratedChunk): void;
  /** The request was pushed out of a full queue by nearer chunks, or the worker failed on it: ask again later. */
  chunkDropped(cx: number, cz: number, key: number, failed: boolean): void;
}

/** What the pool needs from a worker thread (a fake one in the tests). */
export interface WorkerLike {
  postMessage(msg: GenRequest): void;
  on(event: 'message', fn: (msg: GenResponse) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
}

export interface ChunkGenPoolOptions {
  /** Worker threads (≥ 1). */
  size: number;
  /** Requests waiting at most (in flight not counted); further requests replace farther ones or are refused. */
  maxQueue?: number;
  /** Requests handed to one worker at a time (2 keeps it busy during the message round trip). */
  perWorker?: number;
  /** Starts one worker; default the real genWorker entry. */
  spawn?: () => WorkerLike;
  /** Called when a worker fails (logging). */
  onError?: (message: string) => void;
}

export interface ChunkGenStats {
  workers: number;
  queued: number;
  inFlight: number;
  generated: number;
  dropped: number;
  failed: number;
  /** Total time the workers spent generating, ms. */
  genMs: number;
}

/** Priorities above this share the last bucket. */
export const MAX_PRIORITY = 15;
/** A worker that keeps crashing is replaced at most this often before the pool gives up (worlds fall back to the main thread). */
const MAX_RESPAWNS = 8;

interface Job {
  client: GenClient;
  key: number;
  cx: number;
  cz: number;
  prio: number;
  /** Waiting in a bucket, in flight on a worker, or cancelled while in flight (its result is thrown away). */
  state: 'queued' | 'flight' | 'cancelled';
}

interface Slot {
  worker: WorkerLike;
  /** Request id → job, for the requests this worker is working on. */
  jobs: Map<number, Job>;
  dead: boolean;
}

/** The pool size from CHUNK_WORKERS: unset = min(2, cores − 1), 0 = generate on the main thread (the old path). */
export function chunkWorkerCount(env: string | undefined, cores = cpus().length): number {
  const n = Number(env);
  if (env !== undefined && env !== '' && Number.isFinite(n)) return Math.max(0, Math.min(16, Math.floor(n)));
  return Math.max(0, Math.min(2, cores - 1));
}

/**
 * The worker entry next to this module: genWorker.js in the bundle (dist-server/), genWorker.ts from source, which
 * needs tsx in the worker too (tests, `npm run server`).
 */
export function defaultSpawn(): WorkerLike {
  const here = import.meta.url;
  if (/\.ts$/.test(here)) return new Worker(new URL('./genWorker.ts', here), { execArgv: ['--import', 'tsx'] });
  return new Worker(new URL('./genWorker.js', here));
}

export class ChunkGenPool {
  readonly size: number;
  private readonly maxQueue: number;
  private readonly perWorker: number;
  private readonly spawnWorker: () => WorkerLike;
  private readonly slots: Slot[] = [];
  /** One FIFO per priority: insertion order of a Set is the request order. */
  private readonly buckets: Set<Job>[] = Array.from({ length: MAX_PRIORITY + 1 }, () => new Set<Job>());
  /** Every queued or in-flight job by world and chunk key (de-duplication, cancelling). */
  private readonly byClient = new Map<GenClient, Map<number, Job>>();
  private queued = 0;
  private nextId = 1;
  private respawns = 0;
  private closed = false;
  private readonly onError: (message: string) => void;
  private readonly stats = { generated: 0, dropped: 0, failed: 0, genMs: 0 };

  constructor(opts: ChunkGenPoolOptions) {
    this.size = Math.max(1, Math.floor(opts.size));
    this.maxQueue = Math.max(1, opts.maxQueue ?? 4096);
    this.perWorker = Math.max(1, opts.perWorker ?? 2);
    this.spawnWorker = opts.spawn ?? defaultSpawn;
    this.onError = opts.onError ?? (() => {});
    for (let i = 0; i < this.size; i++) this.slots.push(this.startSlot());
  }

  /** False once the pool is closed or its workers kept crashing: worlds then generate on the main thread. */
  get usable(): boolean {
    return !this.closed && this.slots.some((s) => !s.dead);
  }

  /**
   * Asks for a chunk. A chunk already queued for this world keeps one request (moved up when the new priority is
   * nearer); one already in flight is left alone. Returns false when the queue is full of nearer chunks: ask again later.
   */
  request(client: GenClient, cx: number, cz: number, key: number, priority: number): boolean {
    if (!this.usable) return false;
    const prio = Math.max(0, Math.min(MAX_PRIORITY, Math.floor(priority)));
    let jobs = this.byClient.get(client);
    const existing = jobs?.get(key);
    if (existing) {
      if (existing.state === 'queued' && prio < existing.prio) {
        this.buckets[existing.prio].delete(existing);
        existing.prio = prio;
        this.buckets[prio].add(existing);
      }
      return true;
    }
    if (this.queued >= this.maxQueue && !this.evictFartherThan(prio)) return false;
    if (!jobs) { jobs = new Map(); this.byClient.set(client, jobs); }
    const job: Job = { client, key, cx, cz, prio, state: 'queued' };
    jobs.set(key, job);
    this.buckets[prio].add(job);
    this.queued++;
    this.pump();
    return true;
  }

  /** Forgets a request (the players moved away). A result already being generated is thrown away. */
  cancel(client: GenClient, key: number): void {
    const jobs = this.byClient.get(client);
    const job = jobs?.get(key);
    if (!job || !jobs) return;
    jobs.delete(key);
    if (jobs.size === 0) this.byClient.delete(client);
    this.unqueue(job);
  }

  /** Forgets every request of a world (it unloaded or shut down). */
  cancelAll(client: GenClient): void {
    const jobs = this.byClient.get(client);
    if (!jobs) return;
    this.byClient.delete(client);
    for (const job of jobs.values()) this.unqueue(job);
  }

  /** Whether a world's chunk is queued or being generated. */
  pending(client: GenClient, key: number): boolean {
    return this.byClient.get(client)?.has(key) ?? false;
  }

  getStats(): ChunkGenStats {
    let inFlight = 0;
    for (const s of this.slots) inFlight += s.jobs.size;
    return { workers: this.slots.filter((s) => !s.dead).length, queued: this.queued, inFlight, ...this.stats };
  }

  /** Stops the workers; outstanding requests are dropped silently (the worlds are saving and closing). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const b of this.buckets) b.clear();
    this.byClient.clear();
    this.queued = 0;
    await Promise.all(this.slots.map((s) => {
      s.dead = true;
      s.jobs.clear();
      return s.worker.terminate().catch(() => 0);
    }));
  }

  // ---------------------------------------------------------------- internals

  private unqueue(job: Job): void {
    if (job.state === 'queued') {
      this.buckets[job.prio].delete(job);
      this.queued--;
    }
    job.state = 'cancelled';
  }

  /** Makes room for a job of priority `prio` by dropping the newest job of the farthest bucket beyond it. */
  private evictFartherThan(prio: number): boolean {
    for (let p = MAX_PRIORITY; p > prio; p--) {
      const b = this.buckets[p];
      if (b.size === 0) continue;
      let victim: Job | undefined;
      for (const j of b) victim = j; // newest = last inserted
      b.delete(victim!);
      this.queued--;
      victim!.state = 'cancelled';
      const jobs = this.byClient.get(victim!.client);
      jobs?.delete(victim!.key);
      if (jobs?.size === 0) this.byClient.delete(victim!.client);
      this.stats.dropped++;
      victim!.client.chunkDropped(victim!.cx, victim!.cz, victim!.key, false);
      return true;
    }
    return false;
  }

  private nextJob(): Job | null {
    for (const b of this.buckets) {
      if (b.size === 0) continue;
      const job = b.values().next().value!;
      b.delete(job);
      this.queued--;
      return job;
    }
    return null;
  }

  /** Hands queued jobs to free workers, nearest first, least busy worker first. */
  private pump(): void {
    while (this.queued > 0) {
      let best: Slot | null = null;
      for (const s of this.slots) if (!s.dead && s.jobs.size < this.perWorker && (!best || s.jobs.size < best.jobs.size)) best = s;
      if (!best) return;
      const job = this.nextJob()!;
      job.state = 'flight';
      const id = this.nextId++;
      best.jobs.set(id, job);
      if (best.jobs.size === 1) best.worker.ref();
      const spec = job.client.genSpec;
      best.worker.postMessage({ id, worldType: spec.worldType, seed: spec.seed, genVersion: spec.genVersion, cx: job.cx, cz: job.cz });
    }
  }

  private startSlot(): Slot {
    const worker = this.spawnWorker();
    const slot: Slot = { worker, jobs: new Map(), dead: false };
    // An idle worker must not keep the process alive; one with work does (see pump()).
    worker.unref();
    worker.on('message', (res) => this.onResult(slot, res));
    worker.on('error', (err) => this.onCrash(slot, err.stack ?? err.message));
    worker.on('exit', (code) => { if (!slot.dead) this.onCrash(slot, `worker exited with code ${code}`); });
    return slot;
  }

  private onResult(slot: Slot, res: GenResponse): void {
    const job = slot.jobs.get(res.id);
    if (!job) return;
    slot.jobs.delete(res.id);
    if (slot.jobs.size === 0) slot.worker.unref();
    this.stats.genMs += res.ms;
    if (job.state !== 'cancelled') {
      const jobs = this.byClient.get(job.client);
      jobs?.delete(job.key);
      if (jobs?.size === 0) this.byClient.delete(job.client);
      if (res.error || !res.blocks || !res.tops || !res.emitters) {
        this.stats.failed++;
        this.onError(`chunk ${job.cx},${job.cz} failed in a worker: ${res.error ?? 'empty result'}`);
        job.client.chunkDropped(job.cx, job.cz, job.key, true);
      } else {
        this.stats.generated++;
        job.client.chunkGenerated(job.cx, job.cz, job.key, { blocks: res.blocks, meta: res.meta ?? null, tops: res.tops, emitters: res.emitters });
      }
    }
    this.pump();
  }

  /** A worker died: its jobs go back to the front of their queue and a new worker takes its place (a few times). */
  private onCrash(slot: Slot, message: string): void {
    if (slot.dead || this.closed) return;
    slot.dead = true;
    this.onError(`chunk worker crashed: ${message}`);
    slot.worker.terminate().catch(() => 0);
    const orphans = [...slot.jobs.values()];
    slot.jobs.clear();
    const i = this.slots.indexOf(slot);
    if (this.respawns < MAX_RESPAWNS) {
      this.respawns++;
      this.slots[i] = this.startSlot();
    }
    for (const job of orphans) {
      if (job.state === 'cancelled') continue;
      if (this.usable) {
        job.state = 'queued';
        // Back in front: these were the nearest chunks when they were sent.
        const b = this.buckets[job.prio];
        const rest = [...b];
        b.clear();
        b.add(job);
        for (const j of rest) b.add(j);
        this.queued++;
      } else {
        const jobs = this.byClient.get(job.client);
        jobs?.delete(job.key);
        job.state = 'cancelled';
        job.client.chunkDropped(job.cx, job.cz, job.key, true);
      }
    }
    if (!this.usable) {
      // Given up: everything still waiting goes back to the worlds, which generate it themselves.
      for (const b of this.buckets) {
        for (const job of b) {
          this.byClient.get(job.client)?.delete(job.key);
          job.state = 'cancelled';
          job.client.chunkDropped(job.cx, job.cz, job.key, true);
        }
        b.clear();
      }
      this.queued = 0;
      return;
    }
    this.pump();
  }
}
