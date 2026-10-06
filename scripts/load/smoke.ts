/**
 * End-to-end smoke test of a running server (a Docker container, a VPS): /health, the static game, creating a
 * game over the API and a WebSocket player that joins it and receives the world, the game clock and a chat echo.
 *
 *   npx tsx scripts/load/smoke.ts http://127.0.0.1:3000
 *   npx tsx scripts/load/smoke.ts https://play.example.com
 *
 * Creating a game counts against ROOM_CREATE_LIMIT for your address (6 per hour by default).
 */
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { decodeBinary } from '../../src/net/binary';

const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const fail = (msg: string): never => { console.error(`FAIL ${msg}`); process.exit(1); };
const ok = (msg: string) => console.log(`ok   ${msg}`);

const health = await fetch(`${base}/health`);
if (!health.ok) fail(`/health ${health.status}`);
ok(`/health ${JSON.stringify(await health.json())}`);

const index = await fetch(`${base}/`);
const html = await index.text();
if (!index.ok || !html.includes('<canvas')) fail(`/ ${index.status} (no game page; was the client built?)`);
ok(`/ serves the game (${html.length} bytes, csp ${index.headers.get('content-security-policy') ? 'yes' : 'no'})`);

const created = await fetch(`${base}/api/rooms`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ name: 'Smoke test', gameMode: 'survival', seed: 'smoke' }),
});
if (created.status !== 201) fail(`POST /api/rooms ${created.status} ${await created.text()}`);
const { code, ownerToken } = (await created.json()) as { code: string; ownerToken: string };
ok(`created game ${code}`);

await new Promise<void>((resolve) => {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${code}`, { headers: { origin: base } });
  const seen = new Set<string>();
  const timer = setTimeout(() => fail(`timeout; got ${[...seen].join(', ') || 'nothing'}`), 15_000);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'smoke', bin: true, key: `smoke-${Date.now()}`, owner: ownerToken })));
  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    const m = (isBinary ? decodeBinary(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer) : JSON.parse(raw.toString())) as { t: string; text?: string } | null;
    if (!m) return;
    if (!seen.has(m.t)) {
      seen.add(m.t);
      if (m.t === 'welcome') {
        ok('joined: welcome received');
        ws.send(JSON.stringify({ t: 'chat', text: 'smoke test' }));
      }
    }
    if (m.t === 'chat' && m.text === 'smoke test') ok('chat echo');
    // A lone player gets no snapshots of others; the time broadcast shows the game loop runs.
    if (seen.has('welcome') && seen.has('time') && seen.has('chat')) {
      ok(`messages: ${[...seen].join(', ')}`);
      clearTimeout(timer);
      ws.close();
      resolve();
    }
  });
  ws.on('error', (e) => fail(`websocket: ${e.message}`));
});
console.log('PASS');
process.exit(0);
