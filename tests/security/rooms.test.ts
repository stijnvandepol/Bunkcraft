import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rooms } from '../../server/Rooms';

const dirs: string[] = [];
const sets: Rooms[] = [];
afterEach(() => {
  sets.splice(0).forEach((r) => r.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function rooms(): { rooms: Rooms; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-rooms-'));
  dirs.push(dir);
  const r = new Rooms({ dataDir: dir, maxRooms: 10, maxPlayers: 4, motd: '', idleUnloadMs: 60_000, expireDays: 0 });
  sets.push(r);
  return { rooms: r, dir };
}

describe('Rooms filesystem layout', () => {
  it('only ever creates six-character A-Z/2-9 directories inside the data dir, whatever the name', () => {
    const { rooms: r, dir } = rooms();
    const code = r.create('../../etc/evil\u0000/..\\x', 'survival', '../../seed', {});
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(readdirSync(dir)).toEqual([code]);
  });

  it('refuses codes that are not codes (path traversal, separators, null bytes)', () => {
    const { rooms: r } = rooms();
    for (const raw of ['../..', '..%2f..%2fx', 'AAAA/..', 'A\u0000AAAAA', '/etc/passwd', 'x'.repeat(10_000)]) expect(r.get(raw)).toBeNull();
  });

  it('a damaged world file makes that game unavailable but does not throw', () => {
    const { rooms: r, dir } = rooms();
    mkdirSync(join(dir, 'ABCDEF'));
    writeFileSync(join(dir, 'ABCDEF', 'world.json'), '{ not json');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => r.get('ABCDEF')).not.toThrow();
    expect(r.get('ABCDEF')).toBeNull();
    expect(r.info('ABCDEF')).toBeNull();
    err.mockRestore();
  });

  it('control characters are stripped from game names', () => {
    const { rooms: r } = rooms();
    const code = r.create('a\u0000b\u001b[31mc\n', undefined, undefined)!;
    expect(r.info(code)?.name).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('Rooms expiry', () => {
  it('an expired listed game also leaves the public list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-rooms-'));
    dirs.push(dir);
    const r = new Rooms({ dataDir: dir, maxRooms: 10, maxPlayers: 4, motd: '', idleUnloadMs: 60_000, expireDays: 1 });
    sets.push(r);
    const code = r.create('Old game', 'survival', 'x', {}, { listed: true })!;
    expect(r.listPublic().map((g) => g.code)).toEqual([code]);
    r.close(code, false); // unloaded, still on disk
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(join(dir, code, 'world.json'), old, old);
    (r as unknown as { expire(): void }).expire();
    expect(readdirSync(dir)).toEqual([]);
    expect(r.count).toBe(0);
    (r as unknown as { listCache: null }).listCache = null; // the list is cached for 5 s
    expect(r.listPublic()).toEqual([]);
  });
});
