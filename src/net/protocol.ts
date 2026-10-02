import type { GameMode } from '../player/GameMode';

/**
 * Multiplayer protocol (JSON over one WebSocket at /ws). Shared by the browser client
 * and the Node server so both sides agree on every message shape.
 *
 * Terrain is generated from the seed on every client, so only player edits travel over
 * the network. Movement is client-predicted and sanity-checked by the server; block
 * edits are applied optimistically and confirmed or rolled back by the server.
 */
export const PROTOCOL_VERSION = 2;

/** Mob kinds in network order (index in entity snapshots). */
export const NET_MOB_KINDS = ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'creeper', 'skeleton', 'spider'] as const;
export type NetMobKind = typeof NET_MOB_KINDS[number];

/** Saved per player on the server (by name). */
export interface PlayerRecord {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  inventory?: number[][];
  stats?: number[];
}

export interface RemotePlayerInfo {
  id: number;
  name: string;
}

/** Snapshot entry: [id, x, y, z, yaw, pitch, flags, heldItem]. flags: 1 sprinting, 2 flying, 4 on ground. */
export type SnapshotEntry = [number, number, number, number, number, number, number, number];

/** Mob snapshot: [id, kind, x, y, z, yaw, headYaw, headPitch, flags, hurtTime, fuse, deathTime]. flags: 1 on ground, 2 burning, 4 dead. */
export type MobEntry = [number, number, number, number, number, number, number, number, number, number, number, number];
/** Dropped item: [id, itemId, count, x, y, z]. */
export type ItemEntry = [number, number, number, number, number, number];
/** Arrow: [id, x, y, z, yaw, pitch, inGround]. */
export type ArrowEntry = [number, number, number, number, number, number, number];
/** Lit TNT: [id, x, y, z, fuse]. */
export type TntEntry = [number, number, number, number, number];

// ---------------------------------------------------------------- client → server

export type ClientMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'pos'; x: number; y: number; z: number; yaw: number; pitch: number; flags: number; held: number }
  | { t: 'block'; seq: number; x: number; y: number; z: number; id: number }
  | { t: 'chat'; text: string }
  | { t: 'state'; inventory: number[][]; stats: number[] }
  /** Melee hit on a server mob (damage comes from the held item the server knows). */
  | { t: 'attack'; id: number }
  /** Bow shot; power 0..1. */
  | { t: 'shoot'; x: number; y: number; z: number; dx: number; dy: number; dz: number; power: number }
  /** Flint and steel on a TNT block. */
  | { t: 'ignite'; x: number; y: number; z: number }
  /** Pick up a dropped item entity. */
  | { t: 'take'; id: number }
  /** Drop an item into the world (block drops, Q, death); yaw = throw direction. */
  | { t: 'drop'; id: number; count: number; damage?: number; x: number; y: number; z: number; yaw?: number; delay?: number };

// ---------------------------------------------------------------- server → client

export type ServerMessage =
  | {
    t: 'welcome'; id: number; worldName: string; seed: number; gameMode: GameMode; time: number;
    spawn: { x: number; y: number; z: number };
    /** Flat list of edits: x, y, z, id, x, y, z, id, … */
    edits: number[];
    player: PlayerRecord | null;
    players: RemotePlayerInfo[];
    motd: string;
  }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number; name: string }
  | { t: 'snap'; players: SnapshotEntry[] }
  | { t: 'block'; x: number; y: number; z: number; id: number }
  | { t: 'reject'; seq: number; x: number; y: number; z: number; id: number }
  | { t: 'chat'; from: string; text: string; system?: boolean }
  | { t: 'time'; time: number }
  | { t: 'teleport'; x: number; y: number; z: number }
  | { t: 'kick'; reason: string }
  /** Entities around the player (10 Hz). Lists replace what the client knows. */
  | { t: 'ent'; m: MobEntry[]; i: ItemEntry[]; a: ArrowEntry[]; b: TntEntry[] }
  /** A mob or arrow hurt this player. */
  | { t: 'hurt'; amount: number; cause: 'mob' | 'arrow'; by: string; yaw: number }
  /** An explosion: destroyed blocks as x, y, z triples; the client plays effects and takes its own damage. */
  | { t: 'boom'; x: number; y: number; z: number; power: number; by: string; water: boolean; blocks: number[] }
  | { t: 'msound'; kind: string; event: 'idle' | 'hurt' | 'death' | 'fuse' | 'arrow'; x: number; y: number; z: number }
  /** The requested item entity is yours. */
  | { t: 'taken'; id: number; itemId: number; count: number; damage?: number };

/** No 0/O/1/I/L: game codes are read aloud and typed on phones. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Normalises user input ("bunk-k7qm2x", " k7qm2x ", an invite link) to a code, or null. */
export function normalizeCode(raw: string): string | null {
  const fromLink = /[?&]join=([^&#\s]+)/i.exec(raw)?.[1] ?? raw;
  const code = fromLink.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BUNK/, '');
  return CODE_PATTERN.test(code) ? code : null;
}

/** "K7QM2X" → "K7Q-M2X": easier to read and say. */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export function sanitizeChat(text: string): string {
  // Strip control characters and cap the length; rendering always uses textContent.
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
}
