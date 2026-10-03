import { ITEM, itemFromState, itemId } from '../items/ItemRegistry';
import { BLOCK } from '../world/BlockRegistry';
import { DYES } from '../world/Content';
import { isBreedFood } from './Breeding';
import { LOVE_TICKS, type Mob } from './Mob';

/** What a right-click on a mob did, and what it costs the player (applied by the client to the inventory). */
export interface UseResult {
  action: 'none' | 'feed' | 'tame' | 'tame_fail' | 'sit' | 'stand' | 'shear' | 'milk' | 'dye' | 'saddle' | 'mount';
  /** Items to take from the held stack (survival only). */
  consume: number;
  /** Item that replaces one of the held ones (milk bucket for a bucket). */
  give?: number;
  /** The held tool loses durability (shears). */
  damageTool?: boolean;
}

const NONE: UseResult = { action: 'none', consume: 0 };

let dyeIds: Map<number, number> | null = null;
/** Colour index of a dye item (0 white … 15 black), −1 for anything else. */
export function dyeColor(item: number): number {
  if (!dyeIds) {
    dyeIds = new Map();
    DYES.forEach((d, i) => {
      try { dyeIds!.set(itemId(`${d.name}_dye`), i); } catch { /* dye not registered */ }
    });
  }
  return dyeIds.get(item) ?? -1;
}

function itemOr(name: string): number {
  try { return itemId(name); } catch { return -1; }
}

/** Whether a right-click with `held` would do anything (clients decide this before asking the server). */
export function canUseOnMob(m: Mob, held: number, playerId: number): boolean {
  return useOnMob(m, held, playerId, true).action !== 'none';
}

/**
 * Right-click with `held` on a mob, Minecraft Java 1.21 rules: breeding food starts love mode (or speeds up a baby's
 * growth by 10 %), a bone tames a wild wolf with a 1/3 chance, the owner makes his wolf sit or stand, shears shear
 * a sheep (1-3 wool), a dye colours a sheep or a collar, a bucket milks a cow, a saddle goes on a tamed horse and an
 * empty hand mounts a horse. `dryRun` only answers whether something would happen (no state changes, no random).
 */
export function useOnMob(m: Mob, held: number, playerId: number, dryRun = false): UseResult {
  if (m.dead || m.removed) return NONE;
  const kind = m.type.kind;

  if (kind === 'wolf') {
    if (!m.tamed) {
      if (held !== ITEM.BONE || m.angryTicks > 0 || m.baby) return NONE;
      if (dryRun) return { action: 'tame', consume: 1 };
      // Minecraft: a 1 in 3 chance per bone.
      if (Math.random() < 1 / 3) {
        m.ownerId = playerId;
        m.maxHp = 40;
        m.health = 40;
        m.persistent = true;
        m.homeChunk = -1;
        m.sitting = true;
        m.target = null;
        m.nav.stop();
        m.events?.fx?.(m, 'tame');
        return { action: 'tame', consume: 1 };
      }
      m.events?.fx?.(m, 'smoke');
      return { action: 'tame_fail', consume: 1 };
    }
    if (m.ownerId !== playerId) return NONE;
    if (isBreedFood(kind, held) && m.health < m.maxHp) {
      if (!dryRun) m.health = Math.min(m.maxHp, m.health + 4);
      return { action: 'feed', consume: 1 };
    }
    const dye = dyeColor(held);
    if (dye >= 0 && dye !== (m.variant & 15)) {
      if (!dryRun) m.variant = (m.variant & ~15) | dye;
      return { action: 'dye', consume: 1 };
    }
    if (!isBreedFood(kind, held) || !m.canBreed) {
      const wasSitting = m.sitting;
      if (!dryRun) { m.sitting = !m.sitting; m.nav.stop(); m.target = null; }
      return { action: wasSitting ? 'stand' : 'sit', consume: 0 };
    }
  }

  if (kind === 'sheep' && !m.baby) {
    if (held === ITEM.SHEARS && !(m.variant & 16)) {
      if (!dryRun) {
        m.variant |= 16;
        const n = 1 + Math.floor(Math.random() * 3);
        m.world?.dropItem?.({ id: itemFromState(BLOCK.WOOL, m.variant & 15), count: n }, m.x, m.y + 1, m.z);
      }
      return { action: 'shear', consume: 0, damageTool: true };
    }
    const dye = dyeColor(held);
    if (dye >= 0 && dye !== (m.variant & 15)) {
      if (!dryRun) m.variant = (m.variant & ~15) | dye;
      return { action: 'dye', consume: 1 };
    }
  }

  if (kind === 'cow' && !m.baby && held === ITEM.BUCKET) {
    const milk = itemOr('milk_bucket');
    if (milk > 0) return { action: 'milk', consume: 1, give: milk };
  }

  if (kind === 'horse' && !m.baby) {
    if (m.tamed && !m.saddled && held === itemOr('saddle')) {
      if (!dryRun) m.saddled = true;
      return { action: 'saddle', consume: 1 };
    }
    if (!isBreedFood(kind, held) && m.rider === null) return { action: 'mount', consume: 0 };
  }

  if (isBreedFood(kind, held)) {
    if (m.baby) {
      // Feeding a baby takes 10 % off the time it still needs to grow up.
      if (!dryRun) m.growingAge = Math.min(0, Math.floor(m.growingAge * 0.9));
      return { action: 'feed', consume: 1 };
    }
    if (m.canBreed && (kind !== 'wolf' || m.tamed) && (kind !== 'horse' || m.tamed)) {
      if (!dryRun) { m.inLove = LOVE_TICKS; m.events?.fx?.(m, 'love'); }
      return { action: 'feed', consume: 1 };
    }
  }
  return NONE;
}
