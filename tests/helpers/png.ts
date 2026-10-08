import { deflateSync } from 'node:zlib';
import { crc32 } from '../../server/skins/Png';
import { PNG_SIGNATURE, SKIN_SIZE } from '../../src/skins/SkinFormat';

/** Builds PNG files for the skin tests, including broken ones: every knob a test needs to violate one rule. */
export interface PngSpec {
  width?: number;
  height?: number;
  depth?: number;
  colorType?: number;
  interlace?: number;
  /** Raw pixel bytes per scanline WITHOUT the filter byte (rowBytes * height); default a gradient. */
  pixels?: Uint8Array;
  /** Filter type per row (default 0); the encoder really filters, so decoding must undo it. */
  filter?: number | ((y: number) => number);
  palette?: Uint8Array;
  trns?: Uint8Array;
  /** Extra chunks inserted before IDAT: [type, data]. */
  extra?: [string, Uint8Array][];
  /** Replace the compressed image data. */
  idat?: Uint8Array;
  /** Break things. */
  badCrc?: 'IHDR' | 'IDAT' | 'IEND';
  noIend?: boolean;
  trailing?: Uint8Array;
  splitIdat?: boolean;
  /** Put another chunk before IHDR. */
  headFirst?: [string, Uint8Array];
  badFilterByte?: boolean;
  /** The dimensions the header claims, whatever the data is. */
  claim?: { width: number; height: number };
}

export const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function chunk(type: string, data: Uint8Array, badCrc = false): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out, 4, 8 + data.length) ^ (badCrc ? 1 : 0)) >>> 0);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function filterRows(pixels: Uint8Array, rowBytes: number, height: number, bpp: number, filter: PngSpec['filter']): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = typeof filter === 'function' ? filter(y) : filter ?? 0;
    out[y * (rowBytes + 1)] = f;
    for (let i = 0; i < rowBytes; i++) {
      const x = pixels[y * rowBytes + i];
      const a = i >= bpp ? pixels[y * rowBytes + i - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * rowBytes + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * rowBytes + i - bpp] : 0;
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0;
      out[y * (rowBytes + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  return out;
}

export function makePng(spec: PngSpec = {}): Uint8Array {
  const width = spec.width ?? SKIN_SIZE, height = spec.height ?? SKIN_SIZE;
  const depth = spec.depth ?? 8, colorType = spec.colorType ?? 6;
  const channels = CHANNELS[colorType] ?? 4;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const rows = Math.min(height, 4096);
  let pixels = spec.pixels;
  if (!pixels) {
    pixels = new Uint8Array(rowBytes * rows);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + (i >> 5)) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, spec.claim?.width ?? width);
  dv.setUint32(4, spec.claim?.height ?? height);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = spec.interlace ?? 0;
  const raw = filterRows(pixels, rowBytes, rows, Math.max(1, (channels * depth) >> 3), spec.filter);
  if (spec.badFilterByte) raw[0] = 9;
  const compressed = spec.idat ?? deflateSync(raw);
  const parts: Uint8Array[] = [Uint8Array.from(PNG_SIGNATURE)];
  if (spec.headFirst) parts.push(chunk(spec.headFirst[0], spec.headFirst[1]));
  parts.push(chunk('IHDR', ihdr, spec.badCrc === 'IHDR'));
  if (spec.palette) parts.push(chunk('PLTE', spec.palette));
  if (spec.trns) parts.push(chunk('tRNS', spec.trns));
  for (const [t, d] of spec.extra ?? []) parts.push(chunk(t, d));
  if (spec.splitIdat) {
    const mid = compressed.length >> 1;
    parts.push(chunk('IDAT', compressed.subarray(0, mid), spec.badCrc === 'IDAT'), chunk('IDAT', compressed.subarray(mid)));
  } else parts.push(chunk('IDAT', compressed, spec.badCrc === 'IDAT'));
  if (!spec.noIend) parts.push(chunk('IEND', new Uint8Array(0), spec.badCrc === 'IEND'));
  if (spec.trailing) parts.push(spec.trailing);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A recognisable RGBA skin image (64 x height): every pixel carries its own coordinates. */
export function coordinateRgba(width = SKIN_SIZE, height = SKIN_SIZE): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px[o] = 10 + x * 3; px[o + 1] = 10 + y * 3; px[o + 2] = (x * 5 + y * 11) & 0xff; px[o + 3] = 255;
    }
  }
  return px;
}

/** An RGBA PNG of the given pixels, compressed with the given filter. */
export function pngOfRgba(rgba: Uint8Array, width = SKIN_SIZE, height = SKIN_SIZE, filter: PngSpec['filter'] = 0): Uint8Array {
  return makePng({ width, height, pixels: rgba, filter });
}

/** Random-looking but reproducible bytes (a noisy skin that does not compress). */
export function noise(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = s & 0xff; }
  return out;
}
