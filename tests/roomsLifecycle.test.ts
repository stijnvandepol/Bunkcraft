import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rooms, SCORE_LIMIT_RANGE, TIME_LIMIT_RANGE } from '../server/Rooms';
import { connect } from './fuzz/fakeSocket';

const dirs: string[] = [];
const sets: Rooms[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => {
  sets.splice(0).forEach((r) => r.shutdown());
  vi.useRealTimers();
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function make(over: Partial<ConstructorParameters<typeof Rooms>[0]> = {}, dir?: string): { rooms: Rooms; dir: string } {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'bunk-rooms-'));
  if (!dir) dirs.push(d);
  const rooms = new Rooms({ dataDir: d, maxRooms: 3, maxPlayers: 2, motd: 'hi', idleUnloadMs: 5 * 60_000, expireDays: 10, ...over });
  sets.push(rooms);
  return { rooms, dir: d };
}

describe('Rooms lifecycle', () => {
  it('creates rooms with sanitised names, valid codes and the Minecraft defaults', () => {
    const { rooms } = make();
    const code = rooms.create('  \u0001My   game\u0000 ' + 'x'.repeat(60), 'creative', ' seed ')!;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    const info = rooms.info(code)!;
    expect(info).toMatchObject({ code, gameMode: 'creative', gameType: 'minecraft', players: 0, maxPlayers: 2 });
    expect(info.name.length).toBeLessThanOrEqual(32);
    expect(info.name).not.toMatch(/[\u0000-\u001f]/);
    expect(rooms.create('', 'nonsense', undefined)).not.toBeNull();
    expect(rooms.info(rooms.create('', undefined, undefined)!)!.name).toBe('BunkCraft Game');
  });

  it('refuses new rooms beyond maxRooms and counts them', () => {
    const { rooms } = make({ maxRooms: 2 });
    expect(rooms.create('a', undefined, undefined)).not.toBeNull();
    expect(rooms.create('b', undefined, undefined)).not.toBeNull();
    expect(rooms.count).toBe(2);
    expect(rooms.create('c', undefined, undefined)).toBeNull();
  });

  it('clamps arcade settings and ignores bad ones', () => {
    const { rooms } = make({ maxRooms: 10 });
    const low = rooms.info(rooms.create('a', undefined, undefined, { gameType: 'tdm', scoreLimit: 1, timeLimitSec: 5, mapId: 'nope' })!)!;
    expect(low).toMatchObject({ gameType: 'tdm', scoreLimit: SCORE_LIMIT_RANGE.min, timeLimitSec: TIME_LIMIT_RANGE.min, map: 'classic' });
    const high = rooms.info(rooms.create('a', undefined, undefined, { gameType: 'ffa', scoreLimit: 1e9, timeLimitSec: 1e9, mapId: 'rotate' })!)!;
    expect(high).toMatchObject({ gameType: 'ffa', scoreLimit: SCORE_LIMIT_RANGE.max, timeLimitSec: TIME_LIMIT_RANGE.max, map: 'rotate' });
    const junk = rooms.info(rooms.create('a', undefined, undefined, { gameType: 'tdm', scoreLimit: 'x', timeLimitSec: NaN })!)!;
    expect(junk.scoreLimit).toBeGreaterThanOrEqual(SCORE_LIMIT_RANGE.min);
    const unknownType = rooms.info(rooms.create('a', undefined, undefined, { gameType: 'battle-royale' })!)!;
    expect(unknownType.gameType).toBe('minecraft');
  });

  it('unloads an empty room after the idle time and loads it again from disk with its settings', () => {
    const { rooms, dir } = make({ idleUnloadMs: 1000 });
    const code = rooms.create('Persistent', 'creative', 'abc', { gameType: 'ffa', scoreLimit: 20, timeLimitSec: 300, mapId: 'desert' })!;
    const before = rooms.info(code)!;
    vi.advanceTimersByTime(61_000); // the maintenance pass runs every minute
    expect(existsSync(join(dir, code, 'world.json'))).toBe(true);
    const after = rooms.info(code)!; // loads from disk
    expect(after).toMatchObject({ name: 'Persistent', gameType: 'ffa', scoreLimit: 20, timeLimitSec: 300, map: 'desert' });
    expect(after.gameMode).toBe(before.gameMode);
    expect(rooms.get(code)!.server).not.toBeUndefined();
  });

  it('keeps a room in memory while players are in it', () => {
    const { rooms } = make({ idleUnloadMs: 1000 });
    const code = rooms.create('Busy', undefined, undefined)!;
    const server = rooms.get(code)!.server;
    const ws = connect(server, 'resident');
    expect(ws.of('welcome')).toHaveLength(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(rooms.get(code)!.server).toBe(server); // same instance: never unloaded
    expect(rooms.playerCount).toBe(1);
  });

  it('get() accepts codes in link or lower-case form and returns null for unknown or malformed ones', () => {
    const { rooms } = make();
    const code = rooms.create('x', undefined, undefined)!;
    expect(rooms.get(code.toLowerCase())?.code).toBe(code);
    expect(rooms.get(`https://x.test/?join=${code}`)?.code).toBe(code);
    expect(rooms.get('ZZZZZZ')).toBeNull();
    expect(rooms.get('../../etc')).toBeNull();
    expect(rooms.info('')).toBeNull();
  });

  it('deletes rooms nobody used for expireDays on startup but keeps recent ones', () => {
    const { rooms, dir } = make({ expireDays: 5 });
    const old = rooms.create('old', undefined, undefined)!;
    const fresh = rooms.create('fresh', undefined, undefined)!;
    rooms.shutdown();
    sets.length = 0;
    const longAgo = new Date(Date.now() - 6 * 86_400_000);
    utimesSync(join(dir, old, 'world.json'), longAgo, longAgo);
    const second = make({ expireDays: 5 }, dir).rooms;
    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, fresh, 'world.json'))).toBe(true);
    expect(second.count).toBe(1);
    expect(second.info(old)).toBeNull();
    expect(second.info(fresh)?.name).toBe('fresh');
  });

  it('expireDays 0 keeps everything forever', () => {
    const { rooms, dir } = make({ expireDays: 0 });
    const code = rooms.create('forever', undefined, undefined)!;
    rooms.shutdown();
    sets.length = 0;
    const longAgo = new Date(Date.now() - 900 * 86_400_000);
    utimesSync(join(dir, code, 'world.json'), longAgo, longAgo);
    make({ expireDays: 0 }, dir);
    expect(existsSync(join(dir, code, 'world.json'))).toBe(true);
  });

  it('ignores stray files and folders in the data dir', () => {
    const { rooms, dir } = make();
    rooms.shutdown();
    sets.length = 0;
    mkdirSync(join(dir, 'ABCDEF'));
    mkdirSync(join(dir, 'not-a-room'));
    writeFileSync(join(dir, 'notes.txt'), 'x');
    // A folder with a room-like name but no world file, and a non-code name: neither is counted.
    const again = make({}, dir).rooms;
    expect(again.count).toBe(0);
  });
});
