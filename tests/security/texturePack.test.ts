import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PACK_LIMITS, importMinecraftArchive, isSafePng } from '../../src/rendering/TexturePacks';

/** PNG header-only stub: signature + IHDR (the importer only reads the header). */
function pngStub(w: number, h: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

const NAMES = ['stone', 'dirt', 'cobblestone', 'oak_planks', 'sand', 'gravel', 'bedrock', 'obsidian', 'glass', 'bricks', 'tnt_side', 'tnt_top'];
function zipOf(entries: Record<string, Uint8Array>): File {
  return new File([zipSync(entries, { level: 9 }) as BlobPart], 'pack.zip');
}
const entry = (n: string) => `assets/minecraft/textures/block/${n}.png`;
function base(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const n of NAMES) files[entry(n)] = pngStub(16, 16);
  return files;
}

describe('importMinecraftArchive limits', () => {
  it('accepts a normal pack', async () => {
    const pack = await importMinecraftArchive(zipOf(base()));
    expect(Object.keys(pack.files).length).toBeGreaterThanOrEqual(10);
  });

  it('skips a zip-bomb texture (huge once inflated)', async () => {
    const files = base();
    files[entry('stone')] = pngStub(16, 16, PACK_LIMITS.fileBytes * 4); // 16 MB of zeros compresses to ~16 KB
    const pack = await importMinecraftArchive(zipOf(files));
    expect(pack.files.stone).toBeUndefined();
    expect(pack.files.dirt).toBeDefined();
  });

  it('skips textures with absurd dimensions and non-PNG data', async () => {
    const files = base();
    files[entry('stone')] = pngStub(60_000, 60_000);
    files[entry('dirt')] = new Uint8Array(100).fill(7);
    const pack = await importMinecraftArchive(zipOf(files));
    expect(pack.files.stone).toBeUndefined();
    expect(pack.files.dirt).toBeUndefined();
  });

  it('ignores path traversal names and files outside the texture folder', async () => {
    const files = base();
    files['assets/minecraft/textures/block/../../../../evil.png'] = pngStub(16, 16);
    files['../../etc/passwd'] = new Uint8Array(10);
    const pack = await importMinecraftArchive(zipOf(files));
    expect(Object.keys(pack.files).every((k) => /^[a-z0-9_]+$/.test(k))).toBe(true);
  });

  it('rejects an archive with too few textures and garbage input', async () => {
    await expect(importMinecraftArchive(zipOf({ 'readme.txt': new Uint8Array(3) }))).rejects.toThrow();
    await expect(importMinecraftArchive(new File([new Uint8Array(50).fill(1)], 'x.zip'))).rejects.toBeDefined();
  });

  it('isSafePng checks signature and size', () => {
    expect(isSafePng(pngStub(16, 16))).toBe(true);
    expect(isSafePng(pngStub(0, 16))).toBe(false);
    expect(isSafePng(pngStub(100_000, 16))).toBe(false);
    expect(isSafePng(new Uint8Array(40))).toBe(false);
  });
});
