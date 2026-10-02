import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeBinary, encodeBinary, encodeEnt, encodeSnap } from '../src/net/binary';
import type { MobEntry, ServerMessage, SnapshotEntry } from '../src/net/protocol';
import { backupAll, backupFile, listBackups } from '../server/Backup';
import { loadConfig } from '../server/Config';
import { GameServer } from '../server/GameServer';
import { Logger } from '../server/Log';
import { Metrics } from '../server/Metrics';
import { RateLimiter, bearer, hashPassword, hashToken, newToken, safeEqual, tokenMatches, verifyPassword } from '../server/Security';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'bunk-unit-')); dirs.push(d); return d; };

describe('binary frames', () => {
  it('round-trips snap within the precision of the JSON path', () => {
    const players: SnapshotEntry[] = [
      [1, 12.345, 64, -200.5, 1.2345, -0.4, 5, 276],
      [65535, -30000.25, 127.5, 99999.125, -3.14, 1.5, 0, 0],
    ];
    const out = decodeBinary(encodeSnap(players)) as Extract<ServerMessage, { t: 'snap' }>;
    expect(out.t).toBe('snap');
    expect(out.players).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(out.players[i][0]).toBe(players[i][0]);
      for (const k of [1, 2, 3]) expect(Math.abs(out.players[i][k] - players[i][k])).toBeLessThan(0.01);
      for (const k of [4, 5]) expect(Math.abs(Math.sin(out.players[i][k]) - Math.sin(players[i][k]))).toBeLessThan(2e-4);
      expect(out.players[i][6]).toBe(players[i][6]);
      expect(out.players[i][7]).toBe(players[i][7]);
    }
  });

  it('round-trips ent with mobs, items, arrows and TNT; empty lists too', () => {
    const m: MobEntry[] = [[70000, 4, 1.5, 70, -3.25, 2.5, -2.5, 0.3, 5, 10, 30, 0]];
    const msg = decodeBinary(encodeEnt(m, [[9, 280, 3, 1, 2, 3]], [[11, 4, 5, 6, 0.5, -0.5, 1]], [[12, 7, 8, 9, 80]])) as Extract<ServerMessage, { t: 'ent' }>;
    expect(msg.m[0][0]).toBe(70000);
    expect(msg.m[0][1]).toBe(4);
    expect(msg.m[0][8]).toBe(5);
    expect(msg.m[0][9]).toBe(10);
    expect(msg.m[0][10]).toBe(30);
    expect(msg.i[0]).toEqual([9, 280, 3, 1, 2, 3]);
    expect(msg.a[0][6]).toBe(1);
    expect(msg.b[0]).toEqual([12, 7, 8, 9, 80]);
    const empty = decodeBinary(encodeEnt([], [], [], [])) as Extract<ServerMessage, { t: 'ent' }>;
    expect(empty).toEqual({ t: 'ent', m: [], i: [], a: [], b: [] });
  });

  it('is at least 40 % smaller than JSON for 16 players and ignores other messages', () => {
    const players: SnapshotEntry[] = Array.from({ length: 16 }, (_, i) => [i + 1, 120.123, 64.5, -88.321, 1.234, 0.123, 4, 17] as SnapshotEntry);
    const json = Buffer.byteLength(JSON.stringify({ t: 'snap', players }));
    expect(encodeSnap(players).byteLength).toBeLessThan(json * 0.6);
    expect(encodeBinary({ t: 'time', time: 0.5 })).toBeNull();
  });

  it('rejects malformed frames instead of throwing', () => {
    expect(decodeBinary(new ArrayBuffer(0))).toBeNull();
    expect(decodeBinary(new Uint8Array([1, 5, 0, 1, 2]).buffer)).toBeNull(); // claims 5 players
    expect(decodeBinary(new Uint8Array([99, 0, 0]).buffer)).toBeNull();
    expect(decodeBinary(new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBeNull();
  });
});

describe('Security', () => {
  it('hashes passwords with scrypt and verifies in constant time', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('correct horsE', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('correct horse')).not.toBe(h); // random salt
  });

  it('tokens: random, hashed for storage, compared safely', () => {
    const t = newToken();
    expect(t.length).toBeGreaterThanOrEqual(30);
    expect(newToken()).not.toBe(t);
    expect(tokenMatches(t, hashToken(t))).toBe(true);
    expect(tokenMatches(`${t}x`, hashToken(t))).toBe(false);
    expect(tokenMatches(undefined, hashToken(t))).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(bearer('Bearer abc.def')).toBe('abc.def');
    expect(bearer('Basic abc')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });

  it('RateLimiter counts failures separately from checks', () => {
    const l = new RateLimiter(2, 60_000);
    expect(l.allowed('a')).toBe(true);
    l.record('a');
    l.record('a');
    expect(l.allowed('a')).toBe(false);
    expect(l.allowed('b')).toBe(true);
    l.reset('a');
    expect(l.allowed('a')).toBe(true);
  });
});

describe('Logger', () => {
  it('writes one JSON object per line and filters by level', () => {
    const lines: string[] = [];
    const logger = new Logger('info', 'json', (l) => lines.push(l));
    logger.debug('hidden');
    logger.info('hello', { room: 'ABC123' });
    logger.child({ room: 'XYZ' }).warn('careful', { n: 1 });
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(a).toMatchObject({ level: 'info', msg: 'hello', room: 'ABC123' });
    expect(typeof a.ts).toBe('string');
    expect(JSON.parse(lines[1])).toMatchObject({ level: 'warn', msg: 'careful', room: 'XYZ', n: 1 });
  });
});

describe('Metrics', () => {
  it('computes tick quantiles and exposes Prometheus text', () => {
    const m = new Metrics();
    for (let i = 1; i <= 100; i++) m.tick(i);
    expect(m.tickQuantile(0.5)).toBeGreaterThanOrEqual(50);
    expect(m.tickQuantile(0.99)).toBeGreaterThanOrEqual(99);
    m.sent(100, 2);
    m.recvd(10);
    m.rateLimited('chat');
    m.rateLimited('chat');
    const text = m.prometheus({ players: 3, roomsLoaded: 2, roomsTotal: 5, connections: 4 }, '1.2.3');
    expect(text).toContain('bunkcraft_players 3');
    expect(text).toContain('bunkcraft_build_info{version="1.2.3"} 1');
    expect(text).toContain('bunkcraft_rate_limit_hits_total{kind="chat"} 2');
    expect(text).toContain('bunkcraft_ws_bytes_sent_total 100');
    // Every sample line is "name{labels} value" or "name value".
    for (const line of text.trim().split('\n').filter((l) => !l.startsWith('#'))) expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?[\d.e+-]+$/);
  });
});

describe('Config', () => {
  it('has safe defaults and parses lists, numbers and flags', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ port: 3000, maxConnections: 500, maxConnPerIp: 10, backupKeep: 12, inventoryGuard: 'enforce', binary: true, allowedOrigins: [] });
    expect(c.adminToken).toBeUndefined();
    const d = loadConfig({
      ADMIN_TOKEN: 't', ALLOWED_ORIGINS: 'https://A.example/, same-origin', MAX_CONN_PER_IP: '3', INVENTORY_GUARD: 'warn', BINARY_PROTOCOL: 'off', OPS: 'alice, bob',
    } as unknown as NodeJS.ProcessEnv);
    expect(d).toMatchObject({ adminToken: 't', allowedOrigins: ['https://a.example', 'same-origin'], maxConnPerIp: 3, inventoryGuard: 'warn', binary: false, ops: ['alice', 'bob'] });
  });
});

describe('backups', () => {
  it('copies only changed worlds, keeps the newest N and lists newest first', () => {
    const dir = tmp();
    const src = join(dir, 'world.json');
    const dest = join(dir, 'backups', 'main');
    writeFileSync(src, '{"v":1}');
    expect(backupFile(src, dest, 3, 1_000)).not.toBeNull();
    expect(backupFile(src, dest, 3, 2_000)).toBeNull(); // unchanged
    for (let v = 2; v <= 6; v++) {
      writeFileSync(src, `{"v":${v}}`);
      utimesSync(src, new Date(Date.now() + v * 1000), new Date(Date.now() + v * 1000)); // newer than the last copy
      expect(backupFile(src, dest, 3, 10_000 * v)).not.toBeNull();
    }
    const files = listBackups(dest);
    expect(files).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(dest, files[0]), 'utf8'))).toEqual({ v: 6 });
    expect(JSON.parse(readFileSync(join(dest, files[2]), 'utf8'))).toEqual({ v: 4 });
    expect(backupFile(src, dest, 0)).toBeNull(); // keep 0 = backups off
  });

  it('backs up the main world and every room, and drops backups of long-deleted rooms', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'world.json'), '{}');
    mkdirSync(join(dir, 'rooms', 'ABCDEF'), { recursive: true });
    writeFileSync(join(dir, 'rooms', 'ABCDEF', 'world.json'), '{"room":1}');
    const backups = join(dir, 'backups');
    mkdirSync(join(backups, 'GONE22'), { recursive: true });
    writeFileSync(join(backups, 'GONE22', '2020.json'), '{}');
    utimesSync(join(backups, 'GONE22', '2020.json'), new Date('2020-01-01'), new Date('2020-01-01'));
    expect(backupAll(dir, backups, 5)).toBe(2);
    expect(readdirSync(backups).sort()).toEqual(['ABCDEF', 'main']);
    expect(existsSync(join(backups, 'GONE22'))).toBe(false);
  });

  it('a corrupt world.json is replaced by the newest readable backup', () => {
    const dir = tmp();
    const data = join(dir, 'game');
    const backupDir = join(dir, 'backups');
    mkdirSync(data, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    const opts = { dataDir: data, worldName: 'W', seed: '7', gameMode: 'creative' as const, motd: '', maxPlayers: 4, quiet: true, backupDir };
    const first = new GameServer(opts);
    first.shutdown();
    backupFile(join(data, 'world.json'), backupDir, 3);
    writeFileSync(join(backupDir, '9999-broken.json'), '{ not json'); // newest, but unreadable: skipped
    writeFileSync(join(data, 'world.json'), '{"truncated": ');
    const second = new GameServer(opts);
    expect(second.name).toBe('W');
    second.shutdown();
    expect(readdirSync(data).some((f) => f.startsWith('world.json.corrupt-'))).toBe(true);
    // Without a usable backup the server refuses to start rather than overwrite the evidence.
    const empty = join(dir, 'game2');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'world.json'), 'garbage');
    expect(() => new GameServer({ ...opts, dataDir: empty, backupDir: join(dir, 'none') })).toThrow(/corrupt/);
  });
});
