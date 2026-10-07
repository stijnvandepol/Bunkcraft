import { describe, expect, it } from 'vitest';
import { encodePackBundle, readPackFolder } from '../scripts/vite-texture-pack';
import { findBuiltinPack, parsePackBundle } from '../src/rendering/TexturePacks';

const PIXEL_PERFECTION = findBuiltinPack('pixel-perfection')!.layout;

describe('built-in texture pack bundle (one request instead of one per PNG)', () => {
  const folder = readPackFolder('public/texturepacks/pixel-perfection');

  it('round-trips every PNG of the folder byte for byte', () => {
    const bytes = encodePackBundle(folder);
    const back = parsePackBundle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)!;
    expect(back.size).toBe(folder.size);
    for (const [name, png] of folder) expect(Buffer.compare(Buffer.from(back.get(name)!), Buffer.from(png))).toBe(0);
  });

  it('contains every file the default layout uses', () => {
    const used = new Set<string>();
    for (const spec of Object.values(PIXEL_PERFECTION.textures)) {
      for (const alt of spec.split('|')) for (const layer of alt.split('*')[0].split('^')) used.add(layer.split('@')[0]);
    }
    // Every texture has at least one alternative fully inside the folder.
    for (const spec of Object.values(PIXEL_PERFECTION.textures)) {
      const ok = spec.split('|').some((alt) => alt.split('*')[0].split('^').every((l) => folder.has(l.split('@')[0])));
      expect(ok, spec).toBe(true);
    }
    expect(used.size).toBeGreaterThan(20);
  });

  it('rejects malformed bundles', () => {
    const bytes = encodePackBundle(new Map([['a', new Uint8Array([1, 2, 3])]]));
    const buf = bytes.buffer.slice(0) as ArrayBuffer;
    expect(parsePackBundle(buf.slice(0, buf.byteLength - 1))).toBeNull();
    expect(parsePackBundle(new ArrayBuffer(4))).toBeNull();
    const bad = new Uint8Array(buf.slice(0));
    bad[0] = 0;
    expect(parsePackBundle(bad.buffer as ArrayBuffer)).toBeNull();
  });
});
