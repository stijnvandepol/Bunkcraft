/**
 * Explosion numbers of Minecraft Java 1.21 (wiki: Explosion), shared by the client and the server.
 * Exposure (how much of the target the blocks hide) is not simulated: every target counts as fully exposed.
 */

/**
 * Damage at `distance` blocks from an explosion of `power` (creeper 3, TNT 4):
 * impact = 1 − distance / (2 × power), damage = floor(7 × power × (impact² + impact) + 1); 0 out of range.
 * The same for mobs and players (before difficulty and armor).
 */
export function explosionDamage(distance: number, power: number): number {
  const reach = power * 2;
  if (distance >= reach) return 0;
  const impact = 1 - distance / reach;
  return Math.floor(7 * power * (impact * impact + impact) + 1);
}

/** Chance that a destroyed block drops: always for TNT (tnt_explosion_drop_decay is off since 1.21), 1/power otherwise. */
export function explosionDropChance(power: number, tnt: boolean): number {
  return tnt ? 1 : 1 / power;
}
