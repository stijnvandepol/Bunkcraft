import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_VERSION, SaveSystem, type WorldMeta, encodeEdit, newWorldId } from '../src/save/SaveSystem';
import {
  ARCHIVE_LIMITS, ArchiveError, buildBackup, buildWorldArchive, parseArchive, safeFileName,
} from '../src/save/WorldArchive';
import { exportArchive, importArchive } from '../src/save/WorldTransfer';

// 1×1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function meta(over: Partial<WorldMeta> = {}): WorldMeta {
  return {
    version: SAVE_VERSION, id: newWorldId(), name: 'My World', seed: 1234, seedText: 'hello', created: 1000, lastPlayed: 2000,
    player: { x: 1.5, y: 70, z: -3, yaw: 0.5, pitch: -0.2, flying: true },
    hotbar: [1, 2, 3], selectedSlot: 2, time: 0.4, gameMode: 'survival',
    inventory: [[1, 5, 0], [300, 1, 12]], stats: [20, 18, 5, 0, 300], advancements: { 'story/root': 99 },
    spawn: { x: 0, y: 70, z: 0 }, icon: `data:image/png;base64,${PNG_B64}`, ...over,
  };
}

function level(over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) {
  return strToU8(JSON.stringify({
    format: 'bunkworld', formatVersion: 1, saveVersion: SAVE_VERSION,
    meta: { id: 'w1', name: 'W', seed: 5, seedText: '5', created: 1, lastPlayed: 2, time: 0.1, ...metaOver }, ...over,
  }));
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

async function system(): Promise<SaveSystem> {
  const s = new SaveSystem();
  await s.open();
  return s;
}

describe('world archive roundtrip', () => {
  it('exports and imports a world with edits, player data and icon', async () => {
    const a = await system();
    const w = meta();
    await a.saveWorld(w);
    const edits = new Map([[7, new Map([[100, 3], [32767, 1]])], [70000, new Map([[5, 9]])]]);
    await a.saveEdits(w.id, edits, new Set([7, 70000]));
    const bytes = await exportArchive(a, w);

    vi.stubGlobal('indexedDB', new IDBFactory());
    const b = await system();
    const [imported] = await importArchive(b, bytes);
    expect(imported.id).toBe(w.id);
    expect(imported).toMatchObject({
      name: 'My World', seed: 1234, seedText: 'hello', gameMode: 'survival', hotbar: [1, 2, 3], selectedSlot: 2,
      inventory: [[1, 5, 0], [300, 1, 12]], stats: [20, 18, 5, 0, 300], advancements: { 'story/root': 99 }, spawn: { x: 0, y: 70, z: 0 },
    });
    expect(imported.player).toEqual(w.player);
    expect(imported.icon).toBe(w.icon);
    const loaded = await b.loadEdits(w.id);
    expect(loaded).toEqual(edits);
  });

  it('gives an imported world a new id when the id already exists', async () => {
    const s = await system();
    const w = meta();
    await s.saveWorld(w);
    const bytes = await exportArchive(s, w);
    const [copy] = await importArchive(s, bytes);
    expect(copy.id).not.toBe(w.id);
    expect((await s.listWorlds()).length).toBe(2);
  });

  it('round-trips a backup of several worlds', async () => {
    const s = await system();
    const worlds = [meta({ name: 'A' }), meta({ name: 'B' })];
    for (const w of worlds) await s.saveWorld(w);
    const backup = buildBackup(await Promise.all(worlds.map(async (w) => ({ name: `${safeFileName(w.name)}.bunkworld`, bytes: await exportArchive(s, w) }))));
    const imported = await importArchive(s, backup);
    expect(imported.map((m) => m.name).sort()).toEqual(['A', 'B']);
    expect((await s.listWorlds()).length).toBe(4);
  });

  it('keeps no chunk data for a world without edits', () => {
    const parsed = parseArchive(buildWorldArchive(meta(), []));
    expect(parsed[0].records).toEqual([]);
  });
});

describe('migration of old exports', () => {
  it('upgrades version 0 metadata and keeps v1 chunk records readable', async () => {
    const v1Entry = ((100 << 8) | 7) >>> 0; // v1: blockIndex << 8 | id
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, v1Entry, true);
    const zip = zipSync({ 'level.json': level({ saveVersion: 0 }), 'chunks/42.v1.bin': chunk });
    const s = await system();
    const [m] = await importArchive(s, zip);
    expect(m.version).toBe(SAVE_VERSION);
    const edits = await s.loadEdits(m.id);
    expect(edits.get(42)?.get(100)).toBe(7);
  });

  it('uses defaults for a minimal old export without player and icon files', () => {
    const [w] = parseArchive(zipSync({ 'level.json': level({ saveVersion: 0 }) }));
    expect(w.meta.player).toBeNull();
    expect(w.meta.hotbar).toEqual([]);
    expect(w.meta.version).toBe(SAVE_VERSION);
  });

  it('rejects exports from a newer game', () => {
    expect(() => parseArchive(zipSync({ 'level.json': level({ saveVersion: SAVE_VERSION + 1 }) }))).toThrow(/newer BunkCraft/);
    expect(() => parseArchive(zipSync({ 'level.json': level({ formatVersion: 99 }) }))).toThrow(/newer BunkCraft/);
    const chunk = new Uint8Array(4);
    expect(() => parseArchive(zipSync({ 'level.json': level(), 'chunks/1.v9.bin': chunk }))).toThrow(/newer BunkCraft/);
  });
});

describe('malicious archives', () => {
  it('rejects things that are not zips', () => {
    expect(() => parseArchive(strToU8('not a zip file at all, just text'))).toThrow(ArchiveError);
    expect(() => parseArchive(new Uint8Array(0))).toThrow(ArchiveError);
    const truncated = zipSync({ 'level.json': level() }).slice(0, 30);
    expect(() => parseArchive(truncated)).toThrow(ArchiveError);
  });

  it('rejects a zip without a level.json or with the wrong format tag', () => {
    expect(() => parseArchive(zipSync({ 'icon.png': new Uint8Array(8) }))).toThrow(/level\.json/);
    expect(() => parseArchive(zipSync({ 'level.json': level({ format: 'other' }) }))).toThrow(/not a BunkCraft/);
    expect(() => parseArchive(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(/does not contain/);
  });

  it('rejects unexpected file names including path traversal', () => {
    expect(() => parseArchive(zipSync({ 'level.json': level(), '../../evil.js': strToU8('x') }))).toThrow(/Unexpected file/);
    expect(() => parseArchive(zipSync({ 'level.json': level(), 'chunks/../x.bin': strToU8('x') }))).toThrow(/Unexpected file/);
    expect(() => parseArchive(zipSync({ 'level.json': level(), 'extra.json': strToU8('{}') }))).toThrow(/Unexpected file/);
  });

  it('stops a zip bomb: a huge chunk that compresses to almost nothing', () => {
    const bomb = zipSync({ 'level.json': level(), 'chunks/1.v2.bin': new Uint8Array(ARCHIVE_LIMITS.chunkBytes * 40) }, { level: 9 });
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => parseArchive(bomb)).toThrow(/larger than allowed/);
  });

  it('stops a bomb that uses many allowed-size entries', () => {
    const files: Record<string, Uint8Array> = { 'level.json': level() };
    const zeros = new Uint8Array(ARCHIVE_LIMITS.chunkBytes);
    for (let i = 0; i < 1600; i++) files[`chunks/${i}.v2.bin`] = zeros; // 200 MB uncompressed
    const bomb = zipSync(files, { level: 1 });
    expect(() => parseArchive(bomb)).toThrow(/too large when unpacked/);
  }, 30_000);

  it('limits the number of entries', () => {
    const files: Record<string, Uint8Array> = { 'level.json': level() };
    const empty = new Uint8Array(0);
    for (let i = 0; i < ARCHIVE_LIMITS.entries + 5; i++) files[`chunks/${i}.v2.bin`] = empty;
    expect(() => parseArchive(zipSync(files, { level: 0 }))).toThrow(/too many files/);
  });

  it('survives a zip whose headers lie about the uncompressed size', () => {
    const real = new Uint8Array(1_000_000);
    const zip = zipSync({ 'level.json': level(), 'icon.png': real }, { level: 9 });
    // Patch the declared uncompressed size of icon.png (central directory and local header) to 16 bytes.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let patched = 0;
    for (let i = 0; i < zip.length - 4; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x02014b50 && view.getUint32(i + 24, true) === real.length) { view.setUint32(i + 24, 16, true); patched++; }
      if (sig === 0x04034b50 && view.getUint32(i + 22, true) === real.length) { view.setUint32(i + 22, 16, true); patched++; }
    }
    expect(patched).toBeGreaterThan(0);
    let result: unknown;
    try { result = parseArchive(zip); } catch (e) { result = e; }
    // Either rejected, or the icon was cut short and dropped (not a PNG): never a 1 MB allocation passed on.
    if (result instanceof Error) expect(result).toBeInstanceOf(ArchiveError);
    else expect((result as { meta: WorldMeta }[])[0].meta.icon).toBeUndefined();
  });

  it('rejects chunk entries that point outside the chunk or have a bad length', () => {
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint32(0, ((40000 << 16) | 1) >>> 0, true);
    expect(() => parseArchive(zipSync({ 'level.json': level(), 'chunks/1.v2.bin': bad }))).toThrow(/damaged chunk/);
    expect(() => parseArchive(zipSync({ 'level.json': level(), 'chunks/1.v2.bin': new Uint8Array(3) }))).toThrow(/damaged chunk/);
  });

  it('sanitizes hostile meta values instead of trusting them', () => {
    const hostile = {
      name: '<img src=x onerror=alert(1)>', seed: 7, gameMode: 'god', worldType: 'evil', __proto__: { polluted: true },
    };
    const zip = zipSync({
      'level.json': level({}, hostile),
      'player.json': strToU8(JSON.stringify({ player: { x: 'a', y: 1e99, z: 0 }, hotbar: new Array(500).fill(1), inventory: new Array(99).fill([1]), selectedSlot: 99, evil: 1 })),
      'advancements.json': strToU8('[]'),
      'icon.png': strToU8('not a png'),
    });
    const [w] = parseArchive(zip);
    expect(w.meta.gameMode).toBeUndefined();
    expect(w.meta.worldType).toBeUndefined();
    expect(w.meta.hotbar).toEqual([]);
    expect(w.meta.inventory).toBeUndefined();
    expect(w.meta.selectedSlot).toBe(0);
    expect(w.meta.icon).toBeUndefined();
    expect(w.meta.player?.x).toBe(0);
    expect(w.meta.player?.y).toBe(64);
    expect(Object.keys(w.meta)).not.toContain('evil');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects an invalid seed and a non-object level', () => {
    expect(() => parseArchive(zipSync({ 'level.json': level({}, { seed: 'abc' }) }))).toThrow(ArchiveError);
    expect(() => parseArchive(zipSync({ 'level.json': strToU8('[1,2]') }))).toThrow(ArchiveError);
    expect(() => parseArchive(zipSync({ 'level.json': strToU8('{not json') }))).toThrow(/valid JSON/);
  });

  it('keeps encodeEdit-style v2 entries valid', () => {
    const entry = encodeEdit(32767, 0x0305);
    const chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, entry, true);
    const [w] = parseArchive(zipSync({ 'level.json': level(), 'chunks/9.v2.bin': chunk }));
    expect(w.records[0].data[0]).toBe(entry);
  });
});

describe('safeFileName', () => {
  it('produces portable names', () => {
    expect(safeFileName('My World!')).toBe('My-World');
    expect(safeFileName('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(safeFileName('???')).toBe('world');
  });
});
