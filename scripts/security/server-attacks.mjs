// Attacks against a running local server: ROOM_CREATE_LIMIT=1000 PORT=3100 npm run server
// then: node scripts/security/server-attacks.mjs 127.0.0.1:3100
import WebSocket from 'ws';
import { HOST, base, raw, alive, createRoom, join, sleep, report, results } from './lib.mjs';

const POS = (x, y, z) => JSON.stringify({ t: 'pos', x, y, z, yaw: 0, pitch: 0, flags: 0, held: 0 });

// --- static serving: path traversal
for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..\\..\\package.json', '/%5c..%5c..%5cpackage.json',
  '/assets/..%2f..%2fpackage.json', '/%00', '/index.html%00.png', '//etc/passwd', '/....//....//package.json']) {
  const r = await raw(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  report(`traversal ${p}`, !/"name": "bunkcraft"|root:/.test(r));
}
// --- header/transport hardening
const big = await raw(`GET / HTTP/1.1\r\nHost: x\r\nX-A: ${'a'.repeat(100_000)}\r\nConnection: close\r\n\r\n`);
report('oversized header rejected (431/400)', /431|400/.test(big.split('\r\n')[0]) || big === '');
const many = await raw(`GET / HTTP/1.1\r\nHost: x\r\n${Array.from({ length: 400 }, (_, i) => `X-${i}: 1`).join('\r\n')}\r\n\r\n`);
report('400 headers do not crash the server (extra headers are ignored)', await alive() && many.length >= 0);
const headers = await fetch(base + '/');
report('CSP header present', !!headers.headers.get('content-security-policy'));
report('X-Content-Type-Options', headers.headers.get('x-content-type-options') === 'nosniff');
report('frame-ancestors / X-Frame-Options', /frame-ancestors/.test(headers.headers.get('content-security-policy') ?? '') || !!headers.headers.get('x-frame-options'));
// slowloris: send half a request and see whether the server closes within 12 s
{
  const t0 = Date.now();
  await raw('GET / HTTP/1.1\r\nHost: x\r\nX-Slow: ', { wait: 25_000 });
  report('slowloris connection closed by server (<24s)', Date.now() - t0 < 24_000, `${Date.now() - t0} ms`);
}
// --- API bodies
const post = (b) => fetch(`${base}/api/rooms`, { method: 'POST', body: b });
report('huge body rejected', await post('x'.repeat(100_000)).then((r) => r.status >= 400, () => true));
report('JSON null body does not crash', (await post('null').catch(() => ({ status: 0 }))).status !== 0 && await alive());
report('__proto__ body accepted safely', (await post('{"__proto__":{"polluted":1},"name":"x"}')).status === 201 && ({}).polluted === undefined);
report('NaN/Infinity/huge numbers clamped', (await post('{"gameType":"tdm","scoreLimit":1e999,"timeLimitSec":-5}')).status === 201);
report('room name control chars stripped', await (async () => {
  const code = await createRoom({ name: '<img src=x onerror=alert(1)>\u0000\u001b[31mred' });
  const info = await (await fetch(`${base}/api/rooms/${code}`)).json();
  return !/[\u0000-\u001f]/.test(info.name);
})());
report('room lookup path traversal', (await fetch(`${base}/api/rooms/..%2f..%2fx`)).status === 404);
// --- X-Forwarded-For spoofing (must not matter when TRUST_PROXY is off)
{
  let blocked = false;
  for (let i = 0; i < 60 && !blocked; i++) {
    const r = await fetch(`${base}/api/rooms/AAAAAA`, { headers: { 'x-forwarded-for': `10.0.0.${i}` } });
    if (r.status === 429) blocked = true;
  }
  report('XFF spoof does not bypass lookup limiter (TRUST_PROXY off)', blocked);
}
// The limiter above is shared with WebSocket upgrades (40/min): wait for the window to pass.
console.log('waiting 62 s for the lookup limiter window...');
await sleep(62_000);
// --- WebSocket abuse
async function room() {
  return createRoom({ name: 'attack' });
}
const code = await room();
async function survive(id, fn) {
  try { await fn(); } catch { /* connection errors are fine */ }
  await sleep(300);
  report(id, await alive());
}
await survive('ws: "null" JSON before hello does not crash server', async () => {
  const ws = new WebSocket(`ws://${HOST}/ws/${code}`); await new Promise((r) => ws.on('open', r)); ws.send('null'); await sleep(200);
});
await survive('ws: "null" JSON after hello does not crash server', async () => {
  const { ws } = await join(code, 'Nulltest'); ws.send('null'); ws.send('5'); ws.send('"x"'); ws.send('[]'); await sleep(200);
});
await survive('ws: type confusion in every message', async () => {
  const { ws } = await join(code, 'Confuse');
  const junk = [null, 'a', NaN, Infinity, -1, 1e308, {}, [], { a: 1 }, true, '__proto__'];
  for (const t of ['pos', 'block', 'chat', 'state', 'attack', 'shoot', 'ignite', 'take', 'drop', 'loadout', 'fire', 'reload', 'weapon', 'hello']) {
    for (const j of junk) ws.send(JSON.stringify({ t, x: j, y: j, z: j, id: j, count: j, text: j, name: j, inventory: j, stats: j, seq: j, v: j, damage: j, dx: j, dy: j, dz: j, power: j, yaw: j, delay: j, slot: j, primary: j, meta: j }));
  }
  ws.send(JSON.stringify({ t: 'state', inventory: [[1, 2, { a: 1 }], 'x', null], stats: [] }));
  ws.send(JSON.stringify({ t: 'chat' }));
  await sleep(500);
});
await survive('ws: binary frames and giant frame', async () => {
  const { ws } = await join(code, 'Giant'); ws.send(Buffer.alloc(100_000, 1)); await sleep(300);
});
await survive('ws: message flood (5000 pos messages)', async () => {
  const { ws } = await join(code, 'Flood');
  for (let i = 0; i < 5000; i++) ws.send(POS(0, 80, 0));
  await sleep(500);
});
// teleport bypass: the speed check is skipped below y=-60
{
  const { ws, welcome } = await join(code, 'Teleporter');
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const p = welcome.spawn;
  ws.send(POS(p.x, p.y, p.z));
  await sleep(100);
  ws.send(POS(5_000_000, -100, 5_000_000));
  await sleep(100);
  ws.send(POS(5_000_000, 80, 5_000_000));
  await sleep(600);
  const snap = msgs.filter((m) => m.t === 'snap').flatMap((m) => m.players).find((e) => e[0] === welcome.id);
  report('speed check cannot be bypassed with y < -60', !snap || Math.abs(snap[1]) < 1000, snap ? `server position x=${snap[1]}` : '');
  ws.close();
}
await survive('ws: absurd coordinates (1e300) do not hang the server', async () => {
  const { ws } = await join(code, 'Far');
  ws.send(POS(1e300, -100, -1e300));
  await sleep(1500);
});
// name handling
await survive('ws: reserved names (__proto__, constructor)', async () => {
  for (const n of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const j = await join(code, n).catch(() => null);
    if (j) { j.ws.send(POS(0, 80, 0)); await sleep(100); j.ws.close(); }
  }
  await sleep(200);
});
{
  const fresh = await join(code, 'Innocent').catch(() => null);
  report('player records are not inherited via __proto__', fresh?.welcome.player === null, JSON.stringify(fresh?.welcome.player)?.slice(0, 80));
  fresh?.ws.close();
}
// many sockets without hello
{
  const socks = [];
  for (let i = 0; i < 300; i++) socks.push(new WebSocket(`ws://${HOST}/ws/${code}`).on('error', () => {}));
  await sleep(1000);
  report('300 idle sockets from one IP (informational: no per-IP cap)', await alive());
  socks.forEach((s) => s.terminate());
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
