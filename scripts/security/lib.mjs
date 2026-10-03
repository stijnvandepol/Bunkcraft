// Shared helpers for the attack scripts. Usage: node scripts/security/<script>.mjs [host:port]
import WebSocket from 'ws';
import net from 'node:net';
export const HOST = process.argv[2] ?? '127.0.0.1:3000';
export const [H, P] = HOST.split(':');
export const base = `http://${HOST}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const results = [];
export function report(id, ok, detail = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL (vulnerable)'}  ${id}${detail ? '  ' + detail : ''}`);
}
/** Raw HTTP request over a TCP socket (no client-side normalisation). Resolves with the response text. */
export function raw(data, { wait = 800 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(Number(P), H, () => s.write(data));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('error', () => resolve(out || 'ERROR'));
    s.on('close', () => resolve(out));
    setTimeout(() => { s.destroy(); resolve(out); }, wait);
  });
}
export async function alive() {
  try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
}
export async function createRoom(body = {}) {
  const r = await fetch(`${base}/api/rooms`, { method: 'POST', body: JSON.stringify(body) });
  return (await r.json()).code;
}
/** Connects, logs in and resolves with { ws, welcome, msgs }. */
export function join(code, name, { hello = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}/ws/${code}`);
    const msgs = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      msgs.push(m);
      if (m.t === 'welcome') resolve({ ws, welcome: m, msgs });
      if (m.t === 'kick') reject(new Error(m.reason));
    });
    ws.on('error', reject);
    ws.on('open', () => hello && ws.send(JSON.stringify({ t: 'hello', v: 4, name })));
  });
}
