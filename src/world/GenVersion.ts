/**
 * Terrain generator versions. Chunks are regenerated from the seed on every load and only the
 * player's edits are stored, so changing the generator changes existing worlds. Every world
 * therefore remembers the version it was created with:
 *
 *  1  original generator (coarse caves, single-chunk ore veins). Worlds saved before versioning.
 *  2  noise caves (cheese, spaghetti, noodle, entrances), ravines, aquifers, lava lakes, ore blobs.
 *  3  climate biomes (jungle, savanna, swamp, badlands, dark/birch/flower forest, cherry grove, windswept hills, meadow,
 *     snowy taiga, ocean variants, rivers), rock variety and deepslate, the new ores, new trees and plants, springs and
 *     surface structures (desert wells, taiga boulders). See GeneratorV3.ts.
 *
 * Versions 1 and 2 share their surface (height, biome, trees); version 2 only differs underground.
 * Version 3 replaces the surface, so a world keeps the version it was created with.
 */
export const GEN_VERSION_LEGACY = 1;
export const GEN_VERSION_CURRENT = 3;

/** A stored or received version, as a usable one: missing/invalid → 1, newer than we know → current. */
export function normalizeGenVersion(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return GEN_VERSION_LEGACY;
  return Math.min(GEN_VERSION_CURRENT, Math.floor(v));
}
