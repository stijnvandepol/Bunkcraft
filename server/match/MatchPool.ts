import { randomBytes } from 'node:crypto';
import { log } from '../Log';
import type { MatchDriver, RunnerHandle, RunnerStats } from './Drivers';
import { type RunnerStatus, runnerKey } from './Internal';

/**
 * Match runners and their life:
 *
 *   starting ──ready──▶ idle (warm) ──lease──▶ assigned ──release──▶ stopping ──▶ gone
 *       │                                         │
 *       └── no `ready` in time ──▶ gone           └── no heartbeat in time ──▶ dead (onDead) ──▶ gone
 *
 * A lease takes a warm runner at once, or starts one (the caller waits for its `ready`), or answers null when
 * MAX_MATCH_CONTAINERS runners exist. The pool keeps MATCH_WARM_POOL runners idle so quick play never waits for a
 * container start. Runners found running after a control plane restart are adopted as `assigned` (they still have
 * their lobby) or stopped (warm ones may run an older image).
 */

export type RunnerState = 'starting' | 'idle' | 'assigned' | 'stopping';

export interface Runner {
  id: string;
  key: string;
  state: RunnerState;
  handle: RunnerHandle | null;
  url: string;
  version: string;
  /** The lobby it runs (assigned). */
  room: string | null;
  /** Started for a lease (not for the warm pool). */
  leased: boolean;
  /** Found running at start-up: started by an earlier control plane (maybe an older image). */
  adopted: boolean;
  startedAt: number;
  readyAt: number;
  lastBeat: number;
  status: RunnerStatus | null;
  stats: RunnerStats | null;
  ready: Promise<Runner>;
  resolve(r: Runner): void;
  reject(e: Error): void;
}

export interface PoolOptions {
  driver: MatchDriver;
  secret: Buffer | string;
  warm: number;
  max: number;
  /** A starting runner must report `ready` within this (ms). */
  startTimeoutMs?: number;
  /** An assigned runner without a heartbeat for this long is dead (ms). */
  beatTimeoutMs?: number;
  now?: () => number;
  /** An assigned runner died (no heartbeat, or its process/container ended): its lobby is gone. */
  onDead?(r: Runner): void;
}

export interface PoolCounters {
  starts: number;
  startFailures: number;
  deaths: number;
  /** Lease asked but the cap was reached. */
  capped: number;
  /** Start-up times of the last runners (ms), newest last. */
  startMs: number[];
}

export class MatchPool {
  readonly runners = new Map<string, Runner>();
  readonly counters: PoolCounters = { starts: 0, startFailures: 0, deaths: 0, capped: 0, startMs: [] };
  private closed = false;
  private readonly now: () => number;
  /** Failed starts in a row, and no new warm start before `retryAt` (a broken image or proxy must not spin). */
  private failStreak = 0;
  private retryAt = 0;

  constructor(private readonly o: PoolOptions) {
    this.now = o.now ?? Date.now;
  }

  get driver(): MatchDriver {
    return this.o.driver;
  }

  count(state?: RunnerState): number {
    if (!state) return this.runners.size;
    let n = 0;
    for (const r of this.runners.values()) if (r.state === state) n++;
    return n;
  }

  /** Warm runners: idle ones plus the ones starting for the pool (not for a lease). */
  private warmCount(): number {
    let n = 0;
    for (const r of this.runners.values()) if (r.state === 'idle' || (r.state === 'starting' && !r.leased)) n++;
    return n;
  }

  ensureWarm(): void {
    if (this.closed || this.now() < this.retryAt) return;
    while (this.warmCount() < this.o.warm && this.runners.size < this.o.max) this.start(false);
  }

  private newRunner(id: string, leased: boolean): Runner {
    let resolve!: (r: Runner) => void;
    let reject!: (e: Error) => void;
    const ready = new Promise<Runner>((res, rej) => { resolve = res; reject = rej; });
    // Nobody may be waiting (a warm runner): never an unhandled rejection.
    ready.catch(() => undefined);
    return {
      id, key: runnerKey(this.o.secret, id), state: 'starting', handle: null, url: '', version: '', room: null, leased, adopted: false,
      startedAt: this.now(), readyAt: 0, lastBeat: 0, status: null, stats: null, ready, resolve, reject,
    };
  }

  private start(leased: boolean): Runner {
    const r = this.newRunner(randomBytes(8).toString('hex'), leased);
    this.runners.set(r.id, r);
    this.counters.starts++;
    this.o.driver.start(r.id, r.key).then((h) => {
      r.handle = h;
      r.version = h.version ?? '';
      // Gone in the meantime (pool closed, timed out): it must not linger.
      if (!this.runners.has(r.id)) void this.o.driver.stop(h).catch(() => undefined);
    }, (e: unknown) => this.fail(r, e instanceof Error ? e : new Error(String(e))));
    return r;
  }

  private fail(r: Runner, e: Error): void {
    if (this.runners.get(r.id) !== r) return;
    this.counters.startFailures++;
    this.failStreak++;
    this.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(6, this.failStreak - 1));
    log.error('match runner failed to start', { runner: r.id, error: e.message, retryInMs: this.retryAt - this.now() });
    this.runners.delete(r.id);
    r.reject(e);
    if (r.handle) void this.o.driver.stop(r.handle).catch(() => undefined);
  }

  /**
   * A runner for a new lobby: a warm one at once, or a new one (resolves when it is ready). Null when the cap is
   * reached: the caller runs the lobby another way (in-process).
   */
  lease(): Promise<Runner> | null {
    if (this.closed) return null;
    for (const r of this.runners.values()) {
      if (r.state === 'idle') {
        r.state = 'assigned';
        this.ensureWarm();
        return Promise.resolve(r);
      }
    }
    // A warm runner still starting: take it over (it is the quickest one there is).
    for (const r of this.runners.values()) {
      if (r.state === 'starting' && !r.leased) {
        r.leased = true;
        this.ensureWarm();
        return r.ready.then((x) => { x.state = 'assigned'; return x; });
      }
    }
    if (this.runners.size >= this.o.max) {
      this.counters.capped++;
      return null;
    }
    const r = this.start(true);
    return r.ready.then((x) => { x.state = 'assigned'; return x; });
  }

  /** The runner says it listens on `port`. */
  ready(id: string, port: number, version: string): Runner | null {
    const r = this.runners.get(id);
    if (!r || r.state !== 'starting') return null;
    r.readyAt = this.now();
    r.lastBeat = r.readyAt;
    if (version) r.version = version;
    r.url = this.o.driver.urlFor(r.handle ?? { id, ref: '' }, port);
    this.counters.startMs.push(r.readyAt - r.startedAt);
    if (this.counters.startMs.length > 20) this.counters.startMs.shift();
    r.state = r.leased ? 'assigned' : 'idle';
    this.failStreak = 0;
    this.retryAt = 0;
    log.info('match runner ready', { runner: id, ms: r.readyAt - r.startedAt, warm: !r.leased });
    r.resolve(r);
    return r;
  }

  beat(id: string, status: RunnerStatus): Runner | null {
    const r = this.runners.get(id);
    if (!r) return null;
    r.lastBeat = this.now();
    r.status = status;
    return r;
  }

  /** A runner found running at start-up (see ControlPlane.adopt). */
  adopt(h: RunnerHandle, url: string, status: RunnerStatus): Runner {
    const r = this.newRunner(h.id, true);
    r.handle = h;
    r.url = url;
    r.version = h.version ?? status.version;
    r.state = 'assigned';
    r.adopted = true;
    r.room = status.room;
    r.status = status;
    r.readyAt = r.lastBeat = this.now();
    this.runners.set(r.id, r);
    r.resolve(r);
    return r;
  }

  /** Stops a runner (its lobby is over, or it is not needed) and refills the warm pool. */
  async release(id: string, why: string): Promise<void> {
    const r = this.runners.get(id);
    if (!r || r.state === 'stopping') return;
    r.state = 'stopping';
    log.info('match runner released', { runner: id, room: r.room, why });
    try {
      if (r.handle) await this.o.driver.stop(r.handle);
    } catch (e) {
      log.warn('match runner stop failed', { runner: id, error: String(e) });
    } finally {
      this.runners.delete(id);
      this.ensureWarm();
    }
  }

  /** Start and heartbeat timeouts (call every few seconds). */
  sweep(): void {
    const now = this.now();
    const startTimeout = this.o.startTimeoutMs ?? 30_000;
    const beatTimeout = this.o.beatTimeoutMs ?? 15_000;
    for (const r of [...this.runners.values()]) {
      if (r.state === 'starting' && now - r.startedAt > startTimeout) {
        this.fail(r, new Error('no ready in time'));
      } else if ((r.state === 'assigned' || r.state === 'idle') && r.lastBeat > 0 && now - r.lastBeat > beatTimeout) {
        this.counters.deaths++;
        log.error('match runner lost (no heartbeat)', { runner: r.id, room: r.room });
        this.o.onDead?.(r);
        void this.release(r.id, 'no heartbeat');
      }
    }
    this.ensureWarm();
  }

  /** Docker stats of every assigned runner (the process driver has none: heartbeats carry CPU and memory). */
  async pollStats(): Promise<void> {
    await Promise.all([...this.runners.values()].filter((r) => r.state === 'assigned' && r.handle).map(async (r) => {
      r.stats = await this.o.driver.stats(r.handle!).catch(() => null);
    }));
  }

  /**
   * The control plane stops (an update): warm runners go (the next control plane starts its own, maybe on a newer
   * image); assigned ones keep their lobby and are adopted by the next control plane.
   */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runners.values()].filter((r) => r.state !== 'assigned').map((r) => this.release(r.id, 'control plane stops')));
  }
}
