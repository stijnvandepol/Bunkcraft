import { type Unzipped, strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { GAME_MODES, type GameMode } from '../player/GameMode';
import {
  type ChunkEditRecord, EDIT_RECORD_VERSION, SAVE_VERSION, type PlayerSave, type WorldMeta, migrateMeta, newWorldId,
} from './SaveSystem';

/**
 * `.bunkworld` files: a zip with one singleplayer world.
 *
 *   level.json            format + version header and the world meta (name, seed, mode, time ...)
 *   player.json           player position, inventory, stats, hotbar
 *   advancements.json     earned advancements
 *   icon.png              the world list icon (optional)
 *   chunks/<key>.v<n>.bin sparse block edits of one chunk (little-endian Uint32 entries, record version n)
 *
 * A backup of several worlds is a plain zip of `.bunkworld` files. Everything read from a file
 * is untrusted: sizes are bounded before and after decompression, names are whitelisted and every
 * field is validated and copied (never spread) into the world meta.
 */

export const ARCHIVE_FORMAT = 'bunkworld';
/** Version of the archive layout itself (not of the save format inside it). */
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXTENSION = '.bunkworld';

export const ARCHIVE_LIMITS = {
  /** Size of the file itself. */
  fileBytes: 64 * 1024 * 1024,
  /** Entries in one zip (a world has one per edited chunk). */
  entries: 20000,
  /** Total uncompressed bytes of everything in one zip, nested archives included. */
  totalBytes: 192 * 1024 * 1024,
  jsonBytes: 256 * 1024,
  iconBytes: 128 * 1024,
  /** 16×16×128 blocks × 4 bytes: a chunk can never hold more edits than it has blocks. */
  chunkBytes: 16 * 16 * 128 * 4,
  /** Worlds in one backup. */
  worlds: 200,
} as const;

export class ArchiveError extends Error {}

const BLOCKS_PER_CHUNK = 16 * 16 * 128;
const CHUNK_NAME = /^chunks\/(\d{1,10})\.v(\d{1,3})\.bin$/;
const KNOWN_FILES = new Set(['level.json', 'player.json', 'advancements.json', 'icon.png']);

/** Allowed uncompressed size per entry of a world archive; 0 = not an allowed name. */
function worldEntryLimit(name: string): number {
  if (name === 'icon.png') return ARCHIVE_LIMITS.iconBytes;
  if (KNOWN_FILES.has(name)) return ARCHIVE_LIMITS.jsonBytes;
  return CHUNK_NAME.test(name) ? ARCHIVE_LIMITS.chunkBytes : 0;
}

// ---------------------------------------------------------------- writing

function chunkToBytes(data: Uint32Array): Uint8Array {
  const out = new Uint8Array(data.length * 4);
  const view = new DataView(out.buffer);
  data.forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}

function dataUrlToPng(url: string | undefined): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url ?? '');
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pngToDataUrl(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

/** Packs a world into the bytes of a `.bunkworld` file. */
export function buildWorldArchive(meta: WorldMeta, records: ChunkEditRecord[]): Uint8Array {
  const json = (v: unknown) => strToU8(JSON.stringify(v));
  const files: Record<string, Uint8Array> = {
    'level.json': json({
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_VERSION,
      saveVersion: meta.version ?? SAVE_VERSION,
      editRecordVersion: EDIT_RECORD_VERSION,
      exportedAt: Date.now(),
      meta: {
        id: meta.id, name: meta.name, seed: meta.seed, seedText: meta.seedText, created: meta.created,
        lastPlayed: meta.lastPlayed, time: meta.time, gameMode: meta.gameMode, spawn: meta.spawn, worldType: meta.worldType,
      },
    }),
    'player.json': json({
      player: meta.player, hotbar: meta.hotbar, selectedSlot: meta.selectedSlot, inventory: meta.inventory, stats: meta.stats,
    }),
    'advancements.json': json(meta.advancements ?? {}),
  };
  const icon = dataUrlToPng(meta.icon);
  if (icon) files['icon.png'] = icon;
  for (const r of records) files[`chunks/${r.chunkKey}.v${r.version ?? 1}.bin`] = chunkToBytes(r.data);
  // Chunk records are tiny and compress well; level 6 is plenty.
  return zipSync(files, { level: 6 });
}

/** A zip of several `.bunkworld` files. They are compressed already, so they are only stored. */
export function buildBackup(archives: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const a of archives) files[a.name] = a.bytes;
  return zipSync(files, { level: 0 });
}

/** A file name safe on every file system: "My World!" → "My-World". */
export function safeFileName(name: string): string {
  return name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'world';
}

// ---------------------------------------------------------------- reading

/** Shared between a backup and the worlds in it, so nesting cannot multiply the limits. */
interface Budget { entries: number; bytes: number }

/** `maxSize` returns the largest allowed uncompressed size of an entry, 0 for names that are not allowed. */
function unzipLimited(bytes: Uint8Array, budget: Budget, maxSize: (name: string) => number): Unzipped {
  if (bytes.length > ARCHIVE_LIMITS.fileBytes) throw new ArchiveError('This file is too large to be a BunkCraft world.');
  // Cheap signature check first: zips start with "PK".
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ArchiveError('This is not a .bunkworld file (not a zip archive).');
  try {
    const files = unzipSync(bytes, {
      // Runs on the central directory entries before anything is inflated.
      filter: (f) => {
        if (f.name.endsWith('/')) return false; // directory entry
        const max = maxSize(f.name);
        if (max === 0) throw new ArchiveError(`Unexpected file in archive: ${f.name.slice(0, 60)}`);
        if (f.originalSize > max) throw new ArchiveError(`${f.name.slice(0, 60)} is larger than allowed.`);
        if (++budget.entries > ARCHIVE_LIMITS.entries) throw new ArchiveError('The archive contains too many files.');
        budget.bytes += f.originalSize;
        if (budget.bytes > ARCHIVE_LIMITS.totalBytes) throw new ArchiveError('The archive is too large when unpacked.');
        return true;
      },
    });
    // The declared sizes could lie: check what actually came out.
    let actual = 0;
    for (const [name, data] of Object.entries(files)) {
      if (data.length > maxSize(name)) throw new ArchiveError(`${name.slice(0, 60)} is larger than allowed.`);
      actual += data.length;
    }
    if (actual > ARCHIVE_LIMITS.totalBytes) throw new ArchiveError('The archive is too large when unpacked.');
    return files;
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError('The archive is damaged and could not be read.');
  }
}

function parseJson(bytes: Uint8Array | undefined, what: string, required: boolean): unknown {
  if (!bytes) {
    if (required) throw new ArchiveError(`The archive has no ${what}.`);
    return undefined;
  }
  if (bytes.length > ARCHIVE_LIMITS.jsonBytes) throw new ArchiveError(`${what} is too large.`);
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new ArchiveError(`${what} is not valid JSON.`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, min: number, max: number, fallback?: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v;
  if (fallback !== undefined) return fallback;
  throw new ArchiveError('The archive contains an invalid number.');
}

function int(v: unknown, min: number, max: number, fallback?: number): number {
  return Math.floor(num(v, min, max, fallback));
}

function str(v: unknown, max: number, fallback?: string): string {
  if (typeof v === 'string' && v.length <= max) return v;
  if (fallback !== undefined) return fallback;
  throw new ArchiveError('The archive contains an invalid text.');
}

function intList(v: unknown, maxLen: number, min: number, max: number): number[] | undefined {
  if (!Array.isArray(v) || v.length > maxLen) return undefined;
  return v.map((n) => int(n, min, max, 0));
}

function sanitizePlayer(v: unknown): PlayerSave | null {
  if (!isObj(v)) return null;
  const limit = 30_000_000;
  return {
    x: num(v.x, -limit, limit, 0), y: num(v.y, -1000, 1000, 64), z: num(v.z, -limit, limit, 0),
    yaw: num(v.yaw, -1e6, 1e6, 0), pitch: num(v.pitch, -1e6, 1e6, 0), flying: v.flying === true,
  };
}

/** Validates the JSON parts and builds a WorldMeta from them (unknown fields are dropped). */
function buildMeta(level: unknown, playerJson: unknown, advJson: unknown, icon: Uint8Array | undefined): WorldMeta {
  if (!isObj(level) || level.format !== ARCHIVE_FORMAT) throw new ArchiveError('This is not a BunkCraft world archive.');
  const formatVersion = int(level.formatVersion, 0, 1e6, 0);
  if (formatVersion > ARCHIVE_VERSION) throw new ArchiveError('This world was exported by a newer BunkCraft. Update the game to import it.');
  const saveVersion = int(level.saveVersion, 0, 1e6, 0);
  if (saveVersion > SAVE_VERSION) throw new ArchiveError('This world was saved by a newer BunkCraft. Update the game to import it.');
  const m = level.meta;
  if (!isObj(m)) throw new ArchiveError('The archive has no world data.');

  const mode = typeof m.gameMode === 'string' && (GAME_MODES as string[]).includes(m.gameMode) ? (m.gameMode as GameMode) : undefined;
  const p = isObj(playerJson) ? playerJson : {};
  const meta: WorldMeta = {
    version: saveVersion,
    id: str(m.id, 64, '').replace(/[^\w-]/g, '') || newWorldId(),
    name: str(m.name, 64, 'Imported World').trim() || 'Imported World',
    seed: int(m.seed, -2147483648, 4294967295),
    seedText: str(m.seedText, 64, String(m.seed)),
    created: num(m.created, 0, 8.64e15, Date.now()),
    lastPlayed: num(m.lastPlayed, 0, 8.64e15, Date.now()),
    player: sanitizePlayer(p.player),
    hotbar: intList(p.hotbar, 9, 0, 65535) ?? [],
    selectedSlot: int(p.selectedSlot, 0, 8, 0),
    time: num(m.time, 0, 1e9, 0.08),
  };
  if (mode) meta.gameMode = mode;
  if (m.worldType === 'terrain' || m.worldType === 'arena') meta.worldType = m.worldType;
  if (isObj(m.spawn)) meta.spawn = { x: num(m.spawn.x, -3e7, 3e7, 0), y: num(m.spawn.y, -1000, 1000, 64), z: num(m.spawn.z, -3e7, 3e7, 0) };
  if (Array.isArray(p.inventory) && p.inventory.length <= 36) {
    meta.inventory = p.inventory.map((slot) => intList(slot, 3, 0, 1_000_000) ?? [0, 0, 0]);
  }
  const stats = Array.isArray(p.stats) && p.stats.length <= 8 ? p.stats.map((n) => num(n, -1e6, 1e6, 0)) : undefined;
  if (stats) meta.stats = stats;
  if (isObj(advJson)) {
    const entries = Object.entries(advJson);
    if (entries.length > 2000) throw new ArchiveError('The archive has too many advancements.');
    meta.advancements = {};
    for (const [k, v] of entries) if (k.length <= 100 && typeof v === 'number' && Number.isFinite(v)) meta.advancements[k] = v;
  }
  if (icon) {
    const isPng = icon.length >= 8 && icon[0] === 0x89 && icon[1] === 0x50 && icon[2] === 0x4e && icon[3] === 0x47;
    if (isPng && icon.length <= ARCHIVE_LIMITS.iconBytes) meta.icon = pngToDataUrl(icon);
  }
  return meta;
}

function parseChunk(name: string, bytes: Uint8Array): ChunkEditRecord {
  const m = CHUNK_NAME.exec(name)!;
  const chunkKey = Number(m[1]);
  const version = Number(m[2]);
  if (!Number.isSafeInteger(chunkKey) || chunkKey > 0xffffffff) throw new ArchiveError('The archive has an invalid chunk number.');
  if (version < 1 || version > EDIT_RECORD_VERSION) throw new ArchiveError('This world contains block data from a newer BunkCraft.');
  if (bytes.length % 4 !== 0 || bytes.length > ARCHIVE_LIMITS.chunkBytes) throw new ArchiveError('The archive has a damaged chunk.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < data.length; i++) {
    const packed = view.getUint32(i * 4, true);
    // v1: blockIndex << 8 | id; v2: blockIndex << 16 | state. Either way the index must exist in a chunk.
    const index = version >= 2 ? packed >>> 16 : packed >>> 8;
    if (index >= BLOCKS_PER_CHUNK) throw new ArchiveError('The archive has a damaged chunk.');
    data[i] = packed;
  }
  return { worldId: '', chunkKey, version, data };
}

export interface ParsedWorld {
  meta: WorldMeta;
  /** Records still carrying an empty worldId: the importer assigns the final world id. */
  records: ChunkEditRecord[];
}

function readWorld(bytes: Uint8Array, budget: Budget): ParsedWorld {
  const files = unzipLimited(bytes, budget, worldEntryLimit);
  const level = parseJson(files['level.json'], 'level.json', true);
  const meta = buildMeta(level, parseJson(files['player.json'], 'player.json', false), parseJson(files['advancements.json'], 'advancements.json', false), files['icon.png']);
  const records: ChunkEditRecord[] = [];
  for (const [name, data] of Object.entries(files)) if (name.startsWith('chunks/')) records.push(parseChunk(name, data));
  // Older worlds are brought up to the current save version here, like when they are loaded from disk.
  migrateMeta(meta);
  return { meta, records };
}

/**
 * Reads a `.bunkworld` file, or a backup zip with several of them.
 * Throws ArchiveError with a player-readable message for anything that is not a valid world.
 */
export function parseArchive(bytes: Uint8Array): ParsedWorld[] {
  const budget: Budget = { entries: 0, bytes: 0 };
  if (bytes.length > ARCHIVE_LIMITS.fileBytes) throw new ArchiveError('This file is too large to be a BunkCraft world.');
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ArchiveError('This is not a .bunkworld file (not a zip archive).');
  // Peek at the entry names (nothing is inflated) to tell a world from a backup.
  let kind = null as 'world' | 'backup' | null;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (kind === null && !f.name.endsWith('/')) kind = f.name.endsWith(ARCHIVE_EXTENSION) ? 'backup' : worldEntryLimit(f.name) > 0 ? 'world' : null;
        return false;
      },
    });
  } catch {
    throw new ArchiveError('The archive is damaged and could not be read.');
  }
  if (kind === 'world') return [readWorld(bytes, budget)];
  if (kind === null) throw new ArchiveError('This file does not contain any BunkCraft worlds.');
  const outer = unzipLimited(bytes, budget, (n) => (/^[\w. -]{1,100}\.bunkworld$/.test(n) ? ARCHIVE_LIMITS.fileBytes : 0));
  const names = Object.keys(outer);
  if (names.length === 0 || names.length > ARCHIVE_LIMITS.worlds) throw new ArchiveError('This backup contains no worlds or too many.');
  return names.map((n) => readWorld(outer[n], budget));
}
