import type { GameType, Team } from '../modes/GameTypes';
import type { GameMode } from '../player/GameMode';

/**
 * Multiplayer protocol (JSON over one WebSocket at /ws). Shared by the browser client
 * and the Node server so both sides agree on every message shape.
 *
 * Terrain is generated from the seed on every client, so only player edits travel over
 * the network. Movement is client-predicted and sanity-checked by the server; block
 * edits are applied optimistically and confirmed or rolled back by the server.
 */
export const PROTOCOL_VERSION = 4;

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
  /** Arcade game types only. */
  team?: Team;
}

/** One row of the scoreboard (arcade game types). */
export interface RosterEntry {
  id: number;
  name: string;
  team: Team | '';
  kills: number;
  deaths: number;
  /** Round-trip time in ms as measured by the server, 0 if unknown. */
  ping: number;
}

export type MatchPhase = 'warmup' | 'live' | 'ended';

/** Settings the server announces for an arcade game. */
export interface MatchInfo {
  type: GameType;
  scoreLimit: number;
  timeLimitSec: number;
  /** Arena map of the running match (a MapId); absent on servers from before the maps = the classic map. */
  map?: string;
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
  /** `meta` is the block state byte (see BlockStates); absent = 0. */
  | { t: 'block'; seq: number; x: number; y: number; z: number; id: number; meta?: number }
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
  /** Arcade: choose the primary weapon for the next life (rifle, smg, shotgun, sniper). */
  | { t: 'loadout'; primary: string }
  /** Arcade: fire the weapon in a slot. Origin is the client's eye, dir the aim; the server re-checks both. */
  | { t: 'fire'; slot: 0 | 1 | 2; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; ads: boolean }
  /** Arcade: start reloading the weapon in a slot. */
  | { t: 'reload'; slot: 0 | 1 | 2 }
  /** Arcade: switch weapon slot (so everyone sees what you hold). */
  | { t: 'weapon'; slot: 0 | 1 | 2 }
  /** Drop an item into the world (block drops, Q, death); yaw = throw direction. */
  | { t: 'drop'; id: number; count: number; damage?: number; data?: number[]; x: number; y: number; z: number; yaw?: number; delay?: number };

// ---------------------------------------------------------------- server → client

export type ServerMessage =
  | {
    t: 'welcome'; id: number; worldName: string; seed: number; gameMode: GameMode; time: number;
    /** Game type of this game; "minecraft" unless it is an arcade game. */
    gameType: GameType;
    /** "terrain" = generated landscape, "arena" = the fixed arcade map. */
    worldType: 'terrain' | 'arena';
    /** Arcade games: match settings. */
    match?: MatchInfo;
    spawn: { x: number; y: number; z: number };
    /** Flat list of edits: x, y, z, id, meta, x, y, z, id, meta, … */
    edits: number[];
    player: PlayerRecord | null;
    players: RemotePlayerInfo[];
    motd: string;
  }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number; name: string }
  | { t: 'snap'; players: SnapshotEntry[] }
  | { t: 'block'; x: number; y: number; z: number; id: number; meta?: number }
  /** Many block changes at once (flowing water and lava): x, y, z, id, meta, x, y, z, id, meta, … */
  | { t: 'blocks'; edits: number[] }
  /** The edit was refused (echoes the request; the client restores the block it remembers). */
  | { t: 'reject'; seq: number; x: number; y: number; z: number; id: number; meta?: number }
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
  // ---- arcade game types ----
  /** Match state, about once a second and on every change. `scores` is team kills (tdm) or empty (ffa). */
  | { t: 'match'; phase: MatchPhase; timeLeft: number; scores: { red: number; blue: number }; info: MatchInfo }
  /** Who is on which team plus kills/deaths; sent on joins, leaves, kills and every few seconds. */
  | { t: 'roster'; players: RosterEntry[] }
  /** You (re)spawn: position, facing, team, loadout and full health. */
  | { t: 'spawn'; x: number; y: number; z: number; yaw: number; team: Team | ''; primary: string; health: number }
  /** Your health changed (damage, regeneration). */
  | { t: 'hp'; health: number }
  /** Your ammo is authoritative: magazine, spare bullets are unlimited, reloading flag per slot. */
  | { t: 'ammo'; slot: 0 | 1 | 2; mag: number; reloading: boolean }
  /** Someone fired: draw tracer and play sound. `end` is where the bullet stopped. */
  | { t: 'shot'; id: number; weapon: string; ox: number; oy: number; oz: number; ex: number; ey: number; ez: number }
  /** Your shot hit a player: hit marker, damage dealt, headshot, and whether it killed. */
  | { t: 'hit'; victim: number; damage: number; head: boolean; killed: boolean }
  /** You took damage from `from` at direction (dx, dz) relative to the world. */
  | { t: 'damaged'; from: number; damage: number; dx: number; dz: number }
  /** Kill feed entry (also tells everyone a player is down until the next spawn). */
  | { t: 'kill'; killer: number; victim: number; weapon: string; head: boolean }
  /** The match ended; a new one starts after `restartIn` seconds. winner: team, a player id or 0 for a draw. */
  | { t: 'matchend'; winnerTeam: Team | ''; winnerId: number; restartIn: number }
  /** A weapon slot a remote player holds (third-person model). */
  | { t: 'holds'; id: number; weapon: string }
  /** The requested item entity is yours. */
  | { t: 'taken'; id: number; itemId: number; count: number; damage?: number; data?: number[] };

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
