/**
 * Armor rules of Minecraft Java 1.21 (see the wiki's "Armor" and "Damage" pages).
 *
 * Armor points (the icons above the hearts, 2 points per icon) and toughness reduce most damage:
 *   reduction = min(20, max(armor / 5, armor − damage / (2 + toughness / 4))) / 25
 *   damage taken = damage × (1 − reduction)
 */

export function damageReduction(damage: number, armor: number, toughness: number): number {
  if (armor <= 0) return 0;
  return Math.min(20, Math.max(armor / 5, armor - damage / (2 + toughness / 4))) / 25;
}

/** Damage after armor and toughness. */
export function reduceDamage(damage: number, armor: number, toughness: number): number {
  return damage * (1 - damageReduction(damage, armor, toughness));
}

/** Durability every worn piece loses when the wearer takes `damage` that armor applies to: max(1, floor(damage / 4)). */
export function armorWear(damage: number): number {
  return Math.max(1, Math.floor(damage / 4));
}

/** Damage causes armor reduces (and wears down for). Falling, drowning, starving, suffocating, the void and poison ignore it. */
export const ARMOR_CAUSES: ReadonlySet<string> = new Set(['mob', 'arrow', 'explosion', 'fire', 'lava', 'cactus']);
