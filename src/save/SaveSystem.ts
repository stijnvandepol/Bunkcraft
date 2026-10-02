import type { GameMode } from '../player/GameMode';
import type { ImportedPack } from '../rendering/TexturePacks';
import type { EditMap } from '../world/World';

export interface PlayerSave {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  flying: boolean;
}

/** Format version of saved worlds. Bump together with a new entry in MIGRATIONS. */
export const SAVE_VERSION = 1;

export interface WorldMeta {
  /** Save format version; absent on worlds saved before versioning (treated as 0). */
  version?: number;
  id: string;
  name: string;
  seed: number;
  seedText: string;
  created: number;
  lastPlayed: number;
  player: PlayerSave | null;
  hotbar: number[];
  selectedSlot: number;
  time: number;
  /** 64×64 PNG data URL screenshot shown in the world list. */
  icon?: string;
  gameMode?: GameMode;
  /** Survival inventory: [id, count, damage] per slot. */
  inventory?: number[][];
  /** [health, hunger, saturation, exhaustion, air] */
  stats?: number[];
  /** World spawn / respawn point. */
  spawn?: { x: number; y: number; z: number };
}

interface ChunkEditRecord {
  worldId: string;
  chunkKey: number;
  /** Record format; absent on records saved before versioning (same layout as version 1). */
  version?: number;
  /** Packed entries: blockIndex << 8 | blockId. */
  data: Uint32Array;
}

/** Version of the chunk edit records written by saveEdits(); loadEdits() decodes by record version. */
export const EDIT_RECORD_VERSION = 1;

/**
 * Migration hooks: MIGRATIONS[n] upgrades world metadata from version n to n + 1, in place.
 * Add one per format change (for example block states) and bump SAVE_VERSION.
 */
export const MIGRATIONS: ((meta: WorldMeta) => void)[] = [
  // 0 → 1: worlds saved before versioning have the same layout, they only get stamped.
  () => {},
];

/** Brings world metadata up to SAVE_VERSION. Worlds from a newer game are left untouched. */
export function migrateMeta(meta: WorldMeta): WorldMeta {
  let v = typeof meta.version === 'number' ? meta.version : 0;
  while (v < SAVE_VERSION) {
    MIGRATIONS[v](meta);
    meta.version = ++v;
  }
  return meta;
}

const DB_NAME = 'bunkcraft';
const DB_VERSION = 2;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * IndexedDB persistence. World metadata and player edits live in separate stores;
 * edits are stored sparsely per chunk (only changed blocks), so saves stay tiny no
 * matter how far the player explores. Falls back to memory if IndexedDB is blocked.
 */
export class SaveSystem {
  private db: IDBDatabase | null = null;
  private readonly memory = new Map<string, WorldMeta>();
  private readonly memoryPacks = new Map<string, ImportedPack>();

  async open(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['worldId', 'chunkKey'] });
          // Resource packs the player imported from their own files (kept only in this browser).
          if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        // Another tab holds an older version open: don't hang the game forever.
        req.onblocked = () => reject(new Error('Database blocked by another BunkCraft tab'));
      });
      this.db.onversionchange = () => this.db?.close();
    } catch (e) {
      console.warn('IndexedDB unavailable, worlds will not persist', e);
      this.db = null;
    }
  }

  async listWorlds(): Promise<WorldMeta[]> {
    const list = this.db
      ? await promisify(this.db.transaction('worlds').objectStore('worlds').getAll() as IDBRequest<WorldMeta[]>)
      : [...this.memory.values()];
    for (const meta of list) migrateMeta(meta);
    return list.sort((a, b) => b.lastPlayed - a.lastPlayed);
  }

  async saveWorld(meta: WorldMeta): Promise<void> {
    migrateMeta(meta);
    if (!this.db) { this.memory.set(meta.id, meta); return; }
    const tx = this.db.transaction('worlds', 'readwrite');
    tx.objectStore('worlds').put(meta);
    await done(tx);
  }

  async deleteWorld(id: string): Promise<void> {
    if (!this.db) { this.memory.delete(id); return; }
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    tx.objectStore('worlds').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
    await done(tx);
  }

  async loadEdits(worldId: string): Promise<EditMap> {
    const edits: EditMap = new Map();
    if (!this.db) return edits;
    const records = await promisify(
      this.db.transaction('chunks').objectStore('chunks').getAll(IDBKeyRange.bound([worldId, -Infinity], [worldId, Infinity])) as IDBRequest<ChunkEditRecord[]>,
    );
    for (const r of records) {
      if ((r.version ?? 1) > EDIT_RECORD_VERSION) {
        console.warn(`Skipping chunk ${r.chunkKey}: saved by a newer BunkCraft (record v${r.version})`);
        continue;
      }
      const m = new Map<number, number>();
      for (const packed of r.data) m.set(packed >>> 8, packed & 255);
      edits.set(r.chunkKey, m);
    }
    return edits;
  }

  /** Writes only the chunks whose edits changed since the last save. */
  async saveEdits(worldId: string, edits: EditMap, dirty: Set<number>): Promise<void> {
    if (!this.db || dirty.size === 0) return;
    // Only forget the dirty set once the transaction has committed; on failure the
    // chunks stay dirty and are retried on the next save.
    const keys = [...dirty];
    dirty.clear();
    const tx = this.db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    for (const key of keys) {
      const m = edits.get(key);
      if (!m) continue;
      const data = new Uint32Array(m.size);
      let i = 0;
      for (const [idx, id] of m) data[i++] = (idx << 8) | id;
      const record: ChunkEditRecord = { worldId, chunkKey: key, version: EDIT_RECORD_VERSION, data };
      store.put(record);
    }
    try {
      await done(tx);
    } catch (e) {
      for (const k of keys) dirty.add(k);
      throw e;
    }
  }

  async listPacks(): Promise<ImportedPack[]> {
    if (!this.db) return [...this.memoryPacks.values()];
    const packs = await promisify(this.db.transaction('packs').objectStore('packs').getAll() as IDBRequest<ImportedPack[]>);
    return packs.sort((a, b) => a.created - b.created);
  }

  async getPack(id: string): Promise<ImportedPack | undefined> {
    if (!this.db) return this.memoryPacks.get(id);
    return promisify(this.db.transaction('packs').objectStore('packs').get(id) as IDBRequest<ImportedPack | undefined>);
  }

  async savePack(pack: ImportedPack): Promise<void> {
    if (!this.db) { this.memoryPacks.set(pack.id, pack); return; }
    const tx = this.db.transaction('packs', 'readwrite');
    tx.objectStore('packs').put(pack);
    await done(tx);
  }

  async deletePack(id: string): Promise<void> {
    if (!this.db) { this.memoryPacks.delete(id); return; }
    const tx = this.db.transaction('packs', 'readwrite');
    tx.objectStore('packs').delete(id);
    await done(tx);
  }

  get persistent(): boolean {
    return this.db !== null;
  }
}

export function newWorldId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
