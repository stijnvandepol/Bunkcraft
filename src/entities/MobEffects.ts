import type { EffectId } from '../player/Effects';
import type { Mob } from './Mob';

/** A status effect a mob puts on the player: [effect id, amplifier, ticks] (also the wire format). */
export type MobEffect = [EffectId, number, number];

/**
 * Effects of mob hits (Minecraft Java 1.21, Normal difficulty): a cave spider's bite poisons for 7 s, a husk's hit
 * gives Hunger for 7 s (the wiki scales it with regional difficulty: onzeker for our flat difficulty).
 */
export function meleeEffect(m: Mob): MobEffect | null {
  if (m.type.poison) return ['poison', 0, m.type.poison];
  if (m.type.kind === 'husk') return ['hunger', 0, 140];
  return null;
}

/** A stray's arrow: Slowness for 30 s (tipped arrow of a 1:30 potion, one eighth). */
export function arrowEffect(shooter: Mob | null): MobEffect | null {
  return shooter && shooter.type.kind === 'stray' ? ['slowness', 0, 600] : null;
}

/**
 * The witch's choice of splash potion (Minecraft's Witch.performRangedAttack): Slowness when the target is 8 or more
 * blocks away, Poison when it has 8+ health and no poison yet, Weakness a quarter of the time, otherwise Harming.
 * Splash durations are three quarters of the drinkable ones.
 */
export function witchPotion(distance: number, health: number, has: (id: EffectId) => boolean, roll: number): MobEffect {
  if (distance >= 8 && !has('slowness')) return ['slowness', 0, 1350];
  if (health >= 8 && !has('poison')) return ['poison', 0, 675];
  if (distance <= 3 && !has('weakness') && roll < 0.25) return ['weakness', 0, 1350];
  return ['instant_damage', 0, 1];
}
