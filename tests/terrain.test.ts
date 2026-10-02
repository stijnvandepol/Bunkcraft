import { describe, expect, it } from 'vitest';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_AREA, CHUNK_VOLUME } from '../src/world/constants';
import { fnv1a } from './helpers';

const SEED = 12345;

function generate(seed: number, cx: number, cz: number): { blocks: Uint8Array; biomes: Uint8Array } {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  const biomes = new Uint8Array(CHUNK_AREA);
  new TerrainGenerator(seed).generate(cx, cz, blocks, biomes);
  return { blocks, biomes };
}

/**
 * Golden hashes (FNV-1a over the chunk bytes) for a fixed seed. If world generation is
 * changed on purpose, existing worlds change too: update these values deliberately.
 */
const GOLDEN: [number, number, number, number][] = [
  // [cx, cz, blocks hash, biomes hash]
  [0, 0, 0xf29319c7, 0x87f698b0],
  [3, -2, 0x1f82108e, 0xef78e905],
  [-7, 11, 0xc58d641b, 0x2e9aeac5],
];

describe('TerrainGenerator', () => {
  it.each(GOLDEN)('chunk (%i, %i) matches its golden hash', (cx, cz, blocksHash, biomesHash) => {
    const { blocks, biomes } = generate(SEED, cx, cz);
    expect(fnv1a(blocks)).toBe(blocksHash);
    expect(fnv1a(biomes)).toBe(biomesHash);
  });

  it('is deterministic: same seed gives identical bytes, also from a fresh generator', () => {
    const a = generate(SEED, 1, 2);
    const b = generate(SEED, 1, 2);
    expect(b.blocks).toEqual(a.blocks);
    expect(b.biomes).toEqual(a.biomes);
  });

  it('does not depend on generation order when one generator is reused', () => {
    const gen = new TerrainGenerator(SEED);
    const first = new Uint8Array(CHUNK_VOLUME);
    gen.generate(4, 4, first);
    const other = new Uint8Array(CHUNK_VOLUME);
    gen.generate(-3, 9, other);
    const again = new Uint8Array(CHUNK_VOLUME);
    gen.generate(4, 4, again);
    expect(again).toEqual(first);
  });

  it('produces different terrain for a different seed', () => {
    const a = generate(SEED, 0, 0);
    const b = generate(SEED + 1, 0, 0);
    expect(fnv1a(b.blocks)).not.toBe(fnv1a(a.blocks));
  });
});
