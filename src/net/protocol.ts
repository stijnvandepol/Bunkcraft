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

/** Mob kinds in network order (index in entity snapshots). APPEND-ONLY. */
export const NET_MOB_KINDS = ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'creeper', 'skeleton', 'spider',
  'wolf', 'enderman', 'slime', 'drowned', 'husk', 'stray', 'cave_spider', 'witch', 'horse'] as const;

/** Mob snapshot flag bits (MobEntry index 8). */
export const MOB_FLAG = { GROUND: 1, BURNING: 2, DEAD: 4, BABY: 8, SITTING: 16, TAMED: 32, ANGRY: 64, BUSY: 128 } as const;

/** Right-click outcomes (see entities/MobInteraction.ts UseResult). */
export type UseAction = 'none' | 'feed' | 'tame' | 'tame_fail' | 'sit' | 'stand' | 'shear' | 'milk' | 'dye' | 'saddle' | 'mount';
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

/**
 * Mob snapshot: [id, kind, x, y, z, yaw, headYaw, headPitch, flags, hurtTime, fuse, deathTime]. flags: MOB_FLAG bits.
 * `fuse` is the creeper fuse for creepers and the kind's `variant` byte for every other kind (sheep colour and
 * shorn bit, slime size, collar colour, horse coat with the saddle in bit 4).
 */
export type MobEntry = [number, number, number, number, number, number, number, number, number, number, number, number];
/** Dropped item: [id, itemId, count, x, y, z]. */
export type ItemEntry = [number, number, number, number, number, number];
/** Arrow: [id, x, y, z, yaw, pitch, inGround]. */
export type ArrowEntry = [number, number, number, number, number, number, number];
/** Falling block: [id, block id, block state, x, y, z]. */
export type FallEntry = [number, number, number, number, number, number];
/** Lit TNT: [id, x, y, z, fuse]. */
export type TntEntry = [number, number, number, number, number];

// ---------------------------------------------------------------- client → server

/**
 * Containers (chests, furnaces). The server owns their contents. A client opens one (`open`), the server replies with
 * the contents and from then on sends `slots` whenever they change (also by other players). Every `click` carries the
 * player's inventory rows and the stack on the cursor, because the inventory is client-owned: the server checks them
 * with the inventory guard, applies the click to its container and answers with `result` (the new cursor and, for a
 * shift-click, the items that move into or out of the inventory). Slots are `[id, count, damage, ...data]` rows, an
 * empty slot is `[]`. Double chests are one container of 54 slots addressed by either half.
 */
export type ContainerKindName = 'chest' | 'furnace';

export type ContainerClientMessage =
  | { t: 'container'; op: 'open'; x: number; y: number; z: number }
  | { t: 'container'; op: 'close' }
  /**
   * `slot` is the container slot (0-based); for a shift-click that deposits from the inventory it is -1 and `from` is
   * the inventory slot. `inv` is the inventory as `state` sends it (36 + 4 armor rows), `cursor` the stack on the cursor.
   */
  | { t: 'container'; op: 'click'; seq: number; slot: number; button: 0 | 1; shift?: boolean; from?: number; inv: number[][]; cursor: number[] };

export type ContainerServerMessage =
  /** The container opened: `props` is [burnTime, burnTotal, cookTime, cookTotal] for a furnace. */
  | { t: 'container'; op: 'open'; x: number; y: number; z: number; kind: ContainerKindName; title: string; slots: number[][]; props?: number[] }
  /** The container could not be opened (too far, not a container, too many opened). */
  | { t: 'container'; op: 'deny'; x: number; y: number; z: number; reason: string }
  /** New contents of the container you have open. */
  | { t: 'container'; op: 'slots'; slots: number[][]; props?: number[] }
  /**
   * Answer to a `click`: `ok` false means the server refused it (the client resets its cursor to `cursor`). `toInv`
   * is a stack to add to the inventory, `fromInv` items to take out of an inventory slot, `xp` experience from a furnace.
   */
  | { t: 'container'; op: 'result'; seq: number; ok: boolean; cursor: number[]; toInv?: number[]; fromInv?: { slot: number; count: number }; xp?: number }
  /** The container is gone (broken) or you walked away: close the screen. */
  | { t: 'container'; op: 'close'; reason?: string };

export type ClientMessage =
  /**
   * Optional fields (older clients leave them out): `key` is a random per-browser secret that binds the
   * name to this player, `owner` the token POST /api/rooms returned to the creator (grants op),
   * `password` the room password, `bin` asks for binary snap/ent frames (see binary.ts).
   */
  | { t: 'hello'; v: number; name: string; key?: string; owner?: string; password?: string; bin?: boolean }
  | { t: 'pos'; x: number; y: number; z: number; yaw: number; pitch: number; flags: number; held: number }
  /** `meta` is the block state byte (see BlockStates); absent = 0. */
  | { t: 'block'; seq: number; x: number; y: number; z: number; id: number; meta?: number }
  | { t: 'chat'; text: string }
  | { t: 'state'; inventory: number[][]; stats: number[] }
  /** Melee hit on a server mob (damage comes from the held item the server knows). */
  | { t: 'attack'; id: number }
  /** Right click on a server mob with the held item (feed, tame, shear, milk, dye, saddle). */
  | { t: 'usemob'; id: number }
  /** Bow shot; power 0..1. */
  | { t: 'shoot'; x: number; y: number; z: number; dx: number; dy: number; dz: number; power: number }
  /** Flint and steel on a TNT block. */
  | { t: 'ignite'; x: number; y: number; z: number }
  /** Pick up a dropped item entity. */
  | { t: 'take'; id: number }
  /** Bone meal used on a block (the server grows the sapling or grass). Optional: older servers ignore it. */
  | { t: 'bonemeal'; x: number; y: number; z: number }
  /** Arcade: choose the primary weapon for the next life (rifle, smg, shotgun, sniper). */
  | { t: 'loadout'; primary: string }
  /** Arcade: fire the weapon in a slot. Origin is the client's eye, dir the aim; the server re-checks both. */
  | { t: 'fire'; slot: 0 | 1 | 2; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; ads: boolean }
  /** Arcade: start reloading the weapon in a slot. */
  | { t: 'reload'; slot: 0 | 1 | 2 }
  /** Arcade: switch weapon slot (so everyone sees what you hold). */
  | { t: 'weapon'; slot: 0 | 1 | 2 }
  /** Drop an item into the world (block drops, Q, death); yaw = throw direction. */
  | { t: 'drop'; id: number; count: number; damage?: number; data?: number[]; x: number; y: number; z: number; yaw?: number; delay?: number }
  | ContainerClientMessage;

// ---------------------------------------------------------------- server → client

export type ServerMessage =
  | {
    t: 'welcome'; id: number; worldName: string; seed: number; gameMode: GameMode; time: number;
    /** Terrain generator version of the world (see src/world/GenVersion.ts). Absent (old servers) = 1. */
    genVersion?: number;
    /** Whole days played (moon phase); absent on servers from before the moon phases. */
    day?: number;
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
    /** You are an operator of this game (can use /kick, /ban, ...). Absent = no. */
    op?: boolean;
    /** The server will send snap and ent as binary frames (negotiated by `bin` in hello). */
    binary?: boolean;
    /** The server stores chests and furnaces and understands `container` messages. Absent on older servers. */
    containers?: boolean;
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
  /** `day` = whole days played; optional so older servers and clients keep working. */
  | { t: 'time'; time: number; day?: number }
  /**
   * Weather targets: rain and thunder 0 or 1 (the client fades over 5 s); `snap` jumps straight there
   * (sent on join). `ticksToChange` is informational. Optional message: old clients ignore it.
   */
  | { t: 'weather'; rain: number; thunder: number; ticksToChange?: number; snap?: boolean }
  /** A lightning strike on the ground at this position (everyone renders the same bolt and hears the thunder). */
  | { t: 'bolt'; x: number; y: number; z: number }
  | { t: 'teleport'; x: number; y: number; z: number }
  /** `reconnect`: the server is restarting; try again after this many milliseconds. `code` tells why for login failures. */
  | { t: 'kick'; reason: string; reconnect?: number; code?: 'password' | 'banned' | 'whitelist' | 'identity' | 'full' }
  /** The server corrected your inventory (it did not accept your last update); replace it. */
  | { t: 'state'; inventory: number[][]; reason?: string }
  /** The game mode of this game changed (/gamemode). */
  | { t: 'gamemode'; mode: GameMode }
  /** Entities around the player (10 Hz). Lists replace what the client knows. */
  | { t: 'ent'; m: MobEntry[]; i: ItemEntry[]; a: ArrowEntry[]; b: TntEntry[] }
  /** Falling sand and gravel around the player (10 Hz, only while there are any, plus one empty list). */
  | { t: 'fall'; f: FallEntry[] }
  /** A mob or arrow hurt this player. */
  | { t: 'hurt'; amount: number; cause: 'mob' | 'arrow'; by: string; yaw: number; poison?: number }
  /** The server applied a right click on a mob: what it costs the held stack (see entities/MobInteraction). */
  | { t: 'mobused'; action: UseAction; consume: number; give?: number; damageTool?: boolean }
  /** Hearts, smoke and similar over a mob. */
  | { t: 'mobfx'; id: number; fx: 'love' | 'smoke' | 'angry' | 'tame' | 'poof' }
  /** An explosion: destroyed blocks as x, y, z triples; the client plays effects and takes its own damage. */
  | { t: 'boom'; x: number; y: number; z: number; power: number; by: string; water: boolean; blocks: number[] }
  | { t: 'msound'; kind: string; event: 'idle' | 'hurt' | 'death' | 'fuse' | 'angry' | 'teleport' | 'arrow' | 'shoot'; x: number; y: number; z: number }
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
  | { t: 'taken'; id: number; itemId: number; count: number; damage?: number; data?: number[] }
  | ContainerServerMessage;

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
