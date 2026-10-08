import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PngError, decodePng, encodePng } from '../server/skins/Png';
import { SKIN_MAX_BYTES } from '../src/skins/SkinFormat';
import { chunk, coordinateRgba, makePng, noise, pngOfRgba } from './helpers/png';

function code(bytes: Uint8Array): string {
  try {
    decodePng(bytes);
  } catch (e) {
    if (e instanceof PngError) return e.code;
    throw e;
  }
  return 'ok';
}

describe('skin PNG decoder', () => {
  it('decodes a valid 64x64 RGBA file exactly', () => {
    const rgba = coordinateRgba();
    const png = decodePng(pngOfRgba(rgba));
    expect(png.width).toBe(64);
    expect(png.height).toBe(64);
    expect(Buffer.from(png.rgba).equals(Buffer.from(rgba))).toBe(true);
  });

  it('undoes every scanline filter', () => {
    const rgba = coordinateRgba();
    for (const filter of [1, 2, 3, 4, (y: number) => y % 5]) {
      expect(Buffer.from(decodePng(pngOfRgba(rgba, 64, 64, filter)).rgba).equals(Buffer.from(rgba))).toBe(true);
    }
  });

  it('accepts the legacy 64x32 size and IDAT split over several chunks', () => {
    const rgba = coordinateRgba(64, 32);
    const png = decodePng(makePng({ height: 32, pixels: rgba, splitIdat: true }));
    expect(png.height).toBe(32);
    expect(Buffer.from(png.rgba).equals(Buffer.from(rgba))).toBe(true);
  });

  it('decodes RGB, grey, grey+alpha and palette images to RGBA', () => {
    const rgb = new Uint8Array(64 * 64 * 3).map((_, i) => (i * 3) & 0xff);
    const a = decodePng(makePng({ colorType: 2, pixels: rgb, filter: 1 }));
    expect([...a.rgba.subarray(0, 8)]).toEqual([rgb[0], rgb[1], rgb[2], 255, rgb[3], rgb[4], rgb[5], 255]);

    const grey = new Uint8Array(64 * 64).map((_, i) => i & 0xff);
    const g = decodePng(makePng({ colorType: 0, pixels: grey, filter: 2 }));
    expect([...g.rgba.subarray(4, 8)]).toEqual([1, 1, 1, 255]);

    const ga = new Uint8Array(64 * 64 * 2).map((_, i) => (i % 2 ? 77 : (i >> 1) & 0xff));
    const gd = decodePng(makePng({ colorType: 4, pixels: ga, filter: 3 }));
    expect([...gd.rgba.subarray(4, 8)]).toEqual([1, 1, 1, 77]);

    const palette = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const trns = Uint8Array.from([255, 128]);
    for (const depth of [8, 4, 2]) {
      const rowBytes = Math.ceil((64 * depth) / 8);
      const idx = new Uint8Array(rowBytes * 64);
      // Pixel x of every row uses palette entry x % 3 (packed most significant first).
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const bit = x * depth, byte = y * rowBytes + (bit >> 3);
          idx[byte] |= (x % 3) << (8 - depth - (bit & 7));
        }
      }
      const p = decodePng(makePng({ colorType: 3, depth, pixels: idx, palette, trns, filter: 4 }));
      expect([...p.rgba.subarray(0, 12)], `depth ${depth}`).toEqual([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]);
    }
  });

  it('re-encodes to a canonical RGBA PNG that decodes to the same pixels and stays under 16 KB', () => {
    const rgba = coordinateRgba();
    const again = decodePng(encodePng(rgba, 64, 64));
    expect(Buffer.from(again.rgba).equals(Buffer.from(rgba))).toBe(true);
    // Noise in every used pixel of a skin (13 056 bytes) is the worst case the canonical file has to fit.
    const used = new Uint8Array(64 * 64 * 4);
    used.set(noise(13056, 9));
    expect(encodePng(used, 64, 64).length).toBeLessThan(SKIN_MAX_BYTES);
  });

  it('rejects wrong sizes before looking at pixels', () => {
    expect(code(pngOfRgba(coordinateRgba(32, 32), 32, 32))).toBe('size');
    expect(code(pngOfRgba(new Uint8Array(128 * 128 * 4), 128, 128))).toBe('size');
    expect(code(makePng({ width: 64, height: 48, pixels: new Uint8Array(64 * 48 * 4) }))).toBe('size');
    // A header that claims 100000 x 100000 must not allocate anything.
    expect(code(makePng({ claim: { width: 100000, height: 100000 } }))).toBe('size');
  });

  it('rejects corrupt files', () => {
    const good = pngOfRgba(coordinateRgba());
    expect(code(good)).toBe('ok');
    expect(code(makePng({ badCrc: 'IDAT' }))).toBe('corrupt');
    expect(code(makePng({ badCrc: 'IHDR' }))).toBe('corrupt');
    expect(code(makePng({ badCrc: 'IEND' }))).toBe('corrupt');
    expect(code(makePng({ noIend: true }))).toBe('corrupt');
    expect(code(good.subarray(0, good.length - 20))).toBe('corrupt');
    expect(code(makePng({ trailing: Uint8Array.from([1, 2, 3, 4]) }))).toBe('corrupt');
    expect(code(makePng({ headFirst: ['tEXt', new Uint8Array(4)] }))).toBe('corrupt');
    expect(code(makePng({ badFilterByte: true }))).toBe('corrupt');
    // Compressed data of the wrong length, or not zlib at all.
    expect(code(makePng({ idat: deflateSync(new Uint8Array(100)) }))).toBe('inflate');
    expect(code(makePng({ idat: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) }))).toBe('inflate');
    // A flipped byte in the middle of the image data fails the CRC.
    const flipped = good.slice();
    flipped[good.length - 40] ^= 0xff;
    expect(code(flipped)).toBe('corrupt');
  });

  it('rejects files that are not PNG: SVG, garbage, other image formats, empty input', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
    expect(code(svg)).toBe('not-png');
    expect(code(new Uint8Array(0))).toBe('not-png');
    expect(code(noise(2000, 3))).toBe('not-png');
    expect(code(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('not-png');
    expect(code(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(80).fill(0)]))).toBe('not-png');
    expect(code(Buffer.from(`GIF89a${'\0'.repeat(80)}`))).toBe('not-png');
    // An SVG hidden after a valid signature is just corrupt.
    expect(code(Buffer.concat([Buffer.from(pngOfRgba(coordinateRgba())).subarray(0, 8), svg, Buffer.alloc(30)]))).toBe('corrupt');
  });

  it('rejects files over 16 KB however valid they are', () => {
    const fat = makePng({ extra: [['tEXt', new Uint8Array(SKIN_MAX_BYTES)]] });
    expect(fat.length).toBeGreaterThan(SKIN_MAX_BYTES);
    expect(code(fat)).toBe('too-large');
  });

  it('does not inflate a zip-bomb IDAT: a few KB of zeros that claim megabytes', () => {
    // 14 MB of zeros deflate to about 14 KB: a valid-looking file that wants far more memory than a skin has.
    const bomb = deflateSync(new Uint8Array(14 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(SKIN_MAX_BYTES - 200);
    const file = makePng({ idat: bomb });
    expect(file.length).toBeLessThan(SKIN_MAX_BYTES);
    const t0 = performance.now();
    expect(code(file)).toBe('inflate');
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('rejects animated PNG, interlacing, 16-bit and unknown critical chunks', () => {
    expect(code(makePng({ extra: [['acTL', new Uint8Array(8)]] }))).toBe('animated');
    expect(code(makePng({ extra: [['fcTL', new Uint8Array(26)]] }))).toBe('animated');
    expect(code(makePng({ interlace: 1 }))).toBe('interlaced');
    expect(code(makePng({ depth: 16, pixels: new Uint8Array(64 * 64 * 8) }))).toBe('format');
    expect(code(makePng({ extra: [['XYZW', new Uint8Array(4)]] }))).toBe('format');
    // Unknown ancillary chunks (lowercase first letter) are simply ignored.
    expect(code(makePng({ extra: [['abCD', new Uint8Array(4)], ['tEXt', Buffer.from('Comment\0hi')]] }))).toBe('ok');
  });

  it('refuses a palette image without a palette', () => {
    expect(code(makePng({ colorType: 3, pixels: new Uint8Array(64 * 64) }))).toBe('corrupt');
    expect(code(chunk('IHDR', new Uint8Array(13)))).toBe('not-png');
  });
});
