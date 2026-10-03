/**
 * Beds and sleeping rules (DOM-free: client, server and tests share them). Minecraft Wiki, Bed:
 * you can only sleep at night (or in a thunderstorm), hostile mobs within 8 blocks sideways and 5 up or down of the bed
 * block sleeping, the night is skipped once enough players sleep (`playersSleepingPercentage`, default 100 %), and
 * a respawn at a bed that is gone or blocked falls back to the world spawn.
 */
import { BLOCK, OPAQUE, SHAPE, SHAPE_BOX, SOLID } from './BlockRegistry';
import { BED_HEAD_BIT, BOX_BED, bedPartner } from './BoxShapes';
import { BOX_KIND } from './BlockRegistry';

/** Ticks a player must lie in bed before the night can pass (Minecraft: 100). */
export const SLEEP_TICKS = 100;
/** Time of day after sleeping (0 = sunrise). */
export const MORNING = 0.02;
export const SLEEP_MONSTER_RANGE_H = 8;
export const SLEEP_MONSTER_RANGE_V = 5;

export const MSG = {
  respawnSet: 'Respawn point set',
  notNight: 'You can only sleep at night',
  monsters: 'You may not rest now, there are monsters nearby',
  bedMissing: 'Your home bed was missing or obstructed',
  tooFar: 'The bed is too far away',
} as const;

/** Sleeping is allowed when it is night (day factor below 0.4, about from dusk to dawn) or thundering. */
export function canSleepNow(dayFactor: number, thundering: boolean): boolean {
  return thundering || dayFactor < 0.4;
}

export interface MobLike { x: number; y: number; z: number; dead: boolean; type: { hostile: boolean } }

/** Any living hostile mob within 8 blocks (horizontal) and 5 (vertical) of the bed. */
export function monstersNearby(mobs: Iterable<MobLike>, x: number, y: number, z: number): boolean {
  for (const m of mobs) {
    if (!m.type.hostile || m.dead) continue;
    if (Math.abs(m.x - x) <= SLEEP_MONSTER_RANGE_H && Math.abs(m.z - z) <= SLEEP_MONSTER_RANGE_H && Math.abs(m.y - y) <= SLEEP_MONSTER_RANGE_V) return true;
  }
  return false;
}

/**
 * Does the night pass? `sleeping` players have slept long enough out of `total` players; `percentage` is the game rule.
 * A percentage of 0 means one sleeper is enough. Nobody asleep never skips anything.
 */
export function sleepSkipsNight(sleeping: number, total: number, percentage: number): boolean {
  if (total <= 0 || sleeping <= 0) return false;
  if (percentage <= 0) return true;
  return sleeping >= Math.ceil((total * Math.min(100, percentage)) / 100);
}

type Get = (x: number, y: number, z: number) => number;

export function isBedBlock(id: number): boolean {
  return id === BLOCK.BED && SHAPE[id] === SHAPE_BOX && BOX_KIND[id] === BOX_BED;
}

/** Both cells of the bed at (x, y, z): the head and the foot. Null when the cell is not a bed. */
export function bedCells(getBlock: Get, getMeta: Get, x: number, y: number, z: number): { head: { x: number; z: number }; foot: { x: number; z: number } } | null {
  if (!isBedBlock(getBlock(x, y, z))) return null;
  const meta = getMeta(x, y, z);
  const other = bedPartner(x, z, meta);
  const here = { x, z };
  return meta & BED_HEAD_BIT ? { head: here, foot: other } : { head: other, foot: here };
}

function standable(getBlock: Get, x: number, y: number, z: number): boolean {
  const below = getBlock(x, y - 1, z);
  if (below === BLOCK.UNLOADED || !SOLID[below] || !OPAQUE[below]) return false;
  const a = getBlock(x, y, z), b = getBlock(x, y + 1, z);
  return a !== BLOCK.UNLOADED && b !== BLOCK.UNLOADED && !SOLID[a] && !SOLID[b] && a !== BLOCK.LAVA && b !== BLOCK.LAVA;
}

/**
 * Where the player appears when respawning at the bed at (x, y, z): the first free cell next to the bed (the sides of the
 * head first), else on top of it. Null when the bed is gone or every spot is blocked.
 */
export function bedRespawnPoint(getBlock: Get, getMeta: Get, x: number, y: number, z: number): { x: number; y: number; z: number } | null {
  const cells = bedCells(getBlock, getMeta, x, y, z);
  if (!cells) return null;
  const { head, foot } = cells;
  const dx = head.x - foot.x, dz = head.z - foot.z;
  const ring: [number, number][] = [];
  // Beside the head, beside the foot, then past the head and the foot.
  for (const c of [head, foot]) {
    ring.push([c.x + dz, c.z + dx], [c.x - dz, c.z - dx]);
  }
  ring.push([head.x + dx, head.z + dz], [foot.x - dx, foot.z - dz]);
  for (const [cx, cz] of ring) if (standable(getBlock, cx, y, cz)) return { x: cx + 0.5, y, z: cz + 0.5 };
  // Last resort: on top of the head half.
  const top = getBlock(head.x, y + 1, head.z), top2 = getBlock(head.x, y + 2, head.z);
  if (top !== BLOCK.UNLOADED && top2 !== BLOCK.UNLOADED && !SOLID[top] && !SOLID[top2]) return { x: head.x + 0.5, y: y + 0.6, z: head.z + 0.5 };
  return null;
}
