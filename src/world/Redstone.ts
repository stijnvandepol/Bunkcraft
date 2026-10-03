import {
  BLOCK, BOX_KIND, CUBE_ID, OPAQUE, SHAPE, SHAPE_CROSS, SHAPE_DOOR, SHAPE_LIQUID, SHAPE_MODEL, getBlockDef,
} from './BlockRegistry';
import { DOOR_OPEN_BIT, isDoorUpper } from './BlockStates';
import { BOX_BED, BOX_GATE, BOX_LADDER, BOX_TRAPDOOR, GATE_OPEN_BIT, TRAPDOOR_OPEN_BIT } from './BoxShapes';
import { CHUNK_HEIGHT, chunkKey } from './constants';
import { topFaceSturdy } from './Placement';
import {
  DIR_X, DIR_Y, DIR_Z, DOWN, DUST_SIDE_BIT, DUST_UP_SHIFT, FACING_DIR, UP, dustArms,
} from './RedstoneShapes';

/**
 * Redstone, following Minecraft Java 1.21 where practical.
 *
 * Signal strength 0-15 lives in the state byte of dust. Sources are levers, buttons, pressure plates, redstone torches,
 * repeaters and blocks of redstone; consumers are redstone lamps, doors, trapdoors, fence gates, note blocks, TNT and
 * pistons. Powering follows Minecraft: a source gives *weak* power to the blocks around it and *strong* power to the one it
 * is attached to; a solid block that is strongly powered powers dust, repeaters, torches and consumers next to it.
 *
 * The simulation is pure: it works on a RedstoneGrid (the client's World in singleplayer, ServerWorld on a server, or a
 * fake in tests) and keeps its own queue of updates. Block changes arrive through `notify`; everything with a delay in
 * Minecraft (repeaters 2 game ticks per step, torches 2, lamps turning off 4, buttons 20/30, pistons 2) is a scheduled tick.
 * Dust itself has no delay: a whole connected network is solved at once (multi-source decay, 1 per block), which is what
 * newer Minecraft versions do too and avoids the old update-order artefacts.
 *
 * Budgets bound CPU and network use however large (or clocked) a contraption is: updates and block changes per tick, updates
 * per chunk per tick and the number of scheduled ticks. Whatever does not fit waits for the next tick. Torches that toggle too
 * fast burn out like in Minecraft (8 toggles in 60 ticks).
 */

export interface RedstoneGrid {
  /** Unloaded cells must read as BLOCK.UNLOADED. */
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  /** Change a block; the grid must call `RedstoneSim.notify` afterwards, like for any other edit. */
  setState(x: number, y: number, z: number, id: number, meta: number): void;
  /** Entities standing in the cell of a pressure plate (mobs and players; wooden plates also count dropped items). */
  entitiesOn?(x: number, y: number, z: number, oak: boolean): number;
}

// ---------------------------------------------------------------- tables

const REDSTONE_BLOCK = CUBE_ID.redstone_block;

/** Blocks whose behaviour depends on their neighbours: only these ever go into the update queue. */
const RELEVANT = new Uint8Array(256);
for (const id of [
  BLOCK.REDSTONE_WIRE, BLOCK.LEVER, BLOCK.BUTTON, BLOCK.PRESSURE_PLATE, BLOCK.REPEATER, BLOCK.REDSTONE_TORCH, BLOCK.REDSTONE_LAMP,
  BLOCK.REDSTONE_LAMP_LIT, BLOCK.NOTE_BLOCK, BLOCK.PISTON, BLOCK.STICKY_PISTON, BLOCK.PISTON_HEAD, BLOCK.TNT,
]) RELEVANT[id] = 1;
for (let id = 0; id < 256; id++) {
  if (SHAPE[id] === SHAPE_DOOR || BOX_KIND[id] === BOX_TRAPDOOR || BOX_KIND[id] === BOX_GATE) RELEVANT[id] = 1;
}

/** A block that carries power through itself: a full opaque cube (but not a block of redstone, which is a source). */
export function isConductor(id: number): boolean {
  return OPAQUE[id] === 1 && id !== BLOCK.UNLOADED && id !== REDSTONE_BLOCK;
}

/** Is `id` one of the blocks of this system (used by tests and the server to skip work in worlds without any)? */
export function isRedstoneBlock(id: number): boolean {
  return REDSTONE_IDS[id] === 1;
}
const REDSTONE_IDS = new Uint8Array(256);
for (const id of [
  BLOCK.REDSTONE_WIRE, BLOCK.LEVER, BLOCK.BUTTON, BLOCK.PRESSURE_PLATE, BLOCK.REPEATER, BLOCK.REDSTONE_TORCH, BLOCK.REDSTONE_LAMP,
  BLOCK.REDSTONE_LAMP_LIT, BLOCK.NOTE_BLOCK, BLOCK.PISTON, BLOCK.STICKY_PISTON, BLOCK.PISTON_HEAD, REDSTONE_BLOCK,
]) REDSTONE_IDS[id] = 1;

const WIRE = BLOCK.REDSTONE_WIRE;

// ---------------------------------------------------------------- state bits

export const LEVER_ON = 8;
export const BUTTON_PRESSED = 8;
export const BUTTON_OAK = 16;
export const PLATE_PRESSED = 1;
export const PLATE_OAK = 2;
export const REPEATER_POWERED = 16;
export const TORCH_OFF = 8;
export const NOTE_POWERED = 32;
export const NOTE_PITCHES = 25;
export const PISTON_EXTENDED = 8;
export const HEAD_STICKY = 8;

export const STONE_BUTTON_TICKS = 20;
export const OAK_BUTTON_TICKS = 30;
/** Repeater delay: (bits 2-3 of the state + 1) redstone ticks of 2 game ticks. */
export function repeaterDelay(meta: number): number {
  return (((meta >> 2) & 3) + 1) * 2;
}
export const TORCH_DELAY = 2;
export const LAMP_OFF_DELAY = 4;
export const PISTON_DELAY = 2;
export const PISTON_PUSH_LIMIT = 12;
/** A torch toggling this often within the window burns out (Minecraft: 8 in 60 ticks, back after 160). */
export const BURNOUT_TOGGLES = 8;
export const BURNOUT_WINDOW = 60;
export const BURNOUT_RESET = 160;

/** Updates per game tick, block changes per game tick, updates per chunk per tick and scheduled ticks kept at once. */
export const MAX_UPDATES_PER_TICK = 4000;
export const MAX_CHANGES_PER_TICK = 800;
export const MAX_UPDATES_PER_CHUNK = 2500;
export const MAX_PENDING = 50_000;
/** Dust blocks solved in one go (a bigger network is finished by the next pass). */
export const MAX_NETWORK = 2048;

const RING = 256;

/**
 * Small-integer key of a cell inside one dust network (11 bits of x and z, 7 of y): a network never spans 2048 blocks
 * (MAX_NETWORK), so it is unique there, and Smi keys keep the Map lookups cheap.
 */
function netKey(x: number, y: number, z: number): number {
  return ((x & 2047) << 18) | ((z & 2047) << 7) | y;
}

// ---------------------------------------------------------------- dust colour and use

/** Colour of dust at a signal strength (Minecraft's RedStoneWireBlock.COLORS), 0xRRGGBB. */
export function dustColor(power: number): number {
  const f = power / 15;
  const r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
  const g = Math.min(1, Math.max(0, f * f * 0.7 - 0.5));
  const b = Math.min(1, Math.max(0, f * f * 0.6 - 0.7));
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/** All 16 colours, for the mesher's hot loop. */
export const DUST_COLORS = Array.from({ length: 16 }, (_, p) => dustColor(p));

/**
 * What a right click does to a component: the new state byte, or null when it does nothing. Lever: toggle. Button:
 * press (the release is scheduled by the simulation). Repeater: one step longer delay. Note block: next pitch.
 */
export function useComponent(id: number, meta: number): number | null {
  switch (id) {
    case BLOCK.LEVER: return meta ^ LEVER_ON;
    case BLOCK.BUTTON: return (meta & BUTTON_PRESSED) ? null : meta | BUTTON_PRESSED;
    case BLOCK.REPEATER: return (meta & ~12) | ((((meta >> 2) & 3) + 1) & 3) << 2;
    case BLOCK.NOTE_BLOCK: return (meta & NOTE_POWERED) | (((meta & 31) + 1) % NOTE_PITCHES);
    default: return null;
  }
}

/** Does a right click on this block use it (instead of placing against it)? */
export function isUsableComponent(id: number): boolean {
  return id === BLOCK.LEVER || id === BLOCK.BUTTON || id === BLOCK.REPEATER || id === BLOCK.NOTE_BLOCK;
}

// ---------------------------------------------------------------- note blocks

export type NoteInstrument = 'harp' | 'basedrum' | 'snare' | 'hat' | 'bass' | 'guitar' | 'chime' | 'bell' | 'flute';

/** Instrument of a note block by what is under it (Minecraft's table, by material). */
export function noteInstrument(belowId: number): NoteInstrument {
  const sound = getBlockDef(belowId)?.sound;
  switch (sound) {
    case 'stone': case 'deepslate': return 'basedrum';
    case 'sand': case 'gravel': return 'snare';
    case 'glass': return 'hat';
    case 'wood': return 'bass';
    case 'wool': return 'guitar';
    case 'metal': return 'chime';
    default: return belowId === BLOCK.GLOWSTONE ? 'bell' : 'harp';
  }
}

/** Playback rate of a note block pitch 0..24 (F♯3 … F♯5): 2^((n − 12) / 12). */
export function notePitchRate(pitch: number): number {
  return 2 ** ((pitch - 12) / 12);
}

// ---------------------------------------------------------------- geometry helpers shared with the mesher

type Getter = (x: number, y: number, z: number) => number;

/** Is `id` dust that this block (dust or not) joins visually: other dust, sources and aligned repeaters. */
function dustJoins(id: number, meta: number, side: number): boolean {
  switch (id) {
    case WIRE: case BLOCK.LEVER: case BLOCK.BUTTON: case BLOCK.PRESSURE_PLATE: case BLOCK.REDSTONE_TORCH: return true;
    case BLOCK.REPEATER: {
      const f = meta & 3;
      return f === side || f === (side ^ 1);
    }
    default: return id === REDSTONE_BLOCK;
  }
}

/**
 * Connection mask of the dust at (x, y, z): bits 0-3 the sides (north, south, west, east) it joins, bits 4-7 the sides where it
 * climbs a wall (Minecraft's RedStoneWireBlock.getConnectingSide). `get`/`meta` read ids and states.
 */
export function dustConnectMask(get: Getter, meta: Getter, x: number, y: number, z: number): number {
  const aboveFree = !isConductor(get(x, y + 1, z));
  let mask = 0;
  for (let s = 0; s < 4; s++) {
    const nx = x + (s === 2 ? -1 : s === 3 ? 1 : 0), nz = z + (s === 0 ? -1 : s === 1 ? 1 : 0);
    const nid = get(nx, y, nz);
    if (aboveFree && nid !== BLOCK.UNLOADED && topFaceSturdy(nid, meta(nx, y, nz)) && get(nx, y + 1, nz) === WIRE) {
      mask |= DUST_SIDE_BIT[s];
      if (isConductor(nid)) mask |= DUST_SIDE_BIT[s] << DUST_UP_SHIFT;
      continue;
    }
    if (dustJoins(nid, meta(nx, y, nz), s)) { mask |= DUST_SIDE_BIT[s]; continue; }
    if (isConductor(nid) || nid === BLOCK.UNLOADED) continue;
    if (get(nx, y - 1, nz) === WIRE) mask |= DUST_SIDE_BIT[s];
  }
  return mask;
}

/** Can dust stand at (x, y, z): something with a sturdy top face under it. */
export function dustCanStand(get: Getter, meta: Getter, x: number, y: number, z: number): boolean {
  const below = get(x, y - 1, z);
  return below === BLOCK.UNLOADED || topFaceSturdy(below, meta(x, y - 1, z));
}

// ---------------------------------------------------------------- pistons

/** Blocks a piston pushes through by breaking them (Minecraft's PushReaction.DESTROY): plants, torches, dust, levers, ... */
function pistonDestroys(id: number): boolean {
  if (id === BLOCK.AIR) return true;
  const shape = SHAPE[id];
  if (shape === SHAPE_CROSS || shape === SHAPE_MODEL || shape === SHAPE_LIQUID) return true;
  const kind = BOX_KIND[id];
  return id === WIRE || id === BLOCK.LEVER || id === BLOCK.BUTTON || id === BLOCK.PRESSURE_PLATE || id === BLOCK.REDSTONE_TORCH
    || kind === BOX_LADDER;
}

/** Can a piston move this block? Not bedrock, obsidian, other unbreakable blocks, containers, extended pistons, doors or beds. */
export function pistonCanMove(id: number, meta: number): boolean {
  if (id === BLOCK.AIR || id === BLOCK.UNLOADED) return false;
  const def = getBlockDef(id);
  if (!def || def.hardness < 0 || id === BLOCK.OBSIDIAN) return false;
  if (id === BLOCK.CHEST || id === BLOCK.FURNACE || id === BLOCK.PISTON_HEAD) return false;
  if ((id === BLOCK.PISTON || id === BLOCK.STICKY_PISTON) && (meta & PISTON_EXTENDED)) return false;
  if (SHAPE[id] === SHAPE_DOOR || BOX_KIND[id] === BOX_BED) return false;
  return true;
}

// ---------------------------------------------------------------- the simulation

export interface RedstoneStats {
  /** Updates processed and block changes made over the lifetime of the simulation. */
  updates: number;
  changes: number;
  /** Scheduled ticks refused because the queue was full. */
  dropped: number;
  /** Updates pushed to a later tick because a budget was used up. */
  deferred: number;
  /** Torches that burnt out. */
  burnouts: number;
}

export class RedstoneSim {
  readonly stats: RedstoneStats = { updates: 0, changes: 0, dropped: 0, deferred: 0, burnouts: 0 };
  /** A component lost its support (or was pushed over by a piston): the caller may drop its item. */
  onBreak: ((x: number, y: number, z: number, id: number, meta: number) => void) | null = null;
  /** TNT got power: the caller removes the block and lights the fuse. Return false to leave it. */
  onIgnite: ((x: number, y: number, z: number) => boolean) | null = null;

  private tickNo = 0;
  private changesThisTick = 0;
  private updatesThisTick = 0;
  private readonly chunkWork = new Map<number, number>();
  /** Scheduled positions per future tick (x, y, z triples). */
  private readonly slots: number[][] = Array.from({ length: RING }, () => []);
  private readonly pending = new Map<number, number>();
  /** Cells waiting to be updated (x, y, z triples); `queued` keeps each cell in at most once. */
  private queue: number[] = [];
  private head = 0;
  private readonly queued = new Set<number>();
  /** Dust cells to solve together. */
  private wireSeeds: number[] = [];
  private readonly wireQueued = new Set<number>();
  private solving = false;
  /** Pressure plates we know about: key → [x, y, z, tick it last had something on it]. */
  private readonly plates = new Map<number, number[]>();
  /** Doors, trapdoors and gates that currently get power (so a manual toggle is not undone by an unrelated update). */
  private readonly poweredDoors = new Set<number>();
  /** Recent torch toggles per torch: key → ticks. */
  private readonly toggles = new Map<number, number[]>();
  /** Burnt-out torches: key → the tick they may light again. */
  private readonly burnt = new Map<number, number>();

  constructor(private readonly grid: RedstoneGrid) {}

  get pendingCount(): number {
    return this.pending.size + (this.queue.length - this.head) / 3;
  }

  get currentTick(): number {
    return this.tickNo;
  }

  private static key(x: number, y: number, z: number): number {
    return chunkKey(x >> 4, z >> 4) * 32768 + ((x & 15) | ((z & 15) << 4) | (y << 8));
  }

  // ---------------------------------------------------------------- input

  /** Schedules the component at (x, y, z) to be looked at after `delay` ticks, unless it is already scheduled as soon. */
  schedule(x: number, y: number, z: number, delay: number): void {
    const key = RedstoneSim.key(x, y, z);
    const due = this.tickNo + Math.max(1, delay);
    const old = this.pending.get(key);
    if (old !== undefined && old <= due) return;
    if (old === undefined && this.pending.size >= MAX_PENDING) { this.stats.dropped++; return; }
    this.pending.set(key, due);
    this.slots[due % RING].push(x, y, z);
  }

  /**
   * A block at (x, y, z) changed: it and its neighbours get an update, and so do the neighbours of solid neighbours (a block that
   * is strongly powered passes the change on).
   */
  notify(x: number, y: number, z: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    this.enqueue(x, y, z);
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_X[d], ny = y + DIR_Y[d], nz = z + DIR_Z[d];
      if (ny < 0 || ny >= CHUNK_HEIGHT) continue;
      const id = this.grid.getBlock(nx, ny, nz);
      if (RELEVANT[id]) this.enqueue(nx, ny, nz);
      if (OPAQUE[id] && id !== BLOCK.UNLOADED) {
        for (let e = 0; e < 6; e++) {
          if (e === (d ^ 1)) continue;
          const mx = nx + DIR_X[e], my = ny + DIR_Y[e], mz = nz + DIR_Z[e];
          if (my < 0 || my >= CHUNK_HEIGHT) continue;
          if (RELEVANT[this.grid.getBlock(mx, my, mz)]) this.enqueue(mx, my, mz);
        }
      }
    }
    const id = this.grid.getBlock(x, y, z);
    if (id === BLOCK.PRESSURE_PLATE) this.registerPlate(x, y, z);
  }

  /** A chunk finished loading with this block in it (saved edits): components that were mid-delay carry on. */
  loaded(x: number, y: number, z: number, id: number): void {
    switch (id) {
      case BLOCK.PRESSURE_PLATE: this.registerPlate(x, y, z); break;
      case BLOCK.REPEATER: case BLOCK.REDSTONE_TORCH: case BLOCK.BUTTON: case BLOCK.PISTON: case BLOCK.STICKY_PISTON:
      case BLOCK.REDSTONE_LAMP_LIT:
        this.schedule(x, y, z, 1);
        break;
      default: break;
    }
  }

  /** Forgets everything (a world was unloaded). */
  clear(): void {
    for (const s of this.slots) s.length = 0;
    this.pending.clear();
    this.queue.length = 0;
    this.head = 0;
    this.queued.clear();
    this.wireSeeds.length = 0;
    this.wireQueued.clear();
    this.plates.clear();
    this.poweredDoors.clear();
    this.toggles.clear();
    this.burnt.clear();
  }

  private registerPlate(x: number, y: number, z: number): void {
    const key = RedstoneSim.key(x, y, z);
    if (!this.plates.has(key)) this.plates.set(key, [x, y, z, -100]);
  }

  private enqueue(x: number, y: number, z: number): void {
    const id = this.grid.getBlock(x, y, z);
    if (!RELEVANT[id] && id !== BLOCK.AIR) return;
    if (id === WIRE) {
      if (this.solving) return;
      const key = RedstoneSim.key(x, y, z);
      if (this.wireQueued.has(key)) return;
      this.wireQueued.add(key);
      this.wireSeeds.push(x, y, z);
      return;
    }
    if (id === BLOCK.AIR) return;
    const key = RedstoneSim.key(x, y, z);
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(x, y, z);
  }

  // ---------------------------------------------------------------- tick

  /** Runs what is due this tick within the budgets. Returns how many blocks changed. */
  tick(maxUpdates = MAX_UPDATES_PER_TICK, maxChanges = MAX_CHANGES_PER_TICK): number {
    this.tickNo++;
    this.changesThisTick = 0;
    this.updatesThisTick = 0;
    this.chunkWork.clear();
    // Scheduled ticks that are due.
    const slot = this.slots[this.tickNo % RING];
    const due = slot.splice(0, slot.length);
    for (let i = 0; i < due.length; i += 3) {
      const x = due[i], y = due[i + 1], z = due[i + 2];
      const key = RedstoneSim.key(x, y, z);
      if (this.pending.get(key) !== this.tickNo) continue;
      this.pending.delete(key);
      if (this.updatesThisTick >= maxUpdates || this.changesThisTick >= maxChanges) {
        this.schedule(x, y, z, 1);
        this.stats.deferred++;
        continue;
      }
      this.updatesThisTick++;
      this.tickAt(x, y, z);
    }
    if ((this.tickNo & 1) === 0) this.checkPlates();
    this.drain(maxUpdates, maxChanges);
    this.stats.updates += this.updatesThisTick;
    this.stats.changes += this.changesThisTick;
    return this.changesThisTick;
  }

  /** Processes the update queue and the dust networks until both are empty or the budget is spent. */
  private drain(maxUpdates: number, maxChanges: number): void {
    for (;;) {
      let progressed = false;
      while (this.head < this.queue.length) {
        if (this.updatesThisTick >= maxUpdates || this.changesThisTick >= maxChanges) return this.compactQueue();
        const x = this.queue[this.head], y = this.queue[this.head + 1], z = this.queue[this.head + 2];
        this.head += 3;
        this.queued.delete(RedstoneSim.key(x, y, z));
        if (!this.chunkBudget(x, z)) {
          this.enqueueLater(x, y, z);
          continue;
        }
        this.updatesThisTick++;
        progressed = true;
        this.update(x, y, z);
      }
      this.queue.length = 0;
      this.head = 0;
      if (this.wireSeeds.length > 0) {
        if (this.updatesThisTick >= maxUpdates || this.changesThisTick >= maxChanges) return;
        const seeds = this.wireSeeds;
        this.wireSeeds = [];
        this.wireQueued.clear();
        this.solveWires(seeds, maxChanges);
        progressed = true;
      }
      if (!progressed) return;
    }
  }

  private compactQueue(): void {
    if (this.head > 0) { this.queue.splice(0, this.head); this.head = 0; }
    this.stats.deferred += this.queue.length / 3;
  }

  private chunkBudget(x: number, z: number): boolean {
    const ck = chunkKey(x >> 4, z >> 4);
    const n = (this.chunkWork.get(ck) ?? 0) + 1;
    this.chunkWork.set(ck, n);
    return n <= MAX_UPDATES_PER_CHUNK;
  }

  /** A cell that hit its chunk's budget: try again next tick. */
  private enqueueLater(x: number, y: number, z: number): void {
    this.stats.deferred++;
    this.schedule(x, y, z, 1);
  }

  private set(x: number, y: number, z: number, id: number, meta: number): void {
    this.changesThisTick++;
    this.grid.setState(x, y, z, id, meta);
  }

  // ---------------------------------------------------------------- power

  /**
   * The signal the block at (x, y, z) gives to a neighbour that looks at it in direction `d` (from that neighbour to the
   * block). A solid block gives the strongest *strong* power its own neighbours put into it.
   * `wire` false leaves dust out (what dust itself reads from its surroundings).
   */
  private signalFrom(x: number, y: number, z: number, d: number, wire: boolean): number {
    const id = this.grid.getBlock(x, y, z);
    if (isConductor(id)) return this.strongInto(x, y, z, wire);
    return this.weak(x, y, z, id, d, wire);
  }

  private weak(x: number, y: number, z: number, id: number, d: number, wire: boolean): number {
    if (id === REDSTONE_BLOCK) return 15;
    switch (id) {
      case BLOCK.LEVER: return (this.grid.getMeta(x, y, z) & LEVER_ON) ? 15 : 0;
      case BLOCK.BUTTON: return (this.grid.getMeta(x, y, z) & BUTTON_PRESSED) ? 15 : 0;
      case BLOCK.PRESSURE_PLATE: return (this.grid.getMeta(x, y, z) & PLATE_PRESSED) ? 15 : 0;
      case BLOCK.REDSTONE_TORCH: {
        const meta = this.grid.getMeta(x, y, z);
        // Lit, and not towards the block it is attached to.
        return !(meta & TORCH_OFF) && d !== ((meta & 7) ^ 1) ? 15 : 0;
      }
      case BLOCK.REPEATER: {
        const meta = this.grid.getMeta(x, y, z);
        return (meta & REPEATER_POWERED) && d === (FACING_DIR[meta & 3] ^ 1) ? 15 : 0;
      }
      case WIRE: {
        if (!wire) return 0;
        const power = this.grid.getMeta(x, y, z) & 15;
        if (power === 0 || d === DOWN) return 0;
        if (d === UP) return power;
        // Horizontal: only towards the sides the dust joins. A querier at (x, z) − d looks along d.
        return this.dustPointsAt(x, y, z, d ^ 1) ? power : 0;
      }
      default: return 0;
    }
  }

  /** The direct (strong) signal a block gives to the solid block that looks at it in direction `e`. */
  private strongOf(x: number, y: number, z: number, id: number, e: number, wire: boolean): number {
    switch (id) {
      case BLOCK.LEVER: case BLOCK.BUTTON: {
        const meta = this.grid.getMeta(x, y, z);
        const on = id === BLOCK.LEVER ? meta & LEVER_ON : meta & BUTTON_PRESSED;
        return on && (meta & 7) === (e ^ 1) ? 15 : 0;
      }
      case BLOCK.PRESSURE_PLATE: return (this.grid.getMeta(x, y, z) & PLATE_PRESSED) && e === UP ? 15 : 0;
      case BLOCK.REDSTONE_TORCH: return !(this.grid.getMeta(x, y, z) & TORCH_OFF) && e === DOWN ? 15 : 0;
      case BLOCK.REPEATER: {
        const meta = this.grid.getMeta(x, y, z);
        return (meta & REPEATER_POWERED) && e === (FACING_DIR[meta & 3] ^ 1) ? 15 : 0;
      }
      case WIRE: return wire ? this.weak(x, y, z, id, e, true) : 0;
      default: return 0;
    }
  }

  private strongInto(x: number, y: number, z: number, wire: boolean): number {
    let best = 0;
    for (let e = 0; e < 6; e++) {
      const rx = x + DIR_X[e], ry = y + DIR_Y[e], rz = z + DIR_Z[e];
      const s = this.strongOf(rx, ry, rz, this.grid.getBlock(rx, ry, rz), e, wire);
      if (s > best) { best = s; if (best === 15) break; }
    }
    return best;
  }

  /** Does the dust at (x, y, z) feed the neighbour on side `dir` (a horizontal direction index)? */
  private dustPointsAt(x: number, y: number, z: number, dir: number): boolean {
    const g = this.grid;
    const mask = dustConnectMask((a, b, c) => g.getBlock(a, b, c), (a, b, c) => g.getMeta(a, b, c), x, y, z);
    // north (−Z) is direction 5, south 4, west 1, east 0.
    const side = dir === 5 ? 0 : dir === 4 ? 1 : dir === 1 ? 2 : 3;
    return (dustArms(mask) & DUST_SIDE_BIT[side]) !== 0;
  }

  /** Power a block receives from any of its six neighbours (what lamps, doors, note blocks and TNT react to). */
  hasNeighborSignal(x: number, y: number, z: number, except = -1): boolean {
    for (let d = 0; d < 6; d++) {
      if (d === except) continue;
      if (this.signalFrom(x + DIR_X[d], y + DIR_Y[d], z + DIR_Z[d], d, true) > 0) return true;
    }
    return false;
  }

  /** Power from outside the dust network: the strongest signal of the non-dust neighbours. */
  private externalPower(x: number, y: number, z: number): number {
    let best = 0;
    for (let d = 0; d < 6; d++) {
      const s = this.signalFrom(x + DIR_X[d], y + DIR_Y[d], z + DIR_Z[d], d, false);
      if (s > best) { best = s; if (best === 15) break; }
    }
    return best;
  }

  // ---------------------------------------------------------------- dust networks

  private readonly netIndex = new Map<number, number>();
  private readonly buckets: number[][] = Array.from({ length: 16 }, () => []);

  private readonly cand = [] as number[];
  private readonly cand2 = [] as number[];

  /**
   * Solves the dust networks around the seed cells: gathers every connected dust block, takes each one's power from
   * outside the network and spreads it with a decay of 1 per block, then writes the changes. Dust reads from a neighbour on
   * its own level, up a step over a solid block (when nothing solid is above it) and down a step through open air.
   */
  private solveWires(seeds: number[], maxChanges: number): void {
    const g = this.grid;
    const cells: number[] = [];
    const index = this.netIndex;
    index.clear();
    // 1. Gather the connected network (both directions of every read relation).
    for (let i = 0; i < seeds.length; i += 3) {
      const x = seeds[i], y = seeds[i + 1], z = seeds[i + 2];
      if (g.getBlock(x, y, z) !== WIRE) continue;
      if (!this.supported(x, y, z, WIRE, 0)) {
        this.breakAway(x, y, z, WIRE, g.getMeta(x, y, z));
        continue;
      }
      const key = netKey(x, y, z);
      if (index.has(key)) continue;
      index.set(key, cells.length / 3);
      cells.push(x, y, z);
    }
    const cand = this.cand;
    for (let i = 0; i < cells.length && cells.length < MAX_NETWORK * 3; i += 3) {
      const x = cells[i], y = cells[i + 1], z = cells[i + 2];
      this.neighbours(x, y, z, cand);
      for (let k = 0; k < cand.length; k += 3) {
        const key = netKey(cand[k], cand[k + 1], cand[k + 2]);
        if (index.has(key)) continue;
        index.set(key, cells.length / 3);
        cells.push(cand[k], cand[k + 1], cand[k + 2]);
        if (cells.length >= MAX_NETWORK * 3) break;
      }
    }
    const n = cells.length / 3;
    if (n === 0) return;
    this.updatesThisTick += n;
    // 2. Power from outside; 3. spread it, strongest first.
    const power = new Uint8Array(n);
    const buckets = this.buckets;
    for (const b of buckets) b.length = 0;
    for (let i = 0; i < n; i++) {
      const p = this.externalPower(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]);
      power[i] = p;
      if (p > 0) buckets[p].push(i);
    }
    const readers = this.cand2;
    for (let p = 15; p >= 2; p--) {
      const list = buckets[p];
      for (let k = 0; k < list.length; k++) {
        const u = list[k];
        if (power[u] !== p) continue;
        this.readersOf(cells[u * 3], cells[u * 3 + 1], cells[u * 3 + 2], readers);
        for (let r = 0; r < readers.length; r += 3) {
          const j = index.get(netKey(readers[r], readers[r + 1], readers[r + 2]));
          if (j === undefined || power[j] >= p - 1) continue;
          power[j] = p - 1;
          buckets[p - 1].push(j);
        }
      }
    }
    // 4. Write the changes.
    this.solving = true;
    for (let i = 0; i < n; i++) {
      const x = cells[i * 3], y = cells[i * 3 + 1], z = cells[i * 3 + 2];
      const meta = g.getMeta(x, y, z);
      if ((meta & 15) === power[i]) continue;
      if (this.changesThisTick >= maxChanges) { this.requeueWire(x, y, z); continue; }
      this.set(x, y, z, WIRE, (meta & ~15) | power[i]);
    }
    this.solving = false;
    // Dust beyond the size limit that was not part of this pass.
    if (cells.length >= MAX_NETWORK * 3) {
      for (let i = 0; i < cells.length; i += 3) {
        this.neighbours(cells[i], cells[i + 1], cells[i + 2], cand);
        for (let k = 0; k < cand.length; k += 3) {
          if (!index.has(netKey(cand[k], cand[k + 1], cand[k + 2]))) this.requeueWire(cand[k], cand[k + 1], cand[k + 2]);
        }
      }
    }
  }

  private requeueWire(x: number, y: number, z: number): void {
    const key = RedstoneSim.key(x, y, z);
    if (this.wireQueued.has(key)) return;
    this.wireQueued.add(key);
    this.wireSeeds.push(x, y, z);
  }

  /** Every dust cell related to (x, y, z) by a read in either direction (a superset is fine). */
  private neighbours(x: number, y: number, z: number, out: number[]): void {
    out.length = 0;
    const g = this.grid;
    for (let s = 0; s < 4; s++) {
      const dx = s === 2 ? -1 : s === 3 ? 1 : 0, dz = s === 0 ? -1 : s === 1 ? 1 : 0;
      const nx = x + dx, nz = z + dz;
      if (g.getBlock(nx, y, nz) === WIRE) out.push(nx, y, nz);
      if (g.getBlock(nx, y + 1, nz) === WIRE) out.push(nx, y + 1, nz);
      if (g.getBlock(nx, y - 1, nz) === WIRE) out.push(nx, y - 1, nz);
    }
  }

  /** The dust cells that read the dust at (x, y, z): the inverse of the read rules. */
  private readersOf(x: number, y: number, z: number, out: number[]): void {
    out.length = 0;
    const g = this.grid;
    const below = isConductor(g.getBlock(x, y - 1, z));
    const aboveOpen = !isConductor(g.getBlock(x, y + 1, z));
    for (let s = 0; s < 4; s++) {
      const dx = s === 2 ? -1 : s === 3 ? 1 : 0, dz = s === 0 ? -1 : s === 1 ? 1 : 0;
      // Same level.
      if (g.getBlock(x + dx, y, z + dz) === WIRE) out.push(x + dx, y, z + dz);
      // A reader one step lower reads us over the solid block we stand on, when nothing solid is above it.
      if (below && g.getBlock(x - dx, y - 1, z - dz) === WIRE && !isConductor(g.getBlock(x - dx, y, z - dz))) out.push(x - dx, y - 1, z - dz);
      // A reader one step higher reads us through the open air above us.
      if (aboveOpen && g.getBlock(x - dx, y + 1, z - dz) === WIRE) out.push(x - dx, y + 1, z - dz);
    }
  }

  // ---------------------------------------------------------------- components

  /** Support check: does this component still have what it stands on or hangs from? */
  private supported(x: number, y: number, z: number, id: number, meta: number): boolean {
    const g = this.grid;
    switch (id) {
      case BLOCK.LEVER: case BLOCK.BUTTON: case BLOCK.REDSTONE_TORCH: {
        const d = meta & 7;
        if (d > 5) return false;
        const sid = g.getBlock(x + DIR_X[d], y + DIR_Y[d], z + DIR_Z[d]);
        return sid === BLOCK.UNLOADED || OPAQUE[sid] === 1;
      }
      case WIRE: case BLOCK.PRESSURE_PLATE: case BLOCK.REPEATER: return dustCanStand((a, b, c) => g.getBlock(a, b, c), (a, b, c) => g.getMeta(a, b, c), x, y, z);
      default: return true;
    }
  }

  private breakAway(x: number, y: number, z: number, id: number, meta: number): void {
    this.set(x, y, z, BLOCK.AIR, 0);
    this.onBreak?.(x, y, z, id, meta);
  }

  /** One block's reaction to a change around it. */
  private update(x: number, y: number, z: number): void {
    const g = this.grid;
    const id = g.getBlock(x, y, z);
    const meta = g.getMeta(x, y, z);
    if (id === WIRE) return this.requeueWire(x, y, z);
    if (!this.supported(x, y, z, id, meta)) return this.breakAway(x, y, z, id, meta);
    switch (id) {
      case BLOCK.REPEATER: {
        const want = this.repeaterInput(x, y, z, meta) > 0;
        if (((meta & REPEATER_POWERED) !== 0) !== want) this.schedule(x, y, z, repeaterDelay(meta));
        break;
      }
      case BLOCK.REDSTONE_TORCH: {
        const lit = !(meta & TORCH_OFF);
        const powered = this.torchPowered(x, y, z, meta);
        if (lit === powered) this.schedule(x, y, z, TORCH_DELAY);
        break;
      }
      case BLOCK.REDSTONE_LAMP:
        if (this.hasNeighborSignal(x, y, z)) this.set(x, y, z, BLOCK.REDSTONE_LAMP_LIT, 0);
        break;
      case BLOCK.REDSTONE_LAMP_LIT:
        if (!this.hasNeighborSignal(x, y, z)) this.schedule(x, y, z, LAMP_OFF_DELAY);
        break;
      case BLOCK.NOTE_BLOCK: {
        const powered = this.hasNeighborSignal(x, y, z);
        if (powered !== ((meta & NOTE_POWERED) !== 0)) this.set(x, y, z, id, powered ? meta | NOTE_POWERED : meta & ~NOTE_POWERED);
        break;
      }
      case BLOCK.BUTTON:
        if (meta & BUTTON_PRESSED) this.schedule(x, y, z, (meta & BUTTON_OAK) ? OAK_BUTTON_TICKS : STONE_BUTTON_TICKS);
        break;
      case BLOCK.PRESSURE_PLATE: this.registerPlate(x, y, z); break;
      case BLOCK.PISTON: case BLOCK.STICKY_PISTON: case BLOCK.PISTON_HEAD:
        this.schedule(x, y, z, PISTON_DELAY);
        break;
      case BLOCK.TNT:
        if (this.hasNeighborSignal(x, y, z)) this.onIgnite?.(x, y, z);
        break;
      default:
        if (SHAPE[id] === SHAPE_DOOR || BOX_KIND[id] === BOX_TRAPDOOR || BOX_KIND[id] === BOX_GATE) this.updateOpenable(x, y, z, id, meta);
        break;
    }
  }

  /** Doors, trapdoors and fence gates open when they get power and close when it goes (a manual toggle stays until the power changes). */
  private updateOpenable(x: number, y: number, z: number, id: number, meta: number): void {
    const key = RedstoneSim.key(x, y, z);
    let powered = this.hasNeighborSignal(x, y, z);
    const isDoor = SHAPE[id] === SHAPE_DOOR;
    if (isDoor) {
      const oy = isDoorUpper(meta) ? y - 1 : y + 1;
      if (!powered && this.grid.getBlock(x, oy, z) === id) powered = this.hasNeighborSignal(x, oy, z);
    }
    if (powered === this.poweredDoors.has(key)) return;
    if (powered) this.poweredDoors.add(key); else this.poweredDoors.delete(key);
    const bit = isDoor ? DOOR_OPEN_BIT : BOX_KIND[id] === BOX_TRAPDOOR ? TRAPDOOR_OPEN_BIT : GATE_OPEN_BIT;
    if (((meta & bit) !== 0) === powered) return;
    const withBit = (m: number): number => (powered ? m | bit : m & ~bit);
    this.set(x, y, z, id, withBit(meta));
    if (isDoor) {
      const oy = isDoorUpper(meta) ? y - 1 : y + 1;
      if (this.grid.getBlock(x, oy, z) === id) {
        this.set(x, oy, z, id, withBit(this.grid.getMeta(x, oy, z)));
        this.poweredDoors.add(RedstoneSim.key(x, oy, z));
        if (!powered) this.poweredDoors.delete(RedstoneSim.key(x, oy, z));
      }
    }
  }

  /** The signal a repeater at (x, y, z) receives from behind. */
  private repeaterInput(x: number, y: number, z: number, meta: number): number {
    const back = FACING_DIR[meta & 3] ^ 1;
    const bx = x + DIR_X[back], by = y + DIR_Y[back], bz = z + DIR_Z[back];
    let i = this.signalFrom(bx, by, bz, back, true);
    if (i >= 15) return i;
    if (this.grid.getBlock(bx, by, bz) === WIRE) i = Math.max(i, this.grid.getMeta(bx, by, bz) & 15);
    return i;
  }

  private torchPowered(x: number, y: number, z: number, meta: number): boolean {
    const a = meta & 7;
    return this.signalFrom(x + DIR_X[a], y + DIR_Y[a], z + DIR_Z[a], a, true) > 0;
  }

  /** A scheduled tick is due at (x, y, z). */
  private tickAt(x: number, y: number, z: number): void {
    const g = this.grid;
    const id = g.getBlock(x, y, z);
    const meta = g.getMeta(x, y, z);
    switch (id) {
      case BLOCK.REPEATER: {
        const powered = (meta & REPEATER_POWERED) !== 0;
        const should = this.repeaterInput(x, y, z, meta) > 0;
        if (powered && !should) this.set(x, y, z, id, meta & ~REPEATER_POWERED);
        else if (!powered) {
          this.set(x, y, z, id, meta | REPEATER_POWERED);
          // A pulse shorter than the delay still lasts one full delay.
          if (!should) this.schedule(x, y, z, repeaterDelay(meta));
        }
        break;
      }
      case BLOCK.REDSTONE_TORCH: this.torchTick(x, y, z, meta); break;
      case BLOCK.REDSTONE_LAMP_LIT:
        if (!this.hasNeighborSignal(x, y, z)) this.set(x, y, z, BLOCK.REDSTONE_LAMP, 0);
        break;
      case BLOCK.BUTTON:
        if (meta & BUTTON_PRESSED) this.set(x, y, z, id, meta & ~BUTTON_PRESSED);
        break;
      case BLOCK.PISTON: case BLOCK.STICKY_PISTON: this.pistonTick(x, y, z, id, meta); break;
      case BLOCK.PISTON_HEAD: this.headTick(x, y, z, meta); break;
      default: break;
    }
  }

  private torchTick(x: number, y: number, z: number, meta: number): void {
    const key = RedstoneSim.key(x, y, z);
    const until = this.burnt.get(key);
    if (until !== undefined) {
      if (this.tickNo < until) return this.schedule(x, y, z, until - this.tickNo);
      this.burnt.delete(key);
      this.toggles.delete(key);
    }
    let list = this.toggles.get(key);
    if (list) {
      while (list.length > 0 && this.tickNo - list[0] > BURNOUT_WINDOW) list.shift();
      if (list.length === 0) { this.toggles.delete(key); list = undefined; }
    }
    const powered = this.torchPowered(x, y, z, meta);
    if (!(meta & TORCH_OFF)) {
      if (!powered) return;
      this.set(x, y, z, BLOCK.REDSTONE_TORCH, meta | TORCH_OFF);
      if (!list) { list = []; this.toggles.set(key, list); }
      list.push(this.tickNo);
      if (list.length >= BURNOUT_TOGGLES) {
        // Burnt out: stays dark for a while whatever the input does.
        this.stats.burnouts++;
        this.burnt.set(key, this.tickNo + BURNOUT_RESET);
        this.schedule(x, y, z, BURNOUT_RESET);
      }
    } else if (!powered && !(list && list.length >= BURNOUT_TOGGLES)) {
      this.set(x, y, z, BLOCK.REDSTONE_TORCH, meta & ~TORCH_OFF);
    }
  }

  private checkPlates(): void {
    if (this.plates.size === 0) return;
    const g = this.grid;
    for (const [key, p] of this.plates) {
      const [x, y, z] = p;
      if (g.getBlock(x, y, z) !== BLOCK.PRESSURE_PLATE) {
        // Unloaded chunks keep their plates; a plate that is gone for real is forgotten.
        if (g.getBlock(x, y, z) !== BLOCK.UNLOADED) this.plates.delete(key);
        continue;
      }
      const meta = g.getMeta(x, y, z);
      const count = g.entitiesOn ? g.entitiesOn(x, y, z, (meta & PLATE_OAK) !== 0) : 0;
      const pressed = (meta & PLATE_PRESSED) !== 0;
      if (count > 0) {
        p[3] = this.tickNo;
        if (!pressed) this.set(x, y, z, BLOCK.PRESSURE_PLATE, meta | PLATE_PRESSED);
      } else if (pressed && this.tickNo - p[3] >= 10) {
        this.set(x, y, z, BLOCK.PRESSURE_PLATE, meta & ~PLATE_PRESSED);
      }
    }
  }

  // ---------------------------------------------------------------- pistons

  private pistonTick(x: number, y: number, z: number, id: number, meta: number): void {
    const f = meta & 7;
    if (f > 5) return;
    const g = this.grid;
    const hx = x + DIR_X[f], hy = y + DIR_Y[f], hz = z + DIR_Z[f];
    const extended = (meta & PISTON_EXTENDED) !== 0;
    const headThere = g.getBlock(hx, hy, hz) === BLOCK.PISTON_HEAD && (g.getMeta(hx, hy, hz) & 7) === f;
    if (extended && !headThere) {
      // The head was broken (or never existed, e.g. a placed state): the piston is retracted.
      this.set(x, y, z, id, meta & ~PISTON_EXTENDED);
      return;
    }
    const powered = this.hasNeighborSignal(x, y, z, f);
    if (powered && !extended) this.pistonExtend(x, y, z, id, meta, f);
    else if (!powered && extended) this.pistonRetract(x, y, z, id, meta, f);
  }

  /** The head whose piston is gone disappears. */
  private headTick(x: number, y: number, z: number, meta: number): void {
    const f = meta & 7;
    if (f > 5) return this.set(x, y, z, BLOCK.AIR, 0);
    const g = this.grid;
    const bx = x - DIR_X[f], by = y - DIR_Y[f], bz = z - DIR_Z[f];
    const base = g.getBlock(bx, by, bz);
    const ok = (base === BLOCK.PISTON || base === BLOCK.STICKY_PISTON) && (g.getMeta(bx, by, bz) & 7) === f && (g.getMeta(bx, by, bz) & PISTON_EXTENDED) !== 0;
    if (!ok) this.set(x, y, z, BLOCK.AIR, 0);
  }

  private pistonExtend(x: number, y: number, z: number, id: number, meta: number, f: number): void {
    const g = this.grid;
    const dx = DIR_X[f], dy = DIR_Y[f], dz = DIR_Z[f];
    // Walk the line in front of the piston: the blocks to push, ending at something that gives way.
    let count = 0;
    let end = -1;
    for (let i = 1; i <= PISTON_PUSH_LIMIT + 1; i++) {
      const cx = x + dx * i, cy = y + dy * i, cz = z + dz * i;
      if (cy < 0 || cy >= CHUNK_HEIGHT) return;
      const cid = g.getBlock(cx, cy, cz);
      if (cid === BLOCK.UNLOADED) return;
      if (pistonDestroys(cid)) { end = i; break; }
      if (!pistonCanMove(cid, g.getMeta(cx, cy, cz))) return;
      count++;
      if (count > PISTON_PUSH_LIMIT) return;
    }
    if (end < 0) return;
    // Back to front: each block moves one cell on; whatever stood at the end is destroyed.
    const ex = x + dx * end, ey = y + dy * end, ez = z + dz * end;
    const old = g.getBlock(ex, ey, ez);
    if (old !== BLOCK.AIR && SHAPE[old] !== SHAPE_LIQUID) this.onBreak?.(ex, ey, ez, old, g.getMeta(ex, ey, ez));
    for (let i = end - 1; i >= 1; i--) {
      const cx = x + dx * i, cy = y + dy * i, cz = z + dz * i;
      this.set(cx + dx, cy + dy, cz + dz, g.getBlock(cx, cy, cz), g.getMeta(cx, cy, cz));
    }
    this.set(x + dx, y + dy, z + dz, BLOCK.PISTON_HEAD, f | (id === BLOCK.STICKY_PISTON ? HEAD_STICKY : 0));
    this.set(x, y, z, id, meta | PISTON_EXTENDED);
  }

  private pistonRetract(x: number, y: number, z: number, id: number, meta: number, f: number): void {
    const g = this.grid;
    const dx = DIR_X[f], dy = DIR_Y[f], dz = DIR_Z[f];
    const hx = x + dx, hy = y + dy, hz = z + dz;
    this.set(x, y, z, id, meta & ~PISTON_EXTENDED);
    if (id === BLOCK.STICKY_PISTON) {
      // Sticky: the block just beyond the head comes along (if it can move and is not something that merely gives way).
      const bx = hx + dx, by = hy + dy, bz = hz + dz;
      if (by >= 0 && by < CHUNK_HEIGHT) {
        const bid = g.getBlock(bx, by, bz);
        const bmeta = g.getMeta(bx, by, bz);
        if (!pistonDestroys(bid) && pistonCanMove(bid, bmeta)) {
          this.set(hx, hy, hz, bid, bmeta);
          this.set(bx, by, bz, BLOCK.AIR, 0);
          return;
        }
      }
    }
    if (g.getBlock(hx, hy, hz) === BLOCK.PISTON_HEAD) this.set(hx, hy, hz, BLOCK.AIR, 0);
  }
}

/** Does an entity (feet at ex, ey, ez; half width, height) touch the pressure plate in cell (x, y, z)? Its detection box is 1/16 in from the sides and 1/4 high. */
export function touchesPlate(ex: number, ey: number, ez: number, halfWidth: number, height: number, x: number, y: number, z: number): boolean {
  const m = 1 / 16;
  return ex + halfWidth > x + m && ex - halfWidth < x + 1 - m && ez + halfWidth > z + m && ez - halfWidth < z + 1 - m
    && ey < y + 0.25 && ey + height > y;
}
