/**
 * Mergeable statistics for the load test: fixed-bucket latency histograms and plain counters, so the bot
 * processes can send their numbers to the orchestrator as JSON and it can add them up.
 */

/** Bucket width in ms; everything above MAX_MS lands in the last bucket. */
const BUCKET_MS = 0.5;
const MAX_MS = 10_000;
const BUCKETS = Math.ceil(MAX_MS / BUCKET_MS) + 1;

export class Hist {
  counts = new Uint32Array(BUCKETS);
  n = 0;
  sum = 0;
  max = 0;

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.counts[Math.min(BUCKETS - 1, Math.floor(ms / BUCKET_MS))]++;
    this.n++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  merge(o: HistJson): void {
    for (const [i, c] of o.b) this.counts[i] += c;
    this.n += o.n;
    this.sum += o.sum;
    if (o.max > this.max) this.max = o.max;
  }

  /** Upper edge of the bucket holding quantile q (0..1). */
  q(q: number): number {
    if (this.n === 0) return 0;
    const want = Math.max(1, Math.ceil(q * this.n));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i];
      if (seen >= want) return Math.min(this.max, (i + 1) * BUCKET_MS);
    }
    return this.max;
  }

  get mean(): number {
    return this.n ? this.sum / this.n : 0;
  }

  /** Sparse form: only non-empty buckets. */
  toJSON(): HistJson {
    const b: [number, number][] = [];
    for (let i = 0; i < BUCKETS; i++) if (this.counts[i]) b.push([i, this.counts[i]]);
    return { b, n: this.n, sum: this.sum, max: this.max };
  }

  reset(): void {
    this.counts.fill(0);
    this.n = 0;
    this.sum = 0;
    this.max = 0;
  }
}

export interface HistJson { b: [number, number][]; n: number; sum: number; max: number }

/** Latency kinds every bot process measures (ms). */
export const LATENCIES = [
  /** WebSocket ping → pong (answered by the server's event loop). */
  'rtt',
  /** Own chat message → its broadcast back. */
  'chat',
  /** take request → taken. */
  'take',
  /** fire request → own shot broadcast (arcade). */
  'fire',
  /** Block edit by one bot → the broadcast arriving at another bot of the same room. */
  'edit',
  /** Time between two consecutive snap frames at one bot (ideal: 50 ms). */
  'snapGap',
] as const;
export type Latency = typeof LATENCIES[number];

export const COUNTERS = [
  'msgIn', 'bytesIn', 'msgOut', 'bytesOut', 'binIn',
  'joined', 'connectFail', 'kicked', 'closedUnexpected', 'wsError',
  'reject', 'stateCorrection', 'teleport', 'hurt',
  'blocksBroken', 'blocksPlaced', 'drops', 'takes', 'taken', 'attacks', 'chats',
  'fires', 'shots', 'hits', 'kills', 'reloads',
  'entFrames', 'mobsSeen', 'itemsSeen',
] as const;
export type Counter = typeof COUNTERS[number];

export interface StatsJson {
  hist: Record<Latency, HistJson>;
  count: Record<Counter, number>;
  /** Event-loop lag of the bot process itself (ms), to tell a slow server from a slow load generator. */
  loopP99: number;
  loopMax: number;
}

export class Stats {
  readonly hist = Object.fromEntries(LATENCIES.map((k) => [k, new Hist()])) as Record<Latency, Hist>;
  readonly count = Object.fromEntries(COUNTERS.map((k) => [k, 0])) as Record<Counter, number>;

  inc(k: Counter, by = 1): void {
    this.count[k] += by;
  }

  reset(): void {
    for (const h of Object.values(this.hist)) h.reset();
    for (const k of COUNTERS) this.count[k] = 0;
  }

  toJSON(loopP99: number, loopMax: number): StatsJson {
    return {
      hist: Object.fromEntries(LATENCIES.map((k) => [k, this.hist[k].toJSON()])) as Record<Latency, HistJson>,
      count: { ...this.count }, loopP99, loopMax,
    };
  }

  merge(o: StatsJson): void {
    for (const k of LATENCIES) this.hist[k].merge(o.hist[k]);
    for (const k of COUNTERS) this.count[k] += o.count[k] ?? 0;
  }
}
