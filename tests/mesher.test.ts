import { describe, expect, it } from 'vitest';
import { ChunkMesher, type GeometryData } from '../src/rendering/ChunkMesher';
import { BLOCK } from '../src/world/BlockRegistry';
import { CHUNK_AREA, CHUNK_SIZE } from '../src/world/constants';
import { emptyChunk, setLocal } from './helpers';

// Same input layout the chunk worker passes: the centre chunk and its 8 neighbours,
// neighbours[(dz + 1) * 3 + (dx + 1)], plus a biome column array per chunk.
const CENTRE = 4;
const mesher = new ChunkMesher();

function neighbourhood(fill?: (chunk: Uint8Array, n: number) => void): Uint8Array[] {
  return Array.from({ length: 9 }, (_, n) => {
    const c = emptyChunk();
    fill?.(c, n);
    return c;
  });
}

const biomes = (): Uint8Array[] => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA));

function quads(g: GeometryData | null): number {
  return g ? g.index.length / 6 : 0;
}

/** Quads of one face direction (0..5 = +X −X +Y −Y +Z −Z), read from the vertex normal bits. */
function quadsFacing(g: GeometryData | null, face: number): number {
  if (!g) return 0;
  let n = 0;
  // Four vertices per quad, 4 data bytes per vertex; byte 1 holds normal | ao<<3 | flags<<5.
  for (let v = 0; v < g.data.length / 4; v += 4) if ((g.data[v * 4 + 1] & 7) === face) n++;
  return n;
}

/** Size of a quad in blocks along x and z, from its packed 1/16-block positions. */
function quadExtent(g: GeometryData, quad: number): { dx: number; dz: number } {
  const xs: number[] = [], zs: number[] = [];
  for (let k = 0; k < 4; k++) {
    xs.push(g.packed[(quad * 4 + k) * 4] / 16);
    zs.push(g.packed[(quad * 4 + k) * 4 + 2] / 16);
  }
  return { dx: Math.max(...xs) - Math.min(...xs), dz: Math.max(...zs) - Math.min(...zs) };
}

describe('ChunkMesher', () => {
  it('produces no geometry for an empty neighbourhood', () => {
    const r = mesher.mesh(neighbourhood(), biomes(), true);
    expect(r.opaque).toBeNull();
    expect(r.cutout).toBeNull();
    expect(r.water).toBeNull();
  });

  it('meshes a single isolated cube as 6 quads, one per face', () => {
    const r = mesher.mesh(neighbourhood((c, n) => n === CENTRE && setLocal(c, 8, 64, 8, BLOCK.STONE)), biomes(), true);
    expect(quads(r.opaque)).toBe(6);
    for (let f = 0; f < 6; f++) expect(quadsFacing(r.opaque, f)).toBe(1);
    expect(r.cutout).toBeNull();
    expect(r.water).toBeNull();
  });

  it('greedy-merges a flat 15×15 floor into a single top quad', () => {
    const r = mesher.mesh(neighbourhood((c, n) => {
      if (n !== CENTRE) return;
      for (let z = 0; z < 15; z++) for (let x = 0; x < 15; x++) setLocal(c, x, 40, z, BLOCK.STONE);
    }), biomes(), true);
    expect(quadsFacing(r.opaque, 2)).toBe(1);
    const top = Array.from({ length: quads(r.opaque) }, (_, q) => q).find((q) => (r.opaque!.data[q * 16 + 1] & 7) === 2)!;
    expect(quadExtent(r.opaque!, top)).toEqual({ dx: 15, dz: 15 });
  });

  it('splits a full 16×16 floor into 4 top quads (merges are capped at 15 blocks by the packed UV)', () => {
    // Floor at y = 0 in all nine chunks: the bedrock padding below hides the bottom faces
    // and the neighbours hide the sides, so only the top surface remains.
    const r = mesher.mesh(neighbourhood((c) => {
      for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) setLocal(c, x, 0, z, BLOCK.STONE);
    }), biomes(), true);
    expect(quads(r.opaque)).toBe(4);
    expect(quadsFacing(r.opaque, 2)).toBe(4);
  });

  it('culls faces between two adjacent cubes', () => {
    const r = mesher.mesh(neighbourhood((c, n) => {
      if (n !== CENTRE) return;
      setLocal(c, 8, 64, 8, BLOCK.STONE);
      setLocal(c, 9, 64, 8, BLOCK.STONE);
    }), biomes(), true);
    // 10 exposed faces; the four long sides merge pairwise when AO and light match.
    expect(quadsFacing(r.opaque, 0)).toBe(1);
    expect(quadsFacing(r.opaque, 1)).toBe(1);
    expect(quads(r.opaque)).toBeGreaterThanOrEqual(6);
    expect(quads(r.opaque)).toBeLessThanOrEqual(10);
  });
});
