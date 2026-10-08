/**
 * Player skins: the classic 64x64 layout (Minecraft 1.8+), shared by the browser and the server.
 *
 * Our player model is the classic one (8x8x8 head, 8x12x4 body, 4x12x4 arms and legs, 16 px = 1 block), so a
 * classic skin maps onto it with the usual box-UV unfolding. Everything here is DOM-free pixel work on RGBA
 * arrays: the server uses it to turn any accepted upload into ONE canonical form (so equal skins dedup and
 * nothing hidden survives), the browser uses the same code to show a local file exactly as others will see it.
 *
 * Accepted input: 64x64 or the legacy 64x32 (left limbs mirrored from the right ones), wide ("Steve") arms or
 * slim ("Alex", detected by the transparent outer arm columns, widened to 4 px). Canonical form: 64x64 RGBA,
 * the base layer opaque, the overlay layer (hat, jacket, sleeves, pants) transparent or opaque, every unused
 * pixel (the corners of each box net and the free strip right of the arms) cleared.
 */
export const SKIN_SIZE = 64;
/** A skin file (PNG) may be at most this large, before and after our re-encoding. */
export const SKIN_MAX_BYTES = 16 * 1024;
export const SKIN_PIXELS = SKIN_SIZE * SKIN_SIZE;
export const SKIN_RGBA_BYTES = SKIN_PIXELS * 4;

/** Skin ids are the sha256 (hex) of the canonical RGBA pixels. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const isSkinHash = (v: unknown): v is string => typeof v === 'string' && HASH_PATTERN.test(v);

/** A box of the model in the skin: net origin (u, v) and size in pixels. */
export interface SkinBox { u: number; v: number; w: number; h: number; d: number }

/** The model's boxes in the classic layout. "Left"/"right" are the player's own. */
export const SKIN_BOXES = {
  head: { u: 0, v: 0, w: 8, h: 8, d: 8 },
  hat: { u: 32, v: 0, w: 8, h: 8, d: 8 },
  body: { u: 16, v: 16, w: 8, h: 12, d: 4 },
  jacket: { u: 16, v: 32, w: 8, h: 12, d: 4 },
  rightArm: { u: 40, v: 16, w: 4, h: 12, d: 4 },
  rightSleeve: { u: 40, v: 32, w: 4, h: 12, d: 4 },
  leftArm: { u: 32, v: 48, w: 4, h: 12, d: 4 },
  leftSleeve: { u: 48, v: 48, w: 4, h: 12, d: 4 },
  rightLeg: { u: 0, v: 16, w: 4, h: 12, d: 4 },
  rightPants: { u: 0, v: 32, w: 4, h: 12, d: 4 },
  leftLeg: { u: 16, v: 48, w: 4, h: 12, d: 4 },
  leftPants: { u: 0, v: 48, w: 4, h: 12, d: 4 },
} as const satisfies Record<string, SkinBox>;

/** Boxes of the opaque base layer; the others are the overlay layer. */
const BASE_BOXES: SkinBox[] = [SKIN_BOXES.head, SKIN_BOXES.body, SKIN_BOXES.rightArm, SKIN_BOXES.leftArm, SKIN_BOXES.rightLeg, SKIN_BOXES.leftLeg];
const OVERLAY_BOXES: SkinBox[] = [SKIN_BOXES.hat, SKIN_BOXES.jacket, SKIN_BOXES.rightSleeve, SKIN_BOXES.leftSleeve, SKIN_BOXES.rightPants, SKIN_BOXES.leftPants];

/**
 * A strip no classic box uses (right of the right arm): the renderer paints it white and points the team head band
 * at it, so the band's colour comes from a per-part tint instead of from the player's skin.
 */
export const SOLID_STRIP = { x: 56, y: 16, w: 8, h: 16 } as const;

/** The six faces of a box net as [x, y, w, h] relative to the box origin (Minecraft box UV): top, bottom, right side, front, left side, back. */
export function faceRects(b: SkinBox): [number, number, number, number][] {
  const { w, h, d } = b;
  return [
    [d, 0, w, d], // top
    [d + w, 0, w, d], // bottom
    [0, d, d, h], // right side
    [d, d, w, h], // front
    [d + w, d, d, h], // left side
    [2 * d + w, d, w, h], // back
  ];
}

function buildMask(boxes: SkinBox[]): Uint8Array {
  const mask = new Uint8Array(SKIN_PIXELS);
  for (const b of boxes) {
    for (const [fx, fy, fw, fh] of faceRects(b)) {
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) mask[(b.v + fy + y) * SKIN_SIZE + b.u + fx + x] = 1;
    }
  }
  return mask;
}

const BASE_MASK = buildMask(BASE_BOXES);
const OVERLAY_MASK = buildMask(OVERLAY_BOXES);

/** True for pixels that belong to a face of some box (the rest of a skin is never read). */
export const isUsedPixel = (x: number, y: number): boolean => (BASE_MASK[y * SKIN_SIZE + x] | OVERLAY_MASK[y * SKIN_SIZE + x]) === 1;

type Pixels = Uint8Array | Uint8ClampedArray;

/** Copies a w x h rectangle, optionally mirrored left-right; source and destination must not overlap. */
function copyRect(px: Pixels, sx: number, sy: number, dx: number, dy: number, w: number, h: number, flip: boolean): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = ((sy + y) * SKIN_SIZE + sx + (flip ? w - 1 - x : x)) * 4;
      const to = ((dy + y) * SKIN_SIZE + dx + x) * 4;
      px[to] = px[from]; px[to + 1] = px[from + 1]; px[to + 2] = px[from + 2]; px[to + 3] = px[from + 3];
    }
  }
}

/** Mirrors one whole box net from the right limb to the left one (the legacy 64x32 format has only the right ones). */
function mirrorLimb(px: Pixels, from: SkinBox, to: SkinBox): void {
  const { w, h, d } = from;
  // Top and bottom flip in place; right and left sides swap places and flip; front and back flip.
  copyRect(px, from.u + d, from.v, to.u + d, to.v, w, d, true);
  copyRect(px, from.u + d + w, from.v, to.u + d + w, to.v, w, d, true);
  copyRect(px, from.u, from.v + d, to.u + d + w, to.v + d, d, h, true);
  copyRect(px, from.u + d, from.v + d, to.u + d, to.v + d, w, h, true);
  copyRect(px, from.u + d + w, from.v + d, to.u, to.v + d, d, h, true);
  copyRect(px, from.u + 2 * d + w, from.v + d, to.u + 2 * d + w, to.v + d, w, h, true);
}

/** Alpha of the outer back columns of both arms in a slim ("Alex") skin: those pixels do not exist there. */
function isSlim(px: Pixels): boolean {
  const spots: [number, number][] = [[54, 20], [46, 52]];
  for (const [x0, y0] of spots) {
    for (let y = y0; y < y0 + 12; y++) for (let x = x0; x < x0 + 2; x++) if (px[(y * SKIN_SIZE + x) * 4 + 3] >= 128) return false;
  }
  return true;
}

/** Stretches the 3 px wide faces of a slim arm net to the 4 px wide net of the model (the middle column doubles). */
function widenArm(px: Pixels, u: number, v: number): void {
  const src = Uint8Array.from(px.subarray(0, SKIN_RGBA_BYTES));
  const put = (sx: number, sy: number, dx: number, dy: number, w: number, h: number, outW: number) => {
    const cols = outW === 4 && w === 3 ? [0, 1, 1, 2] : [0, 1, 2, 3];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < outW; x++) {
        const from = ((sy + y) * SKIN_SIZE + sx + cols[x]) * 4;
        const to = ((dy + y) * SKIN_SIZE + dx + x) * 4;
        px[to] = src[from]; px[to + 1] = src[from + 1]; px[to + 2] = src[from + 2]; px[to + 3] = src[from + 3];
      }
    }
  };
  // Slim net: top at +4 (3 wide), bottom at +7, right side at +0, front at +4, left side at +7 (4 wide), back at +11.
  // Wide net: top +4, bottom +8, right +0, front +4, left +8, back +12 (all 4 wide).
  put(u + 4, v, u + 4, v, 3, 4, 4);
  put(u + 7, v, u + 8, v, 3, 4, 4);
  put(u, v + 4, u, v + 4, 4, 12, 4);
  put(u + 4, v + 4, u + 4, v + 4, 3, 12, 4);
  put(u + 7, v + 4, u + 8, v + 4, 4, 12, 4);
  put(u + 11, v + 4, u + 12, v + 4, 3, 12, 4);
}

/**
 * The canonical 64x64 RGBA skin for decoded pixels of 64x64 or 64x32, or null for any other size. `rgba` is not
 * changed. Legacy skins get their left limbs mirrored, slim arms are widened, the base layer becomes opaque, the
 * overlay layer binary (opaque or fully transparent, colour cleared where transparent), unused pixels are cleared.
 */
export function canonicalSkin(rgba: Pixels, width: number, height: number): Uint8Array | null {
  if (width !== SKIN_SIZE || (height !== SKIN_SIZE && height !== SKIN_SIZE / 2)) return null;
  if (rgba.length < width * height * 4) return null;
  const px = new Uint8Array(SKIN_RGBA_BYTES);
  px.set(rgba.subarray(0, width * height * 4));
  if (height === SKIN_SIZE / 2) {
    mirrorLimb(px, SKIN_BOXES.rightLeg, SKIN_BOXES.leftLeg);
    mirrorLimb(px, SKIN_BOXES.rightArm, SKIN_BOXES.leftArm);
  } else if (isSlim(px)) {
    widenArm(px, SKIN_BOXES.rightArm.u, SKIN_BOXES.rightArm.v);
    widenArm(px, SKIN_BOXES.rightSleeve.u, SKIN_BOXES.rightSleeve.v);
    widenArm(px, SKIN_BOXES.leftArm.u, SKIN_BOXES.leftArm.v);
    widenArm(px, SKIN_BOXES.leftSleeve.u, SKIN_BOXES.leftSleeve.v);
  }
  for (let i = 0; i < SKIN_PIXELS; i++) {
    const o = i * 4;
    if (BASE_MASK[i]) {
      px[o + 3] = 255;
    } else if (OVERLAY_MASK[i]) {
      if (px[o + 3] >= 128) px[o + 3] = 255;
      else { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0; }
    } else {
      px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
    }
  }
  return px;
}

/** One-line explanation for a rejected file, shown in the upload dialog. */
export type SkinErrorCode =
  | 'not-png' | 'too-large' | 'size' | 'corrupt' | 'animated' | 'interlaced' | 'format' | 'banned' | 'rate' | 'storage' | 'disabled' | 'auth' | 'network';

/** The first bytes of every PNG file. */
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Cheap client-side checks on the raw file: the size, the PNG signature and the IHDR dimensions. The server does
 * the real validation; this only saves a round trip and gives a clear message. Null = looks fine.
 */
export function checkSkinBytes(bytes: Uint8Array): SkinErrorCode | null {
  if (bytes.length > SKIN_MAX_BYTES) return 'too-large';
  if (bytes.length < 33 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return 'not-png';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR must come first: length 13, "IHDR", then width and height.
  if (dv.getUint32(8) !== 13 || dv.getUint32(12) !== 0x49484452) return 'corrupt';
  const w = dv.getUint32(16), h = dv.getUint32(20);
  return w === SKIN_SIZE && (h === SKIN_SIZE || h === SKIN_SIZE / 2) ? null : 'size';
}
