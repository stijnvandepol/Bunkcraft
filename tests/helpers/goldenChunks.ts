/**
 * Golden hashes (FNV-1a over the chunk bytes) of the terrain generator versions for seed GOLDEN_SEED: [cx, cz, blocks
 * hash, biomes hash]. If world generation is changed on purpose, existing worlds change too: add a new generator
 * version instead of updating the hashes of an old one. Shared by the generator tests (terrain, terrainV3) and the
 * server's worker-thread generation test (chunkGenPool), which must produce the very same chunks.
 */
export const GOLDEN_SEED = 12345;

export const GOLDEN_V1: [number, number, number, number][] = [
  [0, 0, 0xf29319c7, 0x87f698b0],
  [3, -2, 0x1f82108e, 0xef78e905],
  [-7, 11, 0xc58d641b, 0x2e9aeac5],
];

export const GOLDEN_V2: [number, number, number, number][] = [
  [0, 0, 0xaa0ae40d, 0x87f698b0],
  [3, -2, 0xd280fd9f, 0xef78e905],
  [-7, 11, 0x1e8e8fa7, 0x2e9aeac5],
];

/** Version 3 is what new worlds use: if its output changes, existing v3 worlds change. Make a version 4 instead. */
export const GOLDEN_V3: [number, number, number, number][] = [
  [0, 0, 0xdb58e1ac, 0xf440a294],
  [3, -2, 0xdf39a289, 0xdc43da71],
  [-7, 11, 0xa5436239, 0x2e9aeac5],
  [40, -25, 0xccd7c155, 0x40ebc2c5],
];
