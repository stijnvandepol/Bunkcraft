/**
 * TCP proxy that adds latency and jitter (QA: hit registration at a real ping). Bytes keep their order, like TCP:
 * each chunk leaves `rtt/2 + random(0..jitter)` ms after it arrived, but never before the chunk ahead of it.
 *
 *   npx tsx scripts/qa/lag-proxy.ts --listen=3482 --target=3481 --rtt=100 --jitter=20
 *
 * Put it between the QA Vite server and the game server (QA_SERVER_PORT=<listen>), so the browser's WebSocket
 * runs through it while bots connect to the game server directly.
 */
import { createServer, connect, type Socket } from 'node:net';

const arg = (name: string, def: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const listen = arg('listen', 3482), target = arg('target', 3481), rtt = arg('rtt', 100), jitter = arg('jitter', 0);

/** Forwards `from` → `to` with the delay; returns nothing, cleans up on close. */
function pipe(from: Socket, to: Socket): void {
  let last = 0;
  from.on('data', (chunk) => {
    const at = Math.max(last, Date.now() + rtt / 2 + Math.random() * jitter);
    last = at;
    setTimeout(() => { if (!to.destroyed) to.write(chunk); }, at - Date.now());
  });
  from.on('close', () => setTimeout(() => to.destroy(), Math.max(0, last - Date.now()) + 5));
  from.on('error', () => to.destroy());
}

createServer((client) => {
  client.setNoDelay(true);
  const server = connect(target, '127.0.0.1');
  server.setNoDelay(true);
  pipe(client, server);
  pipe(server, client);
}).listen(listen, '127.0.0.1', () => console.log(`lag proxy :${listen} → :${target}, rtt ${rtt} ms, jitter ${jitter} ms`));
