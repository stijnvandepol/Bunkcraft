import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EDIT_RECORD_VERSION, SAVE_VERSION, SaveSystem, type WorldMeta, decodeEdit, encodeEdit, migrateMeta, newWorldId,
} from '../src/save/SaveSystem';
import { GEN_VERSION_CURRENT, GEN_VERSION_LEGACY } from '../src/world/GenVersion';
import type { EditMap } from '../src/world/World';

function meta(over: Partial<WorldMeta> = {}): WorldMeta {
  return {
    id: newWorldId(), name: 'Test', seed: 42, seedText: '42', created: 1, lastPlayed: 1,
    player: null, hotbar: [1, 2, 3], selectedSlot: 0, time: 0.1, ...over,
  };
}

async function openSystem(): Promise<SaveSystem> {
  const s = new SaveSystem();
  await s.open();
  expect(s.persistent).toBe(true);
  return s;
}

/** Writes a raw record into a store, like another (older or newer) build would have. */
async function putRaw(store: 'worlds' | 'chunks', record: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const req = indexedDB.open('bunkcraft', 2);
    req.onsuccess = () => resolve(req.result);
  });
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(record);
  await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
  db.close();
}

beforeEach(() => {
  // A fresh in-memory database for every test.
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

describe('SaveSystem', () => {
  it('saves, lists and deletes worlds', async () => {
    const s = await openSystem();
    const a = meta({ name: 'A', lastPlayed: 10 });
    const b = meta({ name: 'B', lastPlayed: 20 });
    await s.saveWorld(a);
    await s.saveWorld(b);
    expect((await s.listWorlds()).map((w) => w.name)).toEqual(['B', 'A']);
    await s.deleteWorld(b.id);
    expect((await s.listWorlds()).map((w) => w.name)).toEqual(['A']);
  });

  it('stamps the current version on save', async () => {
    const s = await openSystem();
    await s.saveWorld(meta());
    expect((await s.listWorlds())[0].version).toBe(SAVE_VERSION);
  });

  it('persists across reopening the database', async () => {
    const s1 = await openSystem();
    await s1.saveWorld(meta({ name: 'Persisted' }));
    const s2 = await openSystem();
    expect((await s2.listWorlds())[0].name).toBe('Persisted');
  });

  it('migrates a legacy world (no version) when listing', async () => {
    const s = await openSystem();
    const legacy = meta({ name: 'Legacy' });
    delete legacy.version;
    await putRaw('worlds', legacy);
    const list = await s.listWorlds();
    expect(list[0].name).toBe('Legacy');
    expect(list[0].version).toBe(SAVE_VERSION);
  });

  it('puts worlds saved before generator versioning on generator version 1', async () => {
    const s = await openSystem();
    const legacy = meta({ name: 'Old', version: 2 });
    delete legacy.genVersion;
    await putRaw('worlds', legacy);
    const list = await s.listWorlds();
    expect(list[0].genVersion).toBe(GEN_VERSION_LEGACY);
    expect(list[0].version).toBe(SAVE_VERSION);
    // The migrated meta is what gets saved back, so the version sticks.
    await s.saveWorld(list[0]);
    expect((await (await openSystem()).listWorlds())[0].genVersion).toBe(GEN_VERSION_LEGACY);
  });

  it('keeps the generator version of a new world through save and reload', async () => {
    const s = await openSystem();
    await s.saveWorld(meta({ name: 'Fresh', genVersion: GEN_VERSION_CURRENT }));
    expect((await s.listWorlds())[0].genVersion).toBe(GEN_VERSION_CURRENT);
  });

  it('round-trips sparse chunk edits and only writes dirty chunks', async () => {
    const s = await openSystem();
    const m = meta();
    await s.saveWorld(m);
    const edits: EditMap = new Map([
      [100, new Map([[5, 7], [4096, 12]])],
      [200, new Map([[9, 3]])],
    ]);
    const dirty = new Set([100, 200]);
    await s.saveEdits(m.id, edits, dirty);
    expect(dirty.size).toBe(0);

    // Only chunk 100 changes now; chunk 200 is not dirty, so its new edit must not be written.
    edits.get(100)!.set(6, 1);
    edits.get(200)!.set(10, 99);
    await s.saveEdits(m.id, edits, new Set([100]));

    const loaded = await s.loadEdits(m.id);
    expect([...loaded.get(100)!.entries()].sort((a, b) => a[0] - b[0])).toEqual([[5, 7], [6, 1], [4096, 12]]);
    expect([...loaded.get(200)!.entries()]).toEqual([[9, 3]]);
  });

  it('keeps edits per world and removes them with the world', async () => {
    const s = await openSystem();
    const a = meta(), b = meta();
    await s.saveWorld(a);
    await s.saveWorld(b);
    await s.saveEdits(a.id, new Map([[1, new Map([[1, 1]])]]), new Set([1]));
    await s.saveEdits(b.id, new Map([[1, new Map([[2, 2]])]]), new Set([1]));
    expect([...(await s.loadEdits(a.id)).get(1)!]).toEqual([[1, 1]]);
    await s.deleteWorld(a.id);
    expect((await s.loadEdits(a.id)).size).toBe(0);
    expect((await s.loadEdits(b.id)).size).toBe(1);
  });

  it('loads edit records saved before versioning', async () => {
    const s = await openSystem();
    const m = meta();
    await s.saveWorld(m);
    await putRaw('chunks', { worldId: m.id, chunkKey: 3, data: new Uint32Array([(5 << 8) | 9]) });
    expect([...(await s.loadEdits(m.id)).get(3)!]).toEqual([[5, 9]]);
  });

  it('reads version 1 records (no state byte) and writes version 2 with meta', async () => {
    const s = await openSystem();
    const m = meta();
    await s.saveWorld(m);
    // v1: blockIndex << 8 | id, the highest possible index included.
    await putRaw('chunks', { worldId: m.id, chunkKey: 4, version: 1, data: new Uint32Array([(32767 << 8) | 9]) });
    expect([...(await s.loadEdits(m.id)).get(4)!]).toEqual([[32767, 9]]);

    const edits: EditMap = new Map([[5, new Map([[32767, 44 | (3 << 8)], [0, 1 | (255 << 8)], [77, 0]])]]);
    await s.saveEdits(m.id, edits, new Set([5]));
    const loaded = (await s.loadEdits(m.id)).get(5)!;
    expect([...loaded.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 1 | (255 << 8)], [77, 0], [32767, 44 | (3 << 8)]]);
  });

  it('encodes and decodes edit entries per record version', () => {
    expect(decodeEdit(encodeEdit(1234, 12 | (5 << 8)), 2)).toEqual([1234, 12 | (5 << 8)]);
    expect(decodeEdit((1234 << 8) | 12, 1)).toEqual([1234, 12]);
    expect(encodeEdit(32767, 0xffff)).toBe(0x7fffffff);
  });

  it('skips edit records written by a newer format', async () => {
    const s = await openSystem();
    const m = meta();
    await s.saveWorld(m);
    await putRaw('chunks', { worldId: m.id, chunkKey: 7, version: EDIT_RECORD_VERSION + 1, data: new Uint32Array([1]) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await s.loadEdits(m.id)).size).toBe(0);
  });

  it('falls back to memory without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const s = new SaveSystem();
    await s.open();
    expect(s.persistent).toBe(false);
    await s.saveWorld(meta({ name: 'Mem' }));
    expect((await s.listWorlds())[0].name).toBe('Mem');
  });
});

describe('migrateMeta', () => {
  it('upgrades from 0 and is idempotent', () => {
    const m = meta();
    delete m.version;
    migrateMeta(m);
    expect(m.version).toBe(SAVE_VERSION);
    migrateMeta(m);
    expect(m.version).toBe(SAVE_VERSION);
  });

  it('stamps genVersion 1 on unversioned worlds but never overwrites an existing one', () => {
    const old = meta();
    delete old.version;
    migrateMeta(old);
    expect(old.genVersion).toBe(1);
    const fresh = meta({ genVersion: GEN_VERSION_CURRENT });
    delete fresh.version;
    migrateMeta(fresh);
    expect(fresh.genVersion).toBe(GEN_VERSION_CURRENT);
  });

  it('leaves worlds from a newer game untouched', () => {
    const m = meta({ version: SAVE_VERSION + 5 });
    migrateMeta(m);
    expect(m.version).toBe(SAVE_VERSION + 5);
  });
});
