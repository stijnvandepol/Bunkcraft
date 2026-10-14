/**
 * Client half of scripts/qa/container-smoke.sh: talks to a running BunkCraft stack like a player and an admin.
 *
 *   node --import tsx scripts/qa/container-smoke.ts <base-url> <admin-token> <state-file> join|rejoin|ping
 *
 *   join    waits for a warm match runner, opens a TDM lobby with bots, joins it, checks binary snapshots and that the
 *           lobby runs in a match container, measures the server-side ping (through the proxy) and writes the state.
 *   rejoin  after a control plane restart: the lobby must still run in the same runner; the seat is offered and taken back.
 *   ping    in-process baseline: the same lobby and ping measurement without isolation.
 * Prints one JSON line with the measurements.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../src/net/protocol';

const [base, admin, stateFile, phase] = process.argv.slice(2);
if (!base || !admin || !stateFile || !phase) {
  console.error('usage: container-smoke.ts <base-url> <admin-token> <state-file> join|rejoin|ping');
  process.exit(2);
}
const wsBase = base.replace(/^http/, 'ws');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = Record<string, any>>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as T };
}
const adminGet = (path: string) => api('GET', `/api/admin${path}`, undefined, admin).then((r) => r.body);

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}

interface Joined { ws: WebSocket; welcome: Record<string, any>; frames: number; joinMs: number } // eslint-disable-line @typescript-eslint/no-explicit-any

function join(code: string, name: string, extra: Record<string, unknown> = {}): Promise<Joined> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(`${wsBase}/ws/${code}`, { headers: { origin: base } });
    const out: Joined = { ws, welcome: {}, frames: 0, joinMs: 0 };
    const timer = setTimeout(() => reject(new Error('no welcome')), 30_000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, bin: true, binv: 99, ...extra })));
    ws.on('message', (data, bin) => {
      if (bin) { out.frames++; return; }
      const m = JSON.parse(data.toString()) as { t: string; reason?: string };
      if (m.t === 'welcome') { clearTimeout(timer); out.welcome = m; out.joinMs = performance.now() - t0; resolve(out); }
      if (m.t === 'kick') { clearTimeout(timer); reject(new Error(`kicked: ${m.reason}`)); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** The server's own ping of this player (ws ping frames, every few seconds, through the proxy when there is one). */
async function pingSamples(code: string, name: string, n: number): Promise<number[]> {
  const out: number[] = [];
  let last = -1;
  while (out.length < n) {
    const r = await adminGet(`/rooms/${code}/players`) as { players: { name: string; pingMs: number }[] };
    const p = r.players.find((x) => x.name === name);
    if (p && p.pingMs > 0 && p.pingMs !== last) { out.push(p.pingMs); last = p.pingMs; }
    await sleep(500);
  }
  return out;
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function main(): Promise<void> {
  if (phase === 'join' || phase === 'ping') {
    const container = phase === 'join';
    let warmMs = 0;
    if (container) {
      const t0 = Date.now();
      await until('a warm match runner', async () => ((await adminGet('/matches')) as { runners: { state: string }[] }).runners.some((r) => r.state === 'idle'), 90_000);
      warmMs = Date.now() - t0;
    }
    const tCreate = performance.now();
    const created = await api('POST', '/api/rooms', { name: 'Smoke', gameType: 'tdm', scoreLimit: 100, timeLimitSec: 600, maxPlayers: 8, bots: 6, botDifficulty: 'easy' });
    if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.body)}`);
    const code = created.body.code as string;
    const p = await join(code, 'smoker', { key: 'k'.repeat(32) });
    const createToWelcomeMs = performance.now() - tCreate;
    await until('binary snapshots', async () => p.frames > 10, 20_000);
    const matches = await adminGet('/matches') as { runners: { room: string | null; id: string; memBytes: number; memLimitBytes: number; cpu: number; tickP99Ms: number }[]; counters: { startMs: number[] } };
    const runner = matches.runners.find((r) => r.room === code);
    if (container && !runner) throw new Error('lobby is not in a match container');
    if (!container && runner) throw new Error('lobby runs in a container in in-process mode');
    const pings = await pingSamples(code, 'smoker', 6);
    // Docker stats are polled every 10 s: wait for a reading with the match running.
    const stats = container ? await until('docker stats', async () => {
      const m = await adminGet('/matches') as { runners: { room: string | null; memBytes: number; memLimitBytes: number; cpu: number; tickP99Ms: number }[] };
      const r = m.runners.find((x) => x.room === code);
      return r && r.memLimitBytes > 0 ? r : null;
    }, 30_000) : null;
    writeFileSync(stateFile, JSON.stringify({ code, rejoin: p.welcome.rejoin, id: p.welcome.id, runner: runner?.id ?? null }));
    console.log(JSON.stringify({
      phase, code, runner: runner?.id ?? null, warmWaitMs: warmMs, runnerStartMs: matches.counters?.startMs ?? [],
      createToWelcomeMs: Math.round(createToWelcomeMs), joinMs: Math.round(p.joinMs), frames: p.frames,
      pingMs: pings, pingMedianMs: median(pings),
      ...(stats ? { matchMemMB: Math.round(stats.memBytes / 1048576), matchMemLimitMB: Math.round(stats.memLimitBytes / 1048576), matchCpu: stats.cpu, tickP99Ms: stats.tickP99Ms } : {}),
    }));
    // Drop the connection without a goodbye (like a crash): the seat is kept for a rejoin.
    p.ws.terminate();
    return;
  }
  if (phase === 'rejoin') {
    const st = JSON.parse(readFileSync(stateFile, 'utf8')) as { code: string; rejoin: string; id: number; runner: string };
    const adopted = await until('the lobby adopted by the new control plane', async () => {
      const m = await adminGet('/matches') as { runners: { id: string; room: string | null; adopted: boolean }[] };
      return m.runners.find((r) => r.room === st.code) ?? null;
    }, 30_000);
    if (adopted.id !== st.runner || !adopted.adopted) throw new Error(`lobby moved: ${JSON.stringify(adopted)}`);
    const offer = await api('POST', '/api/rejoin', { code: st.code, token: st.rejoin });
    if (offer.body.state !== 'kept') throw new Error(`no kept seat: ${JSON.stringify(offer.body)}`);
    const p = await join(st.code, 'smoker', { key: 'k'.repeat(32), rejoin: st.rejoin });
    if (p.welcome.rejoined !== true || p.welcome.id !== st.id) throw new Error(`not the same seat: ${JSON.stringify({ rejoined: p.welcome.rejoined, id: p.welcome.id })}`);
    console.log(JSON.stringify({ phase, code: st.code, runner: adopted.id, adopted: adopted.adopted, offer: offer.body, rejoined: true }));
    p.ws.close();
    return;
  }
  throw new Error(`unknown phase ${phase}`);
}

main().then(() => process.exit(0), (e: unknown) => { console.error(`SMOKE FAILED: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
