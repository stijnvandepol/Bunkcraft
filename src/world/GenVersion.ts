/**
 * Terrain generator versions. Chunks are regenerated from the seed on every load and only the
 * player's edits are stored, so changing the generator changes existing worlds. Every world
 * therefore remembers the version it was created with:
 *
 *  1  original generator (coarse caves, single-chunk ore veins). Worlds saved before versioning.
 *  2  noise caves (cheese, spaghetti, noodle, entrances), ravines, aquifers, lava lakes, ore blobs.
 *
 * The surface (height, biome, trees) is identical in both versions; only what happens
 * underground and the support checks around cave entrances differ.
 */
export const GEN_VERSION_LEGACY = 1;
export const GEN_VERSION_CURRENT = 2;

/** A stored or received version, as a usable one: missing/invalid → 1, newer than we know → current. */
export function normalizeGenVersion(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return GEN_VERSION_LEGACY;
  return Math.min(GEN_VERSION_CURRENT, Math.floor(v));
}
