/**
 * Process-wide counters and gauges for /metrics (Prometheus text format) and the admin page.
 * Everything here is O(1) per event: counters are plain numbers, tick times go into a ring buffer.
 */
import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks';
import type { ChunkGenStats } from './chunkgen/ChunkGenPool';

const RING = 8192;
/** Event-loop delay sampling interval; the histogram includes it, so it is subtracted again. */
const LOOP_RESOLUTION_MS = 10;

export interface Gauges {
  players: number;
  roomsLoaded: number;
  roomsTotal: number;
  connections: number;
}

export class Metrics {
  readonly startedAt = Date.now();
  msgIn = 0;
  msgOut = 0;
  bytesIn = 0;
  bytesOut = 0;
  connectionsTotal = 0;
  connectionsRefused = 0;
  loginsFailed = 0;
  inventoryRejects = 0;
  readonly rateLimitHits = new Map<string, number>();
  /** Arcade anti-cheat: movement and shot violations by rule, kicks/bans it issued, suspicion warnings. */
  readonly cheatEvents = new Map<string, number>();
  cheatKicks = 0;
  cheatBans = 0;
  suspicionFlags = 0;
  private readonly ticks = new Float64Array(RING);
  private tickN = 0;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  /**
   * Event-loop lag (how late timers fire): the one number that shows an overloaded process, whatever the
   * cause (ticks of all games, message handling, GC, saves). Unref'd libuv timer, about 100 samples a second.
   */
  private readonly loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  /** Lag over the last rate window in ms: p50, p99, max. */
  loopLag = { p50: 0, p99: 0, max: 0 };
  /** Game ticks of the last rate window in ms (the ring above spans minutes on a quiet server). */
  tickWindow = { p50: 0, p99: 0, max: 0, count: 0 };
  private tickNAtRoll = 0;
  /** Garbage collection: pauses (count, total and longest in ms), all time and in the last rate window. */
  gcCount = 0;
  gcMs = 0;
  gcMaxMs = 0;
  gcWindowMaxMs = 0;
  private gcWindowAcc = 0;
  private gcObserver: PerformanceObserver | null = null;
  /** The chunk generation threads, when the server has them (set by App). */
  chunkGen: (() => ChunkGenStats) | null = null;

  constructor() {
    this.loop.enable();
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.gcCount++;
          this.gcMs += e.duration;
          if (e.duration > this.gcMaxMs) this.gcMaxMs = e.duration;
          if (e.duration > this.gcWindowAcc) this.gcWindowAcc = e.duration;
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch { /* GC entries unsupported: the gauges stay 0 */ }
  }
  /** Rate window for the per-second gauges. */
  private win = { at: Date.now(), msgIn: 0, msgOut: 0, bytesIn: 0, bytesOut: 0, msgInPs: 0, msgOutPs: 0, bytesInPs: 0, bytesOutPs: 0 };

  recvd(bytes: number): void { this.msgIn++; this.bytesIn += bytes; }
  sent(bytes: number, count = 1): void { this.msgOut += count; this.bytesOut += bytes; }
  rateLimited(kind: string): void { this.rateLimitHits.set(kind, (this.rateLimitHits.get(kind) ?? 0) + 1); }
  cheat(rule: string): void { this.cheatEvents.set(rule, (this.cheatEvents.get(rule) ?? 0) + 1); }
  tick(ms: number): void { this.ticks[this.tickN++ % RING] = ms; }

  /** Quantile (0..1) of recent tick durations in ms. */
  tickQuantile(q: number): number {
    const n = Math.min(this.tickN, RING);
    if (n === 0) return 0;
    const a = Array.from(this.ticks.subarray(0, n)).sort((x, y) => x - y);
    return a[Math.min(n - 1, Math.floor(q * n))];
  }

  /** Recomputes the per-second rates; call about every 5 s. */
  rollWindow(): void {
    const now = Date.now();
    const dt = Math.max(0.001, (now - this.win.at) / 1000);
    const w = this.win;
    w.msgInPs = (this.msgIn - w.msgIn) / dt;
    w.msgOutPs = (this.msgOut - w.msgOut) / dt;
    w.bytesInPs = (this.bytesIn - w.bytesIn) / dt;
    w.bytesOutPs = (this.bytesOut - w.bytesOut) / dt;
    w.msgIn = this.msgIn; w.msgOut = this.msgOut; w.bytesIn = this.bytesIn; w.bytesOut = this.bytesOut;
    w.at = now;
    const lag = (v: number) => Math.max(0, v / 1e6 - LOOP_RESOLUTION_MS);
    this.loopLag = this.loop.count > 0
      ? { p50: lag(this.loop.percentile(50)), p99: lag(this.loop.percentile(99)), max: lag(this.loop.max) }
      : { p50: 0, p99: 0, max: 0 };
    this.loop.reset();
    const n = Math.min(this.tickN - this.tickNAtRoll, RING);
    const recent: number[] = [];
    for (let i = this.tickN - n; i < this.tickN; i++) recent.push(this.ticks[i % RING]);
    recent.sort((x, y) => x - y);
    const at = (q: number) => (recent.length ? recent[Math.min(recent.length - 1, Math.floor(q * recent.length))] : 0);
    this.tickWindow = { p50: at(0.5), p99: at(0.99), max: recent.length ? recent[recent.length - 1] : 0, count: recent.length };
    this.tickNAtRoll = this.tickN;
    this.gcWindowMaxMs = this.gcWindowAcc;
    this.gcWindowAcc = 0;
  }

  /** CPU use of this process since the last call, 0..1 per core. */
  cpuFraction(): number {
    const now = Date.now();
    const u = process.cpuUsage(this.lastCpu);
    const dt = Math.max(1, now - this.lastCpuAt) * 1000; // microseconds
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    return (u.user + u.system) / dt;
  }

  snapshot(g: Gauges): Record<string, number> {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      players: g.players, roomsLoaded: g.roomsLoaded, roomsTotal: g.roomsTotal, connections: g.connections,
      rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
      cpu: Math.round(this.cpuFraction() * 1000) / 1000,
      tickP50Ms: this.tickQuantile(0.5), tickP99Ms: this.tickQuantile(0.99), tickMaxMs: this.tickQuantile(1),
      loopLagP50Ms: this.loopLag.p50, loopLagP99Ms: this.loopLag.p99, loopLagMaxMs: this.loopLag.max,
      gcPauses: this.gcCount, gcPauseMs: Math.round(this.gcMs), gcPauseMaxMs: Math.round(this.gcMaxMs * 10) / 10,
      msgInPerSec: this.win.msgInPs, msgOutPerSec: this.win.msgOutPs,
      bytesInPerSec: this.win.bytesInPs, bytesOutPerSec: this.win.bytesOutPs,
    };
  }

  /** Prometheus exposition format (text/plain; version=0.0.4). */
  prometheus(g: Gauges, version: string): string {
    const mem = process.memoryUsage();
    const out: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter' | 'summary', help: string, lines: string[]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines);
    };
    const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0');
    metric('bunkcraft_build_info', 'gauge', 'Server version.', [`bunkcraft_build_info{version="${version.replace(/[^\w.+-]/g, '')}"} 1`]);
    metric('bunkcraft_uptime_seconds', 'gauge', 'Seconds since the server started.', [`bunkcraft_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`]);
    metric('bunkcraft_players', 'gauge', 'Players currently in a game.', [`bunkcraft_players ${g.players}`]);
    metric('bunkcraft_rooms_loaded', 'gauge', 'Games loaded in memory.', [`bunkcraft_rooms_loaded ${g.roomsLoaded}`]);
    metric('bunkcraft_rooms_total', 'gauge', 'Games stored on disk.', [`bunkcraft_rooms_total ${g.roomsTotal}`]);
    metric('bunkcraft_connections', 'gauge', 'Open WebSocket connections.', [`bunkcraft_connections ${g.connections}`]);
    metric('bunkcraft_tick_duration_seconds', 'summary', 'Duration of a game tick (all games), recent window.', [
      `bunkcraft_tick_duration_seconds{quantile="0.5"} ${num(this.tickQuantile(0.5) / 1000)}`,
      `bunkcraft_tick_duration_seconds{quantile="0.99"} ${num(this.tickQuantile(0.99) / 1000)}`,
      `bunkcraft_tick_duration_seconds{quantile="1"} ${num(this.tickQuantile(1) / 1000)}`,
      `bunkcraft_tick_duration_seconds_count ${this.tickN}`,
    ]);
    metric('bunkcraft_tick_window_seconds', 'gauge', 'Duration of the game ticks (all games) in the last rate window (about 5 s).', [
      `bunkcraft_tick_window_seconds{quantile="0.5"} ${num(this.tickWindow.p50 / 1000)}`,
      `bunkcraft_tick_window_seconds{quantile="0.99"} ${num(this.tickWindow.p99 / 1000)}`,
      `bunkcraft_tick_window_seconds{quantile="1"} ${num(this.tickWindow.max / 1000)}`,
      `bunkcraft_tick_window_seconds_count ${this.tickWindow.count}`,
    ]);
    metric('bunkcraft_event_loop_lag_seconds', 'gauge', 'How late the event loop runs timers, last rate window (about 5 s).', [
      `bunkcraft_event_loop_lag_seconds{quantile="0.5"} ${num(this.loopLag.p50 / 1000)}`,
      `bunkcraft_event_loop_lag_seconds{quantile="0.99"} ${num(this.loopLag.p99 / 1000)}`,
      `bunkcraft_event_loop_lag_seconds{quantile="1"} ${num(this.loopLag.max / 1000)}`,
    ]);
    metric('bunkcraft_gc_pauses_total', 'counter', 'Garbage collection pauses.', [`bunkcraft_gc_pauses_total ${this.gcCount}`]);
    metric('bunkcraft_gc_pause_seconds_total', 'counter', 'Time spent in garbage collection pauses.', [`bunkcraft_gc_pause_seconds_total ${num(this.gcMs / 1000)}`]);
    metric('bunkcraft_gc_pause_max_seconds', 'gauge', 'Longest garbage collection pause in the last rate window (about 5 s).', [`bunkcraft_gc_pause_max_seconds ${num(this.gcWindowMaxMs / 1000)}`]);
    metric('process_resident_memory_bytes', 'gauge', 'Resident memory.', [`process_resident_memory_bytes ${mem.rss}`]);
    metric('process_heap_used_bytes', 'gauge', 'V8 heap in use.', [`process_heap_used_bytes ${mem.heapUsed}`]);
    const cpu = process.cpuUsage();
    metric('process_cpu_seconds_total', 'counter', 'CPU time used.', [`process_cpu_seconds_total ${num((cpu.user + cpu.system) / 1e6)}`]);
    // The main thread alone (game ticks and messages; GC helpers and I/O threads are not in it): the number that
    // runs out first, since one server process does all its game work on one core. Node 22.19+/23.9+.
    const threadCpu = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
    if (threadCpu) {
      const main = threadCpu.call(process);
      metric('process_main_thread_cpu_seconds_total', 'counter', 'CPU time of the main (event loop) thread.', [`process_main_thread_cpu_seconds_total ${num((main.user + main.system) / 1e6)}`]);
    }
    const gen = this.chunkGen?.();
    if (gen) {
      metric('bunkcraft_chunkgen_workers', 'gauge', 'Chunk generation threads running.', [`bunkcraft_chunkgen_workers ${gen.workers}`]);
      metric('bunkcraft_chunkgen_queue', 'gauge', 'Chunks waiting for a generation thread / being generated.', [
        `bunkcraft_chunkgen_queue{state="queued"} ${gen.queued}`, `bunkcraft_chunkgen_queue{state="in_flight"} ${gen.inFlight}`]);
      metric('bunkcraft_chunkgen_chunks_total', 'counter', 'Chunks generated by the threads, dropped from a full queue, or failed.', [
        `bunkcraft_chunkgen_chunks_total{result="generated"} ${gen.generated}`, `bunkcraft_chunkgen_chunks_total{result="dropped"} ${gen.dropped}`,
        `bunkcraft_chunkgen_chunks_total{result="failed"} ${gen.failed}`]);
      metric('bunkcraft_chunkgen_seconds_total', 'counter', 'Time the generation threads spent generating.', [`bunkcraft_chunkgen_seconds_total ${num(gen.genMs / 1000)}`]);
    }
    metric('bunkcraft_ws_messages_received_total', 'counter', 'WebSocket messages received.', [`bunkcraft_ws_messages_received_total ${this.msgIn}`]);
    metric('bunkcraft_ws_messages_sent_total', 'counter', 'WebSocket messages sent.', [`bunkcraft_ws_messages_sent_total ${this.msgOut}`]);
    metric('bunkcraft_ws_bytes_received_total', 'counter', 'Bytes received over WebSockets.', [`bunkcraft_ws_bytes_received_total ${this.bytesIn}`]);
    metric('bunkcraft_ws_bytes_sent_total', 'counter', 'Bytes sent over WebSockets.', [`bunkcraft_ws_bytes_sent_total ${this.bytesOut}`]);
    metric('bunkcraft_ws_messages_per_second', 'gauge', 'Messages per second over the last window.', [
      `bunkcraft_ws_messages_per_second{direction="in"} ${num(this.win.msgInPs)}`, `bunkcraft_ws_messages_per_second{direction="out"} ${num(this.win.msgOutPs)}`]);
    metric('bunkcraft_ws_bytes_per_second', 'gauge', 'Bytes per second over the last window.', [
      `bunkcraft_ws_bytes_per_second{direction="in"} ${num(this.win.bytesInPs)}`, `bunkcraft_ws_bytes_per_second{direction="out"} ${num(this.win.bytesOutPs)}`]);
    metric('bunkcraft_rate_limit_hits_total', 'counter', 'Requests refused by a rate limit, by kind.',
      [...this.rateLimitHits].map(([k, v]) => `bunkcraft_rate_limit_hits_total{kind="${k.replace(/[^\w]/g, '_')}"} ${v}`));
    metric('bunkcraft_connections_total', 'counter', 'WebSocket connections accepted.', [`bunkcraft_connections_total ${this.connectionsTotal}`]);
    metric('bunkcraft_connections_refused_total', 'counter', 'WebSocket connections refused (limits, origin, bans).', [`bunkcraft_connections_refused_total ${this.connectionsRefused}`]);
    metric('bunkcraft_logins_failed_total', 'counter', 'Failed logins (password, ban, whitelist, identity).', [`bunkcraft_logins_failed_total ${this.loginsFailed}`]);
    metric('bunkcraft_inventory_rejects_total', 'counter', 'Inventory updates rolled back by the server.', [`bunkcraft_inventory_rejects_total ${this.inventoryRejects}`]);
    metric('bunkcraft_cheat_events_total', 'counter', 'Arcade anti-cheat violations (corrected), by rule.',
      [...this.cheatEvents].map(([k, v]) => `bunkcraft_cheat_events_total{rule="${k.replace(/[^\w-]/g, '_')}"} ${v}`));
    metric('bunkcraft_cheat_kicks_total', 'counter', 'Players kicked by the arcade anti-cheat.', [`bunkcraft_cheat_kicks_total ${this.cheatKicks}`]);
    metric('bunkcraft_cheat_bans_total', 'counter', 'Players banned by the arcade anti-cheat.', [`bunkcraft_cheat_bans_total ${this.cheatBans}`]);
    metric('bunkcraft_suspicion_flags_total', 'counter', 'Aim anomaly warnings (suspicion score over the threshold).', [`bunkcraft_suspicion_flags_total ${this.suspicionFlags}`]);
    return `${out.join('\n')}\n`;
  }
}

export const metrics = new Metrics();
