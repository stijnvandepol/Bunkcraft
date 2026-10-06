/**
 * Load test of the game server: starts the server (production-like, temp DATA_DIR) for every step,
 * creates the rooms, lets bot processes (worker.ts) join and play, and measures the server from the outside.
 *
 *   npx tsx scripts/load/run.ts                                   # the standard steps (see DEFAULT_STEPS)
 *   npx tsx scripts/load/run.ts --steps survival:50,arena:20 --measure 60 --profile --out /tmp/load.json
 *
 * Options: --steps kind:rooms[,…] (kind = survival | arena), --bots per room (8), --warmup s (20),
 * --measure s (45), --profile (node --cpu-prof on the server; .cpuprofile files land in --prof-dir),
 * --workers n (bot processes; default one per 100 bots, max 6), --port (3199), --out results.json,
 * --entry bundle|tsx (default bundle: run `npm run build:server` first), --node-flags "...".
 *
 * Per step: server tick time p50/p99/max (/metrics), event-loop lag p50/p99/max (/metrics, monitorEventLoopDelay),
 * CPU % of one core, RSS, outgoing bytes/s, bot-side latencies (ping, chat echo, take, fire, edit propagation,
 * snap gaps), errors and disconnects, and the event-loop lag of the bot processes (to rule out the load generator).
 */
import { type ChildProcess, fork, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_IDS } from '../../src/modes/maps';
import type { RoomSpec } from './bots';
import { type Latency, LATENCIES, Stats, type StatsJson } from './stats';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i++; } else args.set(a.slice(2), '1');
}
const DEFAULT_STEPS = 'survival:1,survival:10,survival:25,survival:50,arena:20';
// kind:rooms or kind:roomsxbots (bots per room), kind = survival | arena (FFA/TDM alternating) | tdm | ffa.
const steps = (args.get('steps') ?? DEFAULT_STEPS).split(',').map((s) => {
  const [kind, n] = s.split(':');
  const [rooms, bots] = n.split('x');
  if (!['survival', 'arena', 'tdm', 'ffa'].includes(kind)) throw new Error(`bad step ${s}`);
  return { kind: kind as StepKind, rooms: Number(rooms), bots: bots ? Number(bots) : undefined };
});
type StepKind = 'survival' | 'arena' | 'tdm' | 'ffa';
const BOTS = Number(args.get('bots') ?? 8);
const WARMUP = Number(args.get('warmup') ?? 20);
const MEASURE = Number(args.get('measure') ?? 45);
const PROFILE = args.has('profile');
const PROF_DIR = resolve(args.get('prof-dir') ?? join(tmpdir(), 'bunk-load-prof'));
const PORT = Number(args.get('port') ?? 3199);
const OUT = args.get('out');
const BASE = `http://127.0.0.1:${PORT}`;
/** Run the server from another checkout (before/after comparisons); default this repository. */
const SERVER_DIR = resolve(args.get('server-dir') ?? root);
/** How the server runs: `tsx` (TypeScript at runtime, the old production start) or `bundle` (dist-server/index.js, `npm run build:server`). */
const ENTRY = args.get('entry') ?? 'bundle';
/** Extra node flags for the server, e.g. --node-flags "--max-old-space-size=256 --max-semi-space-size=16". */
const NODE_FLAGS = (args.get('node-flags') ?? '').split(/\s+/).filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseProm(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return out;
}

async function metrics(): Promise<Map<string, number>> {
  return parseProm(await (await fetch(`${BASE}/metrics`)).text());
}

async function startServer(dataDir: string, label: string): Promise<{ proc: ChildProcess; logFile: string; startMs: number }> {
  const logFile = join(dataDir, 'server.log');
  const nodeArgs = [...NODE_FLAGS, ...(ENTRY === 'tsx' ? ['--import', 'tsx'] : [])];
  if (PROFILE) {
    mkdirSync(PROF_DIR, { recursive: true });
    nodeArgs.push('--cpu-prof', '--cpu-prof-dir', PROF_DIR, '--cpu-prof-name', `${label}.cpuprofile`);
  }
  const t0 = performance.now();
  const proc = spawn(process.execPath, [...nodeArgs, ENTRY === 'tsx' ? 'server/index.ts' : 'dist-server/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: join(dataDir, 'data'), STATIC_DIR: join(dataDir, 'nostatic'),
      ROOM_CREATE_LIMIT: '10000', MAX_ROOMS: '10000', MAX_CONNECTIONS: '20000', MAX_CONN_PER_IP: '50',
      // Every bot sends its own X-Forwarded-For, so the per-address limits behave like with real households.
      TRUST_PROXY: '1', MAIN_WORLD: 'off', BACKUP_KEEP: '0', LOG_LEVEL: 'warn', LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(logFile);
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  for (let i = 0; i < 1000; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return { proc, logFile, startMs: performance.now() - t0 };
    } catch { /* not up yet */ }
    await sleep(20);
  }
  throw new Error('server did not start');
}

async function createRoom(kind: StepKind, i: number): Promise<RoomSpec> {
  const gameType = kind === 'tdm' || kind === 'ffa' ? kind : i % 2 ? 'ffa' : 'tdm';
  const body = kind !== 'survival'
    ? { name: `Load arena ${i}`, gameType, mapId: MAP_IDS[i % MAP_IDS.length], scoreLimit: 100, timeLimitSec: 1800 }
    : { name: `Load ${i}`, gameMode: 'survival', seed: `load-${i}` };
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.250.0.${(i % 250) + 1}` }, body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`room create failed: ${res.status} ${await res.text()}`);
  const { code, ownerToken } = (await res.json()) as { code: string; ownerToken: string };
  return { code, ownerToken, kind: kind === 'survival' ? 'survival' : 'arena' };
}

interface Sample { t: number; tickP50: number; tickP99: number; tickMax: number; lagP50: number; lagP99: number; lagMax: number; rss: number; gcMax: number }

function sampleOf(m: Map<string, number>): Sample {
  return {
    t: performance.now(),
    tickP50: (m.get('bunkcraft_tick_window_seconds{quantile="0.5"}') ?? 0) * 1000,
    tickP99: (m.get('bunkcraft_tick_window_seconds{quantile="0.99"}') ?? 0) * 1000,
    tickMax: (m.get('bunkcraft_tick_window_seconds{quantile="1"}') ?? 0) * 1000,
    lagP50: (m.get('bunkcraft_event_loop_lag_seconds{quantile="0.5"}') ?? 0) * 1000,
    lagP99: (m.get('bunkcraft_event_loop_lag_seconds{quantile="0.99"}') ?? 0) * 1000,
    lagMax: (m.get('bunkcraft_event_loop_lag_seconds{quantile="1"}') ?? 0) * 1000,
    rss: m.get('process_resident_memory_bytes') ?? 0,
    gcMax: (m.get('bunkcraft_gc_pause_max_seconds') ?? 0) * 1000,
  };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

export interface StepResult {
  step: string; rooms: number; players: number; joined: number; workers: number;
  tick: { p50: number; p99: number; max: number };
  loopLag: { p50: number; p99: number; max: number };
  cpuPct: number;
  /** Main-thread CPU (process.threadCpuUsage): the share of the one core the game loop can use; unaffected by waiting for the CPU. */
  mainCpuPct: number;
  rssMB: number; rssPerRoomMB: number; heapMB: number; startMs: number;
  /** GC pauses per second, ms of GC per second, longest pause (ms). */
  gc: { perSec: number; msPerSec: number; max: number }; outKBps: number; inKBps: number; outKBpsPerPlayer: number;
  msgOutPs: number; msgInPs: number;
  latency: Record<Latency, { n: number; p50: number; p99: number; max: number }>;
  counts: StatsJson['count'];
  botLoopP99: number; botLoopMax: number;
  serverWarnings: Record<string, number>;
  /** Machine load average (1 min) at the start and end of the window: other work on the machine skews latencies. */
  machineLoad: [number, number];
  profile?: string;
}

async function runStep(kind: StepKind, roomCount: number, BOTS: number): Promise<StepResult> {
  const label = `${kind}-${roomCount}x${BOTS}`;
  const dir = mkdtempSync(join(tmpdir(), 'bunk-load-'));
  console.log(`\n=== ${label}: starting server (data ${dir})`);
  const { proc, logFile, startMs } = await startServer(dir, label);
  const exited = new Promise<void>((r) => proc.on('exit', () => r()));
  try {
    const rooms: RoomSpec[] = [];
    for (let i = 0; i < roomCount; i++) rooms.push(await createRoom(kind, i));
    const players = roomCount * BOTS;
    const workerCount = Number(args.get('workers') ?? Math.min(6, Math.max(1, Math.ceil(players / 100))));
    const workers: ChildProcess[] = [];
    const reports: StatsJson[] = [];
    let joined = 0, failed = 0, joinedWorkers = 0;
    const allJoined = new Promise<void>((done) => {
      for (let w = 0; w < workerCount; w++) {
        const child = fork(join(here, 'worker.ts'), [], { execArgv: ['--import', 'tsx'], cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.on('message', (m: { ev: string; joined?: number; failed?: number; stats?: StatsJson }) => {
          if (m.ev === 'joined') {
            joined += m.joined!; failed += m.failed!;
            if (++joinedWorkers === workerCount) done();
          } else if (m.ev === 'report') reports.push(m.stats!);
        });
        workers.push(child);
      }
    });
    const t0 = performance.now();
    workers.forEach((child, w) => {
      const mine = rooms.map((spec, index) => ({ spec, bots: BOTS, index })).filter((_, index) => index % workerCount === w);
      // Join over about 10 s in total (players do not arrive in the same millisecond).
      child.send({ cmd: 'start', base: BASE, rooms: mine, joinSpacingMs: Math.max(2, Math.min(100, (10_000 * workerCount) / players)) });
    });
    await allJoined;
    console.log(`joined ${joined}/${players} (${failed} failed) in ${((performance.now() - t0) / 1000).toFixed(1)} s with ${workerCount} bot processes; warm-up ${WARMUP} s`);
    await sleep(WARMUP * 1000);

    const load0 = loadavg()[0];
    const m0 = await metrics();
    const w0 = performance.now();
    workers.forEach((c) => c.send({ cmd: 'reset' }));
    const samples: Sample[] = [];
    const end = w0 + MEASURE * 1000;
    while (performance.now() < end) {
      await sleep(Math.min(5000, end - performance.now()));
      const s = sampleOf(await metrics());
      samples.push(s);
      process.stdout.write(`  t+${((s.t - w0) / 1000).toFixed(0)}s tick p50 ${s.tickP50.toFixed(2)} p99 ${s.tickP99.toFixed(2)} max ${s.tickMax.toFixed(1)} ms | lag p99 ${s.lagP99.toFixed(1)} max ${s.lagMax.toFixed(1)} ms | rss ${(s.rss / 1048576).toFixed(0)} MB\n`);
    }
    const m1 = await metrics();
    const w1 = performance.now();
    workers.forEach((c) => c.send({ cmd: 'report' }));
    for (let i = 0; i < 100 && reports.length < workerCount; i++) await sleep(50);
    workers.forEach((c) => c.send({ cmd: 'stop' }));

    const secs = (w1 - w0) / 1000;
    const d = (k: string) => (m1.get(k) ?? 0) - (m0.get(k) ?? 0);
    const merged = new Stats();
    for (const r of reports) merged.merge(r);
    const latency = Object.fromEntries(LATENCIES.map((k) => {
      const h = merged.hist[k];
      return [k, { n: h.n, p50: round(h.q(0.5)), p99: round(h.q(0.99)), max: round(h.max) }];
    })) as StepResult['latency'];
    const rss = maxOf(samples.map((s) => s.rss)) / 1048576;
    const result: StepResult = {
      step: label, rooms: roomCount, players, joined, workers: workerCount,
      tick: { p50: round(median(samples.map((s) => s.tickP50))), p99: round(maxOf(samples.map((s) => s.tickP99))), max: round(maxOf(samples.map((s) => s.tickMax))) },
      loopLag: { p50: round(median(samples.map((s) => s.lagP50))), p99: round(maxOf(samples.map((s) => s.lagP99))), max: round(maxOf(samples.map((s) => s.lagMax))) },
      cpuPct: round((d('process_cpu_seconds_total') / secs) * 100),
      mainCpuPct: round((d('process_main_thread_cpu_seconds_total') / secs) * 100),
      rssMB: round(rss), rssPerRoomMB: round(rss / roomCount), heapMB: round((m1.get('process_heap_used_bytes') ?? 0) / 1048576), startMs: round(startMs),
      gc: { perSec: round(d('bunkcraft_gc_pauses_total') / secs), msPerSec: round((d('bunkcraft_gc_pause_seconds_total') * 1000) / secs), max: round(maxOf(samples.map((s) => s.gcMax))) },
      outKBps: round(d('bunkcraft_ws_bytes_sent_total') / secs / 1024),
      inKBps: round(d('bunkcraft_ws_bytes_received_total') / secs / 1024),
      outKBpsPerPlayer: round(d('bunkcraft_ws_bytes_sent_total') / secs / 1024 / Math.max(1, joined)),
      msgOutPs: Math.round(d('bunkcraft_ws_messages_sent_total') / secs),
      msgInPs: Math.round(d('bunkcraft_ws_messages_received_total') / secs),
      latency, counts: merged.count,
      botLoopP99: round(maxOf(reports.map((r) => r.loopP99))), botLoopMax: round(maxOf(reports.map((r) => r.loopMax))),
      serverWarnings: {},
      machineLoad: [round(load0), round(loadavg()[0])],
    };
    await sleep(800);
    proc.kill('SIGINT');
    await Promise.race([exited, sleep(15_000)]);
    // Warnings and errors the server logged during the run, by message.
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      try {
        const j = JSON.parse(line) as { level?: string; msg?: string };
        if (j.level === 'warn' || j.level === 'error') result.serverWarnings[`${j.level}: ${j.msg}`] = (result.serverWarnings[`${j.level}: ${j.msg}`] ?? 0) + 1;
      } catch { /* not JSON */ }
    }
    if (PROFILE) result.profile = join(PROF_DIR, `${label}.cpuprofile`);
    print(result);
    return result;
  } finally {
    if (proc.exitCode === null) { proc.kill('SIGKILL'); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function print(r: StepResult): void {
  const l = r.latency, c = r.counts;
  console.log(`--- ${r.step}: ${r.joined}/${r.players} players`);
  console.log(`  server: tick p50 ${r.tick.p50} p99 ${r.tick.p99} max ${r.tick.max} ms | loop lag p50 ${r.loopLag.p50} p99 ${r.loopLag.p99} max ${r.loopLag.max} ms`);
  console.log(`          GC ${r.gc.perSec}/s, ${r.gc.msPerSec} ms/s, longest ${r.gc.max} ms | heap ${r.heapMB} MB | start-up ${r.startMs} ms`);
  console.log(`          CPU ${r.cpuPct} % of a core (main thread ${r.mainCpuPct} %) | RSS ${r.rssMB} MB | out ${r.outKBps} KiB/s (${r.outKBpsPerPlayer}/player), in ${r.inKBps} KiB/s | ${r.msgOutPs} msg/s out, ${r.msgInPs} in`);
  console.log(`  bots:   rtt p50 ${l.rtt.p50} p99 ${l.rtt.p99} max ${l.rtt.max} | chat p99 ${l.chat.p99} | take p99 ${l.take.p99} | fire p99 ${l.fire.p99} | edit p99 ${l.edit.p99} | snap gap p50 ${l.snapGap.p50} p99 ${l.snapGap.p99} max ${l.snapGap.max} ms`);
  console.log(`          errors: connectFail ${c.connectFail}, kicked ${c.kicked}, closed ${c.closedUnexpected}, wsError ${c.wsError}, reject ${c.reject}, stateCorrection ${c.stateCorrection}, teleport ${c.teleport}`);
  console.log(`          actions: broken ${c.blocksBroken}, placed ${c.blocksPlaced}, taken ${c.taken}/${c.takes}, attacks ${c.attacks}, chats ${c.chats}, fires ${c.fires}, hits ${c.hits}, kills ${c.kills}, mobs/ent ${(c.mobsSeen / Math.max(1, c.entFrames)).toFixed(1)}`);
  console.log(`          bot process loop lag p99 ${r.botLoopP99} max ${r.botLoopMax} ms | machine load ${r.machineLoad.join(' → ')} (${cpus().length} cores) | server warnings ${JSON.stringify(r.serverWarnings)}`);
}

const results: StepResult[] = [];
for (const s of steps) {
  results.push(await runStep(s.kind, s.rooms, s.bots ?? BOTS));
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
}
console.log('\nstep                 players  tick p50/p99/max ms   lag p99/max ms   CPU %  main %   RSS MB  gc max  out KiB/s/pl  rtt p99  snapgap p99  errors');
for (const r of results) {
  const c = r.counts;
  const errors = c.connectFail + c.kicked + c.closedUnexpected + c.wsError;
  console.log(`${r.step.padEnd(20)} ${String(r.joined).padStart(7)}  ${`${r.tick.p50}/${r.tick.p99}/${r.tick.max}`.padEnd(20)} ${`${r.loopLag.p99}/${r.loopLag.max}`.padEnd(16)} ${String(r.cpuPct).padStart(5)}  ${String(r.mainCpuPct).padStart(6)}  ${String(r.rssMB).padStart(6)}  ${String(r.gc.max).padStart(6)}  ${String(r.outKBpsPerPlayer).padStart(12)}  ${String(r.latency.rtt.p99).padStart(7)}  ${String(r.latency.snapGap.p99).padStart(11)}  ${errors}`);
}
process.exit(0);
