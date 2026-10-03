/**
 * Draws the PWA icons, the apple-touch-icon and the social preview image procedurally
 * (a pixel-art grass block, in the style of the favicon) and writes them to public/.
 *
 *   npx tsx scripts/make-icons.ts
 *
 * The outputs are committed, so a normal build does not need to run this.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

type RGB = [number, number, number];
const GRASS: RGB = [0x5d, 0x9c, 0x34];
const GRASS_DARK: RGB = [0x48, 0x7e, 0x28];
const DIRT: RGB = [0x86, 0x60, 0x41];
const DIRT_DARK: RGB = [0x5e, 0x41, 0x30];
const BG: RGB = [0x1c, 0x1a, 0x18];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

class Image {
  readonly px: Buffer;
  constructor(readonly w: number, readonly h: number) { this.px = Buffer.alloc(w * h * 3); }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 3;
        this.px[o] = c[0]; this.px[o + 1] = c[1]; this.px[o + 2] = c[2];
      }
    }
  }
  png(): Buffer {
    const stride = this.w * 3 + 1;
    const raw = Buffer.alloc(stride * this.h);
    for (let y = 0; y < this.h; y++) this.px.copy(raw, y * stride + 1, y * this.w * 3, (y + 1) * this.w * 3);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

/** Deterministic hash noise for the block texture. */
function noise(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** A 16×16 grass block face, drawn with cells of `cell` pixels at (ox, oy). */
function block(img: Image, ox: number, oy: number, cell: number): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const n = noise(x, y);
      const grassDepth = 4 + Math.floor(noise(x, 99) * 3); // ragged grass edge
      let c: RGB;
      if (y < grassDepth - 2) c = n < 0.5 ? GRASS : GRASS_DARK;
      else if (y < grassDepth) c = n < 0.35 ? GRASS_DARK : GRASS;
      else c = n < 0.3 ? DIRT_DARK : DIRT;
      img.rect(ox + x * cell, oy + y * cell, cell, cell, c);
    }
  }
}

const GLYPHS: Record<string, string[]> = {
  B: ['1110', '1001', '1110', '1001', '1001', '1001', '1110'],
  U: ['1001', '1001', '1001', '1001', '1001', '1001', '0110'],
  N: ['1001', '1101', '1101', '1011', '1011', '1001', '1001'],
  K: ['1001', '1010', '1100', '1100', '1010', '1001', '1001'],
  C: ['0111', '1000', '1000', '1000', '1000', '1000', '0111'],
  R: ['1110', '1001', '1001', '1110', '1010', '1001', '1001'],
  A: ['0110', '1001', '1001', '1111', '1001', '1001', '1001'],
  F: ['1111', '1000', '1110', '1000', '1000', '1000', '1000'],
  T: ['1111', '0110', '0110', '0110', '0110', '0110', '0110'],
};

function text(img: Image, s: string, x: number, y: number, cell: number, c: RGB, shadow: RGB): void {
  let cx = x;
  for (const ch of s) {
    const g = GLYPHS[ch];
    for (const [color, d] of [[shadow, cell], [c, 0]] as const) {
      g.forEach((row, j) => [...row].forEach((v, i) => {
        if (v === '1') img.rect(cx + i * cell + d, y + j * cell + d, cell, cell, color);
      }));
    }
    cx += 6 * cell;
  }
}

/** Square icon; `scale` is the share of the canvas the block takes (maskable icons stay in the safe zone). */
function icon(size: number, scale: number): Image {
  const img = new Image(size, size);
  img.rect(0, 0, size, size, BG);
  const cell = Math.max(1, Math.floor((size * scale) / 16));
  const side = cell * 16;
  const o = Math.floor((size - side) / 2);
  img.rect(o - cell, o - cell, side + cell * 2, side + cell * 2, [0x0c, 0x0b, 0x0a]);
  block(img, o, o, cell);
  return img;
}

function social(): Image {
  const img = new Image(1200, 630);
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 40; x++) {
      img.rect(x * 30, y * 30, 30, 30, noise(x, y + 500) < 0.5 ? [0x26, 0x22, 0x1f] : [0x22, 0x1e, 0x1b]);
    }
  }
  block(img, 80, 115, 25);
  text(img, 'BUNKCRAFT', 540, 200, 11, [0xf0, 0xf0, 0xf0], [0x3a, 0x3a, 0x3a]);
  img.rect(540, 340, 9 * 6 * 11 - 11, 12, GRASS);
  img.rect(540, 352, 9 * 6 * 11 - 11, 12, DIRT);
  return img;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', icon(192, 0.78).png());
writeFileSync('public/icons/icon-512.png', icon(512, 0.78).png());
writeFileSync('public/icons/icon-maskable-192.png', icon(192, 0.56).png());
writeFileSync('public/icons/icon-maskable-512.png', icon(512, 0.56).png());
writeFileSync('public/icons/apple-touch-icon.png', icon(180, 0.78).png());
writeFileSync('public/icons/social-preview.png', social().png());
writeFileSync('public/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" shape-rendering="crispEdges"><rect width="4" height="1" fill="#5d9c34"/><rect y="1" width="4" height="3" fill="#866041"/><rect x="1" y="2" width="1" height="1" fill="#5e4130"/></svg>\n');
console.log('Icons written to public/icons');
