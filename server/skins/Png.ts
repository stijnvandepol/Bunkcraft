import { deflateSync, inflateSync } from 'node:zlib';
import { PNG_SIGNATURE, SKIN_MAX_BYTES, SKIN_SIZE } from '../../src/skins/SkinFormat';

/**
 * A strict, minimal PNG decoder and encoder for skin uploads. Pure JavaScript on top of Node's zlib (no native
 * packages, no image library): a skin is untrusted input from the internet, so this reads only what it needs,
 * checks everything and fails closed.
 *
 *  - at most `maxBytes` of file, checked before anything is parsed;
 *  - the signature, then IHDR first, IEND last, nothing after it, every chunk's CRC verified;
 *  - the size must be 64x64 or 64x32 BEFORE any pixel buffer is made, the inflated data may not exceed what those
 *    dimensions need (a few KB of IDAT cannot expand into memory: `maxOutputLength`), and must match it exactly;
 *  - 8-bit grey, grey+alpha, RGB, RGBA and palette images (1/2/4/8-bit); no 16-bit, no interlacing;
 *  - animated PNG (acTL/fcTL/fdAT) and unknown critical chunks are refused; other ancillary chunks (text, gamma,
 *    colour profile...) are ignored and never copied out, because the result is re-encoded.
 */
export type PngErrorCode =
  | 'too-large' | 'not-png' | 'corrupt' | 'size' | 'animated' | 'interlaced' | 'format' | 'inflate';

export class PngError extends Error {
  constructor(readonly code: PngErrorCode, message: string) {
    super(message);
    this.name = 'PngError';
  }
}

export interface DecodedPng { width: number; height: number; rgba: Uint8Array }

const MAX_CHUNKS = 256;

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const fourcc = (dv: DataView, at: number): string => String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes a PNG file of a classic skin size into RGBA. Throws PngError for anything else. */
export function decodePng(bytes: Uint8Array, maxBytes = SKIN_MAX_BYTES): DecodedPng {
  if (bytes.length > maxBytes) throw new PngError('too-large', `file is larger than ${maxBytes} bytes`);
  if (bytes.length < 8 + 25 + 12 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new PngError('not-png', 'not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  let sawHeader = false, sawEnd = false, idatDone = false;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;

  for (let count = 0; pos < bytes.length; count++) {
    if (sawEnd) throw new PngError('corrupt', 'data after IEND');
    if (count >= MAX_CHUNKS) throw new PngError('corrupt', 'too many chunks');
    if (pos + 12 > bytes.length) throw new PngError('corrupt', 'truncated chunk');
    const len = dv.getUint32(pos);
    const type = fourcc(dv, pos + 4);
    const dataStart = pos + 8;
    if (len > bytes.length - dataStart - 4) throw new PngError('corrupt', 'chunk longer than the file');
    if (dv.getUint32(dataStart + len) !== crc32(bytes, pos + 4, dataStart + len)) throw new PngError('corrupt', `bad CRC in ${type}`);
    const data = bytes.subarray(dataStart, dataStart + len);
    pos = dataStart + len + 4;

    if (count === 0 && type !== 'IHDR') throw new PngError('corrupt', 'IHDR must come first');
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new PngError('animated', 'animated PNG');
    if (type === 'IHDR') {
      if (count !== 0 || len !== 13) throw new PngError('corrupt', 'bad IHDR');
      width = dv.getUint32(dataStart);
      height = dv.getUint32(dataStart + 4);
      depth = data[8];
      colorType = data[9];
      // The size is checked before anything is allocated for it.
      if (width !== SKIN_SIZE || (height !== SKIN_SIZE && height !== SKIN_SIZE / 2)) throw new PngError('size', `${width}x${height} is not a skin size`);
      if (data[10] !== 0 || data[11] !== 0) throw new PngError('format', 'unknown compression or filter method');
      if (data[12] === 1) throw new PngError('interlaced', 'interlaced PNG');
      if (data[12] !== 0) throw new PngError('format', 'unknown interlace method');
      const okDepth = colorType === 3 ? depth === 1 || depth === 2 || depth === 4 || depth === 8 : CHANNELS[colorType] !== undefined && depth === 8;
      if (!okDepth) throw new PngError('format', `unsupported PNG format (type ${colorType}, ${depth} bit)`);
      sawHeader = true;
    } else if (type === 'IDAT') {
      if (idatDone) throw new PngError('corrupt', 'IDAT chunks are not consecutive');
      idat.push(data);
      idatBytes += len;
    } else {
      if (idat.length > 0) idatDone = true;
      if (type === 'IEND') {
        if (len !== 0) throw new PngError('corrupt', 'bad IEND');
        sawEnd = true;
      } else if (type === 'PLTE') {
        if (idat.length > 0 || palette || len === 0 || len % 3 !== 0 || len > 768) throw new PngError('corrupt', 'bad PLTE');
        palette = data;
      } else if (type === 'tRNS') {
        if (idat.length > 0) throw new PngError('corrupt', 'tRNS after IDAT');
        trns = data;
      } else if ((type.charCodeAt(0) & 0x20) === 0) {
        throw new PngError('format', `unsupported critical chunk ${type}`);
      }
    }
  }
  if (!sawHeader || !sawEnd) throw new PngError('corrupt', 'missing IHDR or IEND');
  if (idatBytes === 0) throw new PngError('corrupt', 'no image data');
  if (colorType === 3 && !palette) throw new PngError('corrupt', 'palette image without a palette');

  const channels = CHANNELS[colorType];
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const expected = (rowBytes + 1) * height;
  const joined = new Uint8Array(idatBytes);
  let at = 0;
  for (const part of idat) { joined.set(part, at); at += part.length; }
  let raw: Buffer;
  try {
    // One byte more than needed: data that inflates beyond the exact size throws instead of being truncated.
    raw = inflateSync(joined, { maxOutputLength: expected + 1 });
  } catch {
    throw new PngError('inflate', 'image data is damaged or inflates to more than a skin can hold');
  }
  if (raw.length !== expected) throw new PngError('inflate', 'image data has the wrong length');

  // Undo the scanline filters in place.
  const bpp = Math.max(1, (channels * depth) >> 3);
  const prev = new Uint8Array(rowBytes);
  const cur = new Uint8Array(rowBytes);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const line = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    if (filter > 4) throw new PngError('corrupt', 'unknown scanline filter');
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    expandRow(cur, y, width, depth, colorType, palette, trns, rgba);
    prev.set(cur);
  }
  return { width, height, rgba };
}

/** One unfiltered scanline to RGBA. */
function expandRow(
  row: Uint8Array, y: number, width: number, depth: number, colorType: number,
  palette: Uint8Array | null, trns: Uint8Array | null, out: Uint8Array,
): void {
  let o = y * width * 4;
  for (let x = 0; x < width; x++, o += 4) {
    if (colorType === 6) {
      out[o] = row[x * 4]; out[o + 1] = row[x * 4 + 1]; out[o + 2] = row[x * 4 + 2]; out[o + 3] = row[x * 4 + 3];
    } else if (colorType === 2) {
      const r = row[x * 3], g = row[x * 3 + 1], b = row[x * 3 + 2];
      const keyed = !!trns && trns.length >= 6 && trns[0] === 0 && trns[1] === r && trns[2] === 0 && trns[3] === g && trns[4] === 0 && trns[5] === b;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = keyed ? 0 : 255;
    } else if (colorType === 4) {
      out[o] = out[o + 1] = out[o + 2] = row[x * 2]; out[o + 3] = row[x * 2 + 1];
    } else if (colorType === 0) {
      const g = row[x];
      const keyed = !!trns && trns.length >= 2 && trns[0] === 0 && trns[1] === g;
      out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = keyed ? 0 : 255;
    } else {
      // Palette: depth bits per pixel, most significant first.
      const perByte = 8 / depth;
      const byte = row[Math.floor(x / perByte)];
      const shift = 8 - depth * ((x % perByte) + 1);
      const index = (byte >> shift) & ((1 << depth) - 1);
      if (index * 3 + 2 >= palette!.length) throw new PngError('corrupt', 'palette index out of range');
      out[o] = palette![index * 3]; out[o + 1] = palette![index * 3 + 1]; out[o + 2] = palette![index * 3 + 2];
      out[o + 3] = trns && index < trns.length ? trns[index] : 255;
    }
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** An 8-bit RGBA PNG with nothing but IHDR, IDAT and IEND: the canonical file we store and serve. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
