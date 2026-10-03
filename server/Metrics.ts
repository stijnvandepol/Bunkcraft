/**
 * Process-wide counters and gauges for /metrics (Prometheus text format) and the admin page.
 * Everything here is O(1) per event: counters are plain numbers, tick times go into a ring buffer.
 */
const RING = 2048;

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
      tickP50Ms: this.tickQuantile(0.5), tickP99Ms: this.tickQuantile(0.99),
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
      `bunkcraft_tick_duration_seconds_count ${this.tickN}`,
    ]);
    metric('process_resident_memory_bytes', 'gauge', 'Resident memory.', [`process_resident_memory_bytes ${mem.rss}`]);
    metric('process_heap_used_bytes', 'gauge', 'V8 heap in use.', [`process_heap_used_bytes ${mem.heapUsed}`]);
    const cpu = process.cpuUsage();
    metric('process_cpu_seconds_total', 'counter', 'CPU time used.', [`process_cpu_seconds_total ${num((cpu.user + cpu.system) / 1e6)}`]);
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
