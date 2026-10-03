import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { arcadeMaxSpeed } from '../src/modes/ArcadeLogic';
import { GameServer } from '../server/GameServer';
import { metrics } from '../server/Metrics';
import { STRIKES } from '../server/anticheat/ArcadeGuard';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

let clock = 1_700_000_000_000;
const dirs: string[] = [];
const servers: GameServer[] = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock); });
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function room(): GameServer {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-ac-'));
  dirs.push(dir);
  const s = new GameServer({
    dataDir: dir, worldName: 'AC', seed: '7', gameMode: 'survival', motd: '', maxPlayers: 8, quiet: true,
    gameType: 'ffa', scoreLimit: 20, timeLimitSec: 300, mapId: 'classic',
  });
  servers.push(s);
  return s;
}

function enter(server: GameServer, name: string) {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
  const sp = ws.of('spawn')[0];
  const me = { x: sp.x, y: sp.y, z: sp.z };
  const pos = (x: number, y: number, z: number) => ws.say({ t: 'pos', x, y, z, yaw: 0, pitch: 0, flags: 4, held: 0 });
  pos(me.x, me.y, me.z); // arrive at the spawn
  return { ws, me, pos };
}

/** A solid block next to open floor near (x, z), for noclip attempts. */
function solidNear(x: number, z: number): [number, number] {
  const map = getMap('classic');
  const v = map.variantFor(7);
  for (let r = 1; r < 30; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const bx = Math.floor(x) + dx, bz = Math.floor(z) + dz;
      if (map.inBounds(bx + 0.5, bz + 0.5) && map.blockAt(v, bx, ARENA_FLOOR_Y + 1, bz) !== 0 && map.blockAt(v, bx, ARENA_FLOOR_Y + 2, bz) !== 0) return [bx + 0.5, bz + 0.5];
    }
  }
  throw new Error('no cover block');
}

describe('arcade movement enforcement on the server', () => {
  it('a legal walk produces no corrections', () => {
    const server = room();
    const { ws, me, pos } = enter(server, 'walker');
    const speed = arcadeMaxSpeed(1) * 0.95;
    // Walk towards the centre for 2 s at 20 Hz, stopping at the first obstacle (the route is not planned).
    const map = getMap('classic');
    const v = map.variantFor(7);
    const len = Math.hypot(me.x, me.z), dx = -me.x / len, dz = -me.z / len;
    for (let i = 0; i < 40; i++) {
      clock += 50;
      const nx = me.x + dx * speed * 0.05, nz = me.z + dz * speed * 0.05;
      if (map.blockAt(v, Math.floor(nx + dx * 0.4), ARENA_FLOOR_Y + 1, Math.floor(nz + dz * 0.4)) !== 0) break;
      me.x = nx; me.z = nz;
      pos(me.x, me.y, me.z);
    }
    expect(ws.of('teleport')).toEqual([]);
  });

  it('noclip into cover is rubber-banded to the last valid position and counted', () => {
    const server = room();
    const { ws, me, pos } = enter(server, 'clipper');
    const total = () => [...metrics.cheatEvents.values()].reduce((a, b) => a + b, 0);
    const before = total();
    const [bx, bz] = solidNear(me.x, me.z);
    clock += 4000; // plenty of budget: only the geometry can stop it
    pos(bx, me.y, bz);
    const tp = ws.of('teleport').at(-1)!;
    expect(tp).toMatchObject({ x: me.x, y: me.y, z: me.z });
    expect(total()).toBeGreaterThan(before);
  });

  it('teleporting is rejected; repeated attempts get the player kicked, and three kicks a ban', () => {
    const server = room();
    let kicked = 0;
    for (let round = 0; round < STRIKES.BAN_AFTER_KICKS; round++) {
      const { ws, me, pos } = enter(server, 'porter');
      for (let i = 0; i < 20 && ws.readyState === 1; i++) {
        clock += 100;
        pos(me.x + 25, me.y, me.z); // far away: teleport
        // Comply with the correction so the next attempt is checked again.
        const tp = ws.of('teleport').at(-1);
        if (tp && ws.readyState === 1) pos(tp.x, tp.y, tp.z);
      }
      if (ws.of('kick').length > 0) kicked++;
    }
    expect(kicked).toBe(STRIKES.BAN_AFTER_KICKS);
    const again = new FakeSocket();
    server.accept(again as unknown as WebSocket);
    again.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'porter' });
    expect(again.of('kick')[0]?.reason).toMatch(/banned/);
  });

  it('a client that ignores the rubber band collects strikes and is kicked', () => {
    const server = room();
    const { ws, me, pos } = enter(server, 'ignorer');
    for (let i = 0; i < 400 && ws.readyState === 1; i++) {
      clock += 100;
      pos(me.x + 6 + i * 0.5, me.y, me.z); // keeps running off at 5 b/s from a place it was never allowed to be
    }
    expect(ws.of('kick').length).toBe(1);
  });

  it('a flying client is corrected', () => {
    const server = room();
    const { ws, me, pos } = enter(server, 'flyer');
    for (let i = 1; i <= 30; i++) { clock += 50; pos(me.x, me.y + Math.min(4, i * 0.3), me.z); }
    expect(ws.of('teleport').length).toBeGreaterThan(0);
  });

  it('shots need a unit direction; a far origin is replaced by the server eye; the admin list shows suspicion', () => {
    const server = room();
    const { ws, me } = enter(server, 'gunner');
    const ammo = () => ws.of('ammo').length;
    const before = ammo();
    clock += 1000;
    ws.say({ t: 'fire', slot: 0, ox: me.x, oy: me.y + 1.62, oz: me.z, dx: 0, dy: 0, dz: 5, ads: false });
    expect(ammo()).toBe(before);
    ws.say({ t: 'fire', slot: 0, ox: me.x + 1.5, oy: me.y + 1.62, oz: me.z, dx: 0, dy: 0, dz: 1, ads: false });
    expect(ammo()).toBe(before + 1);
    expect(metrics.cheatEvents.get('origin')).toBeGreaterThan(0);
    const row = server.playerList().find((p) => p.name === 'gunner')!;
    expect(row.suspicion).toBe(0);
    expect(row.strikes).toBe(0);
  });

  it('live arcade snapshots are per recipient: no self entry, enemies only when visible or near', () => {
    const server = room();
    const a = enter(server, 'alpha'), b = enter(server, 'bravo');
    const tick = () => (server as unknown as { tick(): void }).tick();
    for (let i = 0; i < 12 * 20; i++) { clock += 50; tick(); }
    // Live now; everybody respawned: arrive at the new spawns.
    for (const p of [a, b]) { const sp = p.ws.of('spawn').at(-1)!; p.me.x = sp.x; p.me.y = sp.y; p.me.z = sp.z; p.pos(sp.x, sp.y, sp.z); }
    a.ws.sent = []; b.ws.sent = [];
    for (let i = 0; i < 10; i++) { clock += 50; a.pos(a.me.x, a.me.y, a.me.z); b.pos(b.me.x, b.me.y, b.me.z); tick(); }
    for (const [ws, selfName] of [[a.ws, 'alpha'], [b.ws, 'bravo']] as const) {
      const self = server.playerList().find((p) => p.name === selfName)!.id;
      expect(ws.of('snap').every((m) => m.players.every((e) => e[0] !== self))).toBe(true);
    }
  });

  it('arcade rooms tick at 30 Hz and negotiate quantised binary snapshots (old clients keep the old formats)', () => {
    const server = room();
    const ws = new FakeSocket();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'newclient', bin: true, binv: 2 });
    expect(ws.of('welcome')[0]).toMatchObject({ tickHz: 30, binary: true, binaryVersion: 2 });
    const old = new FakeSocket();
    server.accept(old as unknown as WebSocket);
    old.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'oldclient', bin: true });
    expect(old.of('welcome')[0].binary).toBe(true);
    expect(old.of('welcome')[0].binaryVersion).toBeUndefined();
  });
});
