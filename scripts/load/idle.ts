/**
 * Start-up time and idle cost of the server: how fast it answers /health, what an empty process costs, what
 * loaded-but-empty games cost (CPU and memory) and what is given back once they are unloaded.
 *
 *   npx tsx scripts/load/idle.ts [--entry bundle|tsx] [--rooms 20] [--port 3198] [--node-flags="..."]
 *
 * Memory is the RSS of the whole process tree (tsx starts an esbuild helper process next to node).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../../src/net/protocol';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  // --key=value (needed when the value itself starts with --, e.g. --node-flags=--max-semi-space-size=32).
  if (a.includes('=')) { args.set(a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)); continue; }
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i++; } else args.set(a.slice(2), '1');
}
const ENTRY = args.get('entry') ?? 'bundle';
const ROOMS = Number(args.get('rooms') ?? 20);
const PORT = Number(args.get('port') ?? 3198);
const NODE_FLAGS = (args.get('node-flags') ?? '').split(/\s+/).filter(Boolean);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RSS in MB of a process and all its descendants (ps, macOS and Linux). */
function treeRssMB(pid: number): number {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString().trim().split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map<number, number[]>();
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const rss = new Map(rows.map(([p, , r]) => [p, r]));
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return Math.round(total / 1024);
}

async function prom(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const line of (await (await fetch(`${BASE}/metrics`)).text()).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return out;
}

/** CPU % of one core over `secs`, from process_cpu_seconds_total. */
async function cpuOver(secs: number): Promise<number> {
  const a = (await prom()).get('process_cpu_seconds_total') ?? 0;
  await sleep(secs * 1000);
  const b = (await prom()).get('process_cpu_seconds_total') ?? 0;
  return Math.round(((b - a) / secs) * 1000) / 10;
}

async function joinAndLeave(code: string, i: number): Promise<void> {
  await new Promise<void>((done) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${code}`, { headers: { 'x-forwarded-for': `10.9.${i >> 8}.${i & 255}` } });
    const t = setTimeout(() => { ws.terminate(); done(); }, 15_000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: `idle${i}`, key: `idle-key-${i}` })));
    ws.on('message', (raw: Buffer, bin: boolean) => {
      if (bin) return;
      if ((JSON.parse(raw.toString()) as { t: string }).t === 'welcome') {
        // Stay a few seconds so the chunks around spawn are generated, then leave.
        setTimeout(() => { clearTimeout(t); ws.close(); done(); }, 3000);
      }
    });
    ws.on('error', () => { clearTimeout(t); done(); });
  });
}

const dir = mkdtempSync(join(tmpdir(), 'bunk-idle-'));
const t0 = performance.now();
const proc: ChildProcess = spawn(process.execPath, [...NODE_FLAGS, ...(ENTRY === 'tsx' ? ['--import', 'tsx', 'server/index.ts'] : ['dist-server/index.js'])], {
  cwd: root,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: join(dir, 'data'), STATIC_DIR: join(dir, 'nostatic'),
    ROOM_CREATE_LIMIT: '10000', MAX_ROOMS: '10000', TRUST_PROXY: '1', MAIN_WORLD: 'off', BACKUP_KEEP: '0',
    LOG_LEVEL: 'warn', ROOM_IDLE_UNLOAD_MIN: '1.5',
  },
  stdio: 'ignore',
});
try {
  let startMs = 0;
  for (let i = 0; i < 1000 && !startMs; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) startMs = performance.now() - t0; } catch { /* not up */ }
    if (!startMs) await sleep(10);
  }
  await sleep(3000);
  const rssStart = treeRssMB(proc.pid!);
  const cpuEmpty = await cpuOver(10);
  console.log(`[${ENTRY}${NODE_FLAGS.length ? ` ${NODE_FLAGS.join(' ')}` : ''}] start-up ${Math.round(startMs)} ms | empty process RSS ${rssStart} MB, CPU ${cpuEmpty} %`);

  for (let i = 0; i < ROOMS; i++) {
    const kind = i % 2 === 0 ? { name: `Idle ${i}`, gameMode: 'survival', seed: `idle-${i}` } : { name: `Idle arena ${i}`, gameType: 'tdm' };
    const res = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.0.${i + 1}` }, body: JSON.stringify(kind) });
    const { code } = (await res.json()) as { code: string };
    await joinAndLeave(code, i);
  }
  await sleep(5000);
  const m = await prom();
  const loaded = m.get('bunkcraft_rooms_loaded') ?? 0;
  const rssLoaded = treeRssMB(proc.pid!);
  const cpuLoaded = await cpuOver(15);
  console.log(`  ${loaded} empty games loaded (${ROOMS / 2} survival, ${ROOMS / 2} arena): RSS ${rssLoaded} MB (+${((rssLoaded - rssStart) / Math.max(1, loaded)).toFixed(1)} MB/game), heap ${Math.round((m.get('process_heap_used_bytes') ?? 0) / 1048576)} MB, CPU ${cpuLoaded} %`);

  // ROOM_IDLE_UNLOAD_MIN=1.5: a maintenance pass (every 60 s) after that unloads them.
  for (let i = 0; i < 200; i++) {
    await sleep(1000);
    if (((await prom()).get('bunkcraft_rooms_loaded') ?? 0) === 0) break;
  }
  await sleep(5000);
  const m2 = await prom();
  console.log(`  after unloading: ${m2.get('bunkcraft_rooms_loaded')} loaded, RSS ${treeRssMB(proc.pid!)} MB, heap ${Math.round((m2.get('process_heap_used_bytes') ?? 0) / 1048576)} MB, CPU ${await cpuOver(10)} %`);
} finally {
  proc.kill('SIGINT');
  await sleep(1500);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
