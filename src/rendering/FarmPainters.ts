import { type Img, type RGB, type Rand, hex } from './PaintKit';

/**
 * Procedural crop textures (see world/Crops.ts). Each crop has one 16×16 texture, its ripe look; the mesher shows a
 * shorter cut of it for younger stages (the top part for root crops, so the roots appear only when ripe, the bottom
 * part for wheat and stems) and tints it per stage. Wheat and the stems are painted in grey: the stage tint colours them.
 * Row 0 is the top of the picture.
 */
type Painter = (img: Img, r: Rand) => void;
export const FARM_PAINTERS: Record<string, Painter> = {};

function line(img: Img, pts: [number, number][], c: RGB): void {
  for (const [x, y] of pts) img.set(x, y, c);
}

/** A stalk from (x, 15) up to `top`, wavering a little; returns the x it ended on. */
function stalk(img: Img, r: Rand, x: number, top: number, c: RGB, dark: RGB): number {
  let cx = x;
  for (let y = 15; y >= top; y--) {
    img.set(cx, y, y > 12 ? dark : c);
    if (y < 12 && r() < 0.15) cx += r() < 0.5 ? -1 : 1;
    cx = Math.max(0, Math.min(15, cx));
  }
  return cx;
}

FARM_PAINTERS.wheat_crop = (img, r) => {
  img.clear();
  // Grey values only: the stage tint makes them green or golden.
  // No side leaves: young stages show the bottom of this picture, plain stalks read as shoots there.
  const stem = hex('#a8a8a8'), stemDark = hex('#8a8a8a'), ear = hex('#e2e2e2'), earDark = hex('#9c9c9c');
  for (const x0 of [1, 4, 7, 10, 13]) {
    const top = 4 + Math.floor(r() * 3);
    const x = stalk(img, r, x0 + (r() < 0.5 ? 0 : 1), top + 4, stem, stemDark);
    // The ear: two columns of grains, alternating light and dark, over the top of the stalk.
    for (let y = top; y < top + 5; y++) {
      img.set(x, y, (y & 1) ? ear : earDark);
      img.set(Math.min(15, x + 1), y, (y & 1) ? earDark : ear);
    }
    img.set(x, top - 1, ear);
  }
};

/** A feathery stalk (carrot tops): a 1 px stem from the soil to `top` with leaflets alternating left and right. */
function feather(img: Img, r: Rand, x0: number, top: number, stem: RGB, leaf: RGB, tip: RGB): void {
  let x = x0;
  for (let y = 12; y >= top; y--) {
    img.set(x, y, y - top < 2 ? tip : stem);
    img.set((y + x0) % 2 === 0 ? x - 1 : x + 1, y, leaf);
    if (y < 9 && r() < 0.25) x += x0 < 8 ? -1 : 1;
    x = Math.max(1, Math.min(14, x));
  }
}

/** A broad leaf: an oval of `w`×`h` with a darker midrib, centred at (cx, cy). */
function broadLeaf(img: Img, cx: number, cy: number, w: number, h: number, leaf: RGB, rib: RGB): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if ((dy === 0 || dy === h - 1) && (dx === 0 || dx === w - 1)) continue;
      img.set(cx - (w >> 1) + dx, cy - (h >> 1) + dy, dx === (w >> 1) ? rib : leaf);
    }
  }
}

FARM_PAINTERS.carrots_crop = (img, r) => {
  img.clear();
  const stem = hex('#3f8f2a'), leaf = hex('#5cb83c'), tip = hex('#7acc4e');
  for (const [x, top] of [[2, 4], [4, 1], [6, 3], [9, 2], [11, 0], [13, 3]] as [number, number][]) feather(img, r, x, top + Math.floor(r() * 2), stem, leaf, tip);
  // Orange carrot tops in the soil line.
  for (const x0 of [2, 7, 12]) {
    line(img, [[x0, 13], [x0 + 1, 13], [x0, 14], [x0 + 1, 14], [x0, 15]], hex('#e8821e'));
    img.set(x0 + 1, 15, hex('#c86812'));
  }
};

FARM_PAINTERS.potatoes_crop = (img, r) => {
  img.clear();
  const stem = hex('#2f6b21'), leaf = hex('#3f8a2c'), dark = hex('#2a5f1d'), light = hex('#55a33a');
  // Upright stalks carrying broad oval leaves (potato plants are bushier and darker than carrots).
  for (const x0 of [3, 7, 12]) for (let y = 12; y >= 4; y--) img.set(x0, y, stem);
  const leaves: [number, number, number, number][] = [[2, 3, 3, 4], [5, 6, 4, 3], [8, 2, 3, 4], [11, 5, 4, 3], [13, 2, 3, 4], [3, 9, 4, 3], [10, 9, 4, 3], [7, 7, 3, 3]];
  for (const [cx, cy, w, h] of leaves) broadLeaf(img, cx, cy, w, h, r() < 0.5 ? leaf : light, dark);
  // Potatoes peeking out of the soil.
  for (const x0 of [2, 8, 12]) {
    line(img, [[x0, 13], [x0 + 1, 13], [x0 - 1, 14], [x0, 14], [x0 + 1, 14], [x0 + 2, 14], [x0, 15], [x0 + 1, 15]], hex('#c8a05a'));
    img.set(x0 + 1, 14, hex('#a8843e'));
  }
};

FARM_PAINTERS.beetroots_crop = (img, r) => {
  img.clear();
  const red = hex('#8a1f3a'), leaf = hex('#3d8a2c'), light = hex('#4fa034'), rib = hex('#a02848');
  // Red leaf stalks fanning out from the beet, each with a wavy leaf on top (red midrib, like Minecraft's).
  for (const [x0, top] of [[3, 3], [6, 1], [9, 2], [12, 4]] as [number, number][]) {
    for (let y = 12; y > top + 4; y--) img.set(x0, y, red);
    broadLeaf(img, x0, top + 2, 3 + Math.floor(r() * 2), 5, r() < 0.5 ? leaf : light, rib);
  }
  for (const x0 of [3, 9]) {
    line(img, [[x0, 13], [x0 + 1, 13], [x0 + 2, 13], [x0 - 1, 14], [x0, 14], [x0 + 1, 14], [x0 + 2, 14], [x0 + 3, 14], [x0, 15], [x0 + 1, 15], [x0 + 2, 15]], hex('#7a1830'));
    img.set(x0 + 1, 14, hex('#9a2a48'));
  }
};

FARM_PAINTERS.stem = (img, r) => {
  img.clear();
  // A thin grey stem with a few nubs, the full height (the growth stage shows the bottom part of it).
  const c = hex('#b4b4b4'), d = hex('#8c8c8c');
  let x = 7;
  for (let y = 15; y >= 1; y--) {
    img.set(x, y, c);
    img.set(x + 1, y, d);
    if (y % 4 === 1) img.set(r() < 0.5 ? x - 1 : x + 2, y, c);
    if (y < 13 && r() < 0.2) x += r() < 0.5 ? -1 : 1;
    x = Math.max(5, Math.min(9, x));
  }
};

FARM_PAINTERS.attached_stem = (img) => {
  img.clear();
  // Up from the middle of the block, then bending over to the fruit on the right (u = 1 is the fruit side).
  const c = hex('#b4b4b4'), d = hex('#8c8c8c');
  for (let y = 15; y >= 9; y--) { img.set(7, y, c); img.set(8, y, d); }
  line(img, [[8, 8], [9, 8], [9, 7], [10, 7], [11, 7], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6]], c);
  line(img, [[9, 9], [10, 8], [12, 7], [13, 7], [14, 7], [15, 7]], d);
  // A leaf on the bend.
  line(img, [[10, 5], [11, 4], [12, 4]], c);
};
