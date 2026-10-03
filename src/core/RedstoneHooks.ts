import type { EntityManager } from '../entities/EntityManager';
import { blockDrop, itemId } from '../items/ItemRegistry';
import { PHYSICS } from '../player/Physics';
import { BLOCK, BOX_KIND, SHAPE, SHAPE_DOOR } from '../world/BlockRegistry';
import { DOOR_OPEN_BIT } from '../world/BlockStates';
import { BOX_GATE, BOX_TRAPDOOR, GATE_OPEN_BIT, TRAPDOOR_OPEN_BIT } from '../world/BoxShapes';
import {
  BUTTON_PRESSED, LEVER_ON, NOTE_POWERED, PISTON_EXTENDED, PLATE_PRESSED, noteInstrument, notePitchRate, touchesPlate,
} from '../world/Redstone';
import type { World } from '../world/World';
import type { AudioEngine } from './Audio';

/**
 * Glue between the redstone simulation and the game: singleplayer wiring (drops, TNT, pressure plates) and the sounds of
 * state changes that come from the simulation or the server.
 */

/** The block a redstone component drops when it pops off (dust is the redstone item). */
export function redstoneDrop(id: number, meta: number) {
  if (id === BLOCK.REDSTONE_WIRE) return { id: itemId('redstone'), count: 1 };
  return blockDrop(id, 0, meta);
}

export interface RedstoneGameHooks {
  entities: EntityManager;
  player: { x: number; y: number; z: number };
  survival(): boolean;
}

/** Singleplayer: turns redstone on for the world. */
export function enableRedstone(world: World, h: RedstoneGameHooks): void {
  const half = PHYSICS.WIDTH / 2;
  const sim = world.enableRedstone((x, y, z, oak) => {
    let n = 0;
    const p = h.player;
    if (touchesPlate(p.x, p.y, p.z, half, PHYSICS.HEIGHT, x, y, z)) n++;
    for (const m of h.entities.mobs) if (!m.dead && touchesPlate(m.x, m.y, m.z, m.width / 2, m.height, x, y, z)) n++;
    if (oak) for (const it of h.entities.items) if (!it.removed && touchesPlate(it.x, it.y, it.z, 0.125, 0.25, x, y, z)) n++;
    return n;
  });
  sim.onBreak = (x, y, z, id, meta) => {
    const drop = h.survival() ? redstoneDrop(id, meta) : null;
    if (drop) h.entities.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
  };
  sim.onIgnite = (x, y, z) => {
    if (!world.setBlock(x, y, z, BLOCK.AIR)) return false;
    h.entities.primeTnt(x, y, z);
    return true;
  };
}

/** Plays the sound of a redstone state change made by the simulation or the server. */
export function redstoneSound(audio: AudioEngine, world: World, x: number, y: number, z: number, prevId: number, prevMeta: number, id: number, meta: number): void {
  const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
  const changed = (bit: number): boolean => prevId === id && ((prevMeta ^ meta) & bit) !== 0;
  switch (id) {
    case BLOCK.LEVER: if (changed(LEVER_ON)) audio.playClick((meta & LEVER_ON) !== 0, at); return;
    case BLOCK.BUTTON: if (changed(BUTTON_PRESSED)) audio.playClick((meta & BUTTON_PRESSED) !== 0, at); return;
    case BLOCK.PRESSURE_PLATE: if (changed(PLATE_PRESSED)) audio.playClick((meta & PLATE_PRESSED) !== 0, at); return;
    case BLOCK.PISTON: case BLOCK.STICKY_PISTON: if (changed(PISTON_EXTENDED)) audio.playPiston((meta & PISTON_EXTENDED) !== 0, at); return;
    case BLOCK.NOTE_BLOCK:
      if (changed(NOTE_POWERED) && (meta & NOTE_POWERED) && world.getBlock(x, y + 1, z) === BLOCK.AIR) {
        audio.playNote(noteInstrument(world.getBlock(x, y - 1, z)), notePitchRate(meta & 31), at);
      }
      return;
    default: break;
  }
  if (prevId !== id) return;
  const bit = SHAPE[id] === SHAPE_DOOR ? DOOR_OPEN_BIT : BOX_KIND[id] === BOX_TRAPDOOR ? TRAPDOOR_OPEN_BIT : BOX_KIND[id] === BOX_GATE ? GATE_OPEN_BIT : 0;
  // Doors: the lower half only (both halves change together).
  if (bit && changed(bit) && !(SHAPE[id] === SHAPE_DOOR && world.getBlock(x, y - 1, z) === id)) audio.playDoor((meta & bit) !== 0);
}
