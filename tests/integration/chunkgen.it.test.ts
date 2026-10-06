import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { BLOCK } from '../../src/world/BlockRegistry';
import { Client, type TestServer, createRoom, sleep, startServer } from './harness';

/** Server-side chunk generation on worker threads (CHUNK_WORKERS), end to end in a real server process. */
let srv: TestServer;
beforeAll(async () => { srv = await startServer({ CHUNK_WORKERS: '2' }); });
afterAll(async () => { await srv.dispose(); });

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${srv.http}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : NaN;
}

describe('chunk generation threads', () => {
  it('generate the land around a survival player, accept an edit at once and save on shutdown', async () => {
    expect(srv.log()).toMatch(/chunkWorkers.{0,4}2/);
    expect(await metric('bunkcraft_chunkgen_workers')).toBe(2);
    const code = await createRoom(srv, { gameMode: 'survival', seed: 'workers' });
    const c = await Client.open(`${srv.ws}/ws/${code}`, 'digger');
    c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'digger' });
    await c.waitType('welcome');
    const s = c.welcome.spawn;
    c.send({ t: 'pos', x: s.x, y: s.y, z: s.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    // Right away, before the pool can have delivered: the server makes that chunk itself (ensureChunk).
    const bx = Math.floor(s.x), by = Math.floor(s.y) - 2, bz = Math.floor(s.z); // the ground the player stands on
    await sleep(60);
    const mark = c.mark();
    c.send({ t: 'block', x: bx, y: by, z: bz, id: BLOCK.AIR, seq: 1 });
    // The 9×9 chunks around the player come from the threads.
    for (let i = 0; i < 100 && !(await metric('bunkcraft_chunkgen_chunks_total{result="generated"}') >= 81); i++) await sleep(100);
    expect(await metric('bunkcraft_chunkgen_chunks_total{result="generated"}')).toBeGreaterThanOrEqual(80);
    expect(await metric('bunkcraft_chunkgen_chunks_total{result="failed"}')).toBe(0);
    expect(c.msgs.slice(mark).filter((m) => m.t === 'reject')).toEqual([]);
    c.close();
    await srv.stop();
    // Stopped cleanly (workers terminated, the process exited) and the edit is on disk.
    expect(srv.log()).not.toMatch(/uncaught|unhandled|chunk worker crashed/);
    const world = JSON.parse(readFileSync(join(srv.dataDir, 'rooms', code, 'world.json'), 'utf8')) as { edits: Record<string, number> };
    expect(world.edits[`${bx},${by},${bz}`]).toBe(BLOCK.AIR);
  });
});
