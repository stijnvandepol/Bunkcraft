import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../../server/GameServer';
import { FakeSocket, connect } from './fakeSocket';

/**
 * Protocol fuzzing: thousands of random or malformed messages per message type are fed to a real
 * GameServer (both a Minecraft world and an arcade match). Whatever arrives, the server must never
 * throw, never leave a client without service, and keep ticking.
 */

const dirs: string[] = [];
const servers: GameServer[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  vi.useRealTimers();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function makeServer(kind: 'minecraft' | 'tdm' | 'ffa'): GameServer {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-fuzz-'));
  dirs.push(dir);
  const s = new GameServer({
    dataDir: dir, worldName: 'Fuzz', seed: '5', gameMode: 'survival', motd: '', maxPlayers: 6, quiet: true,
    ...(kind === 'minecraft' ? {} : { gameType: kind, scoreLimit: 10, timeLimitSec: 300 }),
  });
  servers.push(s);
  return s;
}

// ---------------------------------------------------------------- generators

/** Values a hostile or buggy client might put in any field. */
const nasty: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: fc.integer() },
  { weight: 3, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true }) },
  { weight: 2, arbitrary: fc.constantFrom(0, -0, 1, -1, 0.5, 63.9999, 64, 127, 128, 255, 256, 2 ** 31, 2 ** 32, 2 ** 53, -(2 ** 53), 1e308, -1e308, 1e-300) },
  { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
  { weight: 1, arbitrary: fc.constantFrom(null, true, false, [], {}, 'NaN', 'Infinity', '__proto__', 'constructor') },
  { weight: 1, arbitrary: fc.array(fc.oneof(fc.integer(), fc.string({ maxLength: 4 }), fc.array(fc.integer(), { maxLength: 4 })), { maxLength: 70 }) },
  { weight: 1, arbitrary: fc.object({ maxDepth: 2, maxKeys: 4 }) },
);

/** Mostly plausible numbers around the spawn so messages get past the first validation layer. */
const near = fc.double({ min: -60, max: 60, noNaN: true });
const small = fc.integer({ min: 0, max: 12 });
const field = (sane: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> => fc.oneof({ weight: 3, arbitrary: sane }, { weight: 2, arbitrary: nasty });

const slot = fc.oneof(fc.constantFrom(0, 1, 2), nasty);
const dir = fc.double({ min: -1, max: 1, noNaN: true });

const messageTypes: Record<string, fc.Arbitrary<Record<string, unknown>>> = {
  hello: fc.record({ t: fc.constant('hello'), v: field(fc.constant(4)), name: field(fc.stringMatching(/^[A-Za-z0-9_]{3,16}$/)) }),
  pos: fc.record({ t: fc.constant('pos'), x: field(near), y: field(fc.double({ min: 55, max: 120, noNaN: true })), z: field(near), yaw: field(near), pitch: field(near), flags: field(small), held: field(small) }),
  block: fc.record({ t: fc.constant('block'), seq: field(small), x: field(fc.integer({ min: -30, max: 30 })), y: field(fc.integer({ min: 0, max: 130 })), z: field(fc.integer({ min: -30, max: 30 })), id: field(fc.integer({ min: 0, max: 300 })), meta: field(fc.integer({ min: 0, max: 20 })) }, { requiredKeys: ['t'] }),
  chat: fc.record({ t: fc.constant('chat'), text: field(fc.oneof(fc.string({ maxLength: 300 }), fc.constantFrom('/help', '/list', '/time set night', '/spawn', '/seed', '/', '/time', '/time set', '/unknown x'))) }, { requiredKeys: ['t'] }),
  state: fc.record({ t: fc.constant('state'), inventory: field(fc.array(fc.array(fc.integer({ min: -5, max: 400 }), { maxLength: 4 }), { maxLength: 40 })), stats: field(fc.array(fc.double({ noNaN: true }), { maxLength: 6 })) }, { requiredKeys: ['t'] }),
  attack: fc.record({ t: fc.constant('attack'), id: field(small) }, { requiredKeys: ['t'] }),
  shoot: fc.record({ t: fc.constant('shoot'), x: field(near), y: field(near), z: field(near), dx: field(dir), dy: field(dir), dz: field(dir), power: field(fc.double({ min: 0, max: 1, noNaN: true })) }, { requiredKeys: ['t'] }),
  ignite: fc.record({ t: fc.constant('ignite'), x: field(near), y: field(near), z: field(near) }, { requiredKeys: ['t'] }),
  take: fc.record({ t: fc.constant('take'), id: field(small) }, { requiredKeys: ['t'] }),
  loadout: fc.record({ t: fc.constant('loadout'), primary: field(fc.constantFrom('rifle', 'smg', 'shotgun', 'sniper', 'knife', 'pistol')) }, { requiredKeys: ['t'] }),
  fire: fc.record({ t: fc.constant('fire'), slot, ox: field(near), oy: field(near), oz: field(near), dx: field(dir), dy: field(dir), dz: field(dir), ads: field(fc.boolean()) }, { requiredKeys: ['t'] }),
  reload: fc.record({ t: fc.constant('reload'), slot }, { requiredKeys: ['t'] }),
  weapon: fc.record({ t: fc.constant('weapon'), slot }, { requiredKeys: ['t'] }),
  drop: fc.record({ t: fc.constant('drop'), id: field(fc.integer({ min: 0, max: 300 })), count: field(fc.integer({ min: -2, max: 100 })), damage: field(small), x: field(near), y: field(near), z: field(near), yaw: field(near), delay: field(small) }, { requiredKeys: ['t'] }),
  unknown: fc.record({ t: fc.oneof(fc.string({ maxLength: 12 }), nasty), a: nasty, b: nasty }),
};

/** Every message type, with extra junk fields mixed in now and then. */
const anyMessage = fc.oneof(...Object.values(messageTypes).map((a) => fc.tuple(a, fc.dictionary(fc.string({ maxLength: 6 }), nasty, { maxKeys: 2 })).map(([m, extra]) => ({ ...extra, ...m }))));

// ---------------------------------------------------------------- tests

const KINDS = ['minecraft', 'tdm', 'ffa'] as const;

describe.each(KINDS)('fuzzing a %s game server', (kind) => {
  for (const [type, arb] of Object.entries(messageTypes)) {
    it(`survives thousands of random "${type}" messages`, () => {
      const server = makeServer(kind);
      const a = connect(server, 'fuzz_a');
      const b = connect(server, 'fuzz_b');
      // Give both a plausible position so the deeper handlers run.
      for (const ws of [a, b]) {
        const w = ws.of('welcome')[0];
        ws.say({ t: 'pos', x: w.spawn.x, y: w.spawn.y, z: w.spawn.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
      }
      let n = 0;
      fc.assert(fc.property(arb, (msg) => {
        (n++ % 2 ? a : b).say(msg);
        if (n % 150 === 0) vi.advanceTimersByTime(250);
      }), { numRuns: type === 'unknown' ? 500 : 1200 });
      // Still alive: ticks keep running and a new player can join.
      vi.advanceTimersByTime(3000);
      const c = connect(server, 'fuzz_c');
      expect(c.of('welcome')).toHaveLength(1);
      expect(server.playerCount).toBeGreaterThanOrEqual(1);
    }, 60_000);
  }

  it('survives an interleaved mix of all message types between several clients', () => {
    const server = makeServer(kind);
    const clients = ['mix_a', 'mix_b', 'mix_c'].map((n) => connect(server, n));
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), anyMessage), { minLength: 1, maxLength: 30 }), (batch) => {
      for (const [who, m] of batch) clients[who].say(m);
      vi.advanceTimersByTime(100);
    }), { numRuns: 250 });
    vi.advanceTimersByTime(5000);
    expect(connect(server, 'mix_after').of('welcome')).toHaveLength(1);
  }, 60_000);

  it('survives raw frames: random bytes, binary frames, truncated and non-object JSON', () => {
    const server = makeServer(kind);
    // The JSON literal `null` is covered separately below (known bug, see it.fails).
    const isNullFrame = (d: Buffer) => { try { return JSON.parse(d.toString()) === null; } catch { return false; } };
    const frames = fc.oneof(
      fc.uint8Array({ maxLength: 200 }).map((u) => [Buffer.from(u), false] as const),
      fc.uint8Array({ maxLength: 200 }).map((u) => [Buffer.from(u), true] as const),
      fc.string({ maxLength: 100 }).map((s) => [Buffer.from(s), false] as const),
      fc.jsonValue().map((v) => [Buffer.from(JSON.stringify(v)), false] as const),
      anyMessage.map((m) => [Buffer.from(JSON.stringify(m).slice(0, 25)), false] as const),
    ).filter(([d, binary]) => binary || !isNullFrame(d));
    fc.assert(fc.property(frames, ([data, binary]) => {
      // A fresh socket per frame: the server may legitimately close the connection on garbage.
      const ws = new FakeSocket();
      server.accept(ws as unknown as import('ws').WebSocket);
      ws.raw(data, binary);
      ws.emit('close');
    }), { numRuns: 1500 });
    // And on a logged-in session too.
    const ws = connect(server, 'raw_user');
    fc.assert(fc.property(frames, ([data, binary]) => { ws.raw(data, binary); }), { numRuns: 1500 });
    vi.advanceTimersByTime(2000);
    expect(connect(server, 'raw_after').of('welcome')).toHaveLength(1);
  }, 60_000);

  // BUG (server/GameServer.ts accept(): `msg.t` on a parsed `null`): one frame containing the JSON literal
  // `null` throws inside the socket's message handler, which crashes the whole Node process on a real server.
  // Fix: `if (typeof msg !== 'object' || msg === null) { ws.close(1003, 'Bad message'); return; }` after JSON.parse.
  it.fails('does not throw on a JSON null frame (before and after login)', () => {
    const server = makeServer(kind);
    const early = new FakeSocket();
    server.accept(early as unknown as import('ws').WebSocket);
    early.raw('null');
    const ws = connect(server, 'null_user');
    ws.raw('null');
  });

  // BUG (server/GameServer.ts onPos): the first position of a session skips the speed check (`s.hasPos` is false) and
  // has no world bounds, so x = 1e308 is accepted; round(v * 1000) then overflows to Infinity and the 'snap' broadcast
  // carries `null` coordinates to every other player.
  (kind === 'minecraft' ? it.fails : it)('rejects absurd coordinates in the first position message', () => {
    const server = makeServer(kind);
    const ws = connect(server, 'far_away');
    ws.say({ t: 'pos', x: 1e308, y: 1e308, z: -1e308, yaw: 0, pitch: 0, flags: 0, held: 0 });
    vi.advanceTimersByTime(200);
    for (const snap of ws.of('snap')) for (const row of snap.players) for (const v of row) expect(Number.isFinite(v)).toBe(true);
  });

  it('never sends a malformed server message back (everything is valid JSON with a type)', () => {
    const server = makeServer(kind);
    const ws = connect(server, 'echo_user');
    // The very first position is not speed-checked (see the it.fails below), so give the player a sane one.
    const w = ws.of('welcome')[0];
    ws.say({ t: 'pos', x: w.spawn.x, y: w.spawn.y, z: w.spawn.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    fc.assert(fc.property(anyMessage, (m) => { ws.say(m); }), { numRuns: 1500 });
    vi.advanceTimersByTime(2000);
    for (const m of ws.sent) {
      expect(typeof m.t).toBe('string');
      // Our own JSON.stringify would have turned NaN and Infinity into null: positions must stay finite numbers.
      if (m.t === 'snap') for (const row of m.players) for (const v of row) expect(Number.isFinite(v)).toBe(true);
    }
  }, 60_000);
});
