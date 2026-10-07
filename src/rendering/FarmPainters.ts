import { type Img, type RGB, type Rand, hex, shade } from './PaintKit';

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
  const stem = hex('#a8a8a8'), stemDark = hex('#8a8a8a'), ear = hex('#e2e2e2'), earDark = hex('#9c9c9c'), leaf = hex('#bcbcbc');
  for (const x0 of [1, 4, 7, 10, 13]) {
    const top = 4 + Math.floor(r() * 3);
    const x = stalk(img, r, x0 + (r() < 0.5 ? 0 : 1), top + 4, stem, stemDark);
    // The ear: two columns of grains, alternating light and dark, over the top of the stalk.
    for (let y = top; y < top + 5; y++) {
      img.set(x, y, (y & 1) ? ear : earDark);
      img.set(Math.min(15, x + 1), y, (y & 1) ? earDark : ear);
    }
    img.set(x, top - 1, ear);
    // A leaf halfway up.
    const ly = 9 + Math.floor(r() * 3), dir = r() < 0.5 ? -1 : 1;
    line(img, [[x0 + dir, ly], [x0 + 2 * dir, ly - 1]], leaf);
  }
};

/** Green fronds from the soil up to row `top`, `n` of them. */
function fronds(img: Img, r: Rand, n: number, top: number, pal: RGB[]): void {
  for (let i = 0; i < n; i++) {
    let x = 1 + Math.floor(r() * 14);
    const t = top + Math.floor(r() * 3);
    for (let y = 12; y >= t; y--) {
      const c = pal[Math.floor(r() * pal.length)];
      img.set(x, y, c);
      // Leaflets on both sides near the tips.
      if (y < 8 && r() < 0.45) img.set(x + (r() < 0.5 ? -1 : 1), y, shade(c, 1.1));
      if (r() < 0.3) x += r() < 0.5 ? -1 : 1;
      x = Math.max(0, Math.min(15, x));
    }
  }
}

FARM_PAINTERS.carrots_crop = (img, r) => {
  img.clear();
  fronds(img, r, 9, 1, [hex('#3f8f2a'), hex('#4ea532'), hex('#5cb83c'), hex('#2f7a22')]);
  // Orange carrot tops in the soil line.
  for (const x0 of [2, 7, 12]) {
    line(img, [[x0, 13], [x0 + 1, 13], [x0, 14], [x0 + 1, 14], [x0, 15]], hex('#e8821e'));
    img.set(x0 + 1, 15, hex('#c86812'));
    img.set(x0, 12, hex('#4ea532'));
  }
};

FARM_PAINTERS.potatoes_crop = (img, r) => {
  img.clear();
  fronds(img, r, 8, 2, [hex('#2f7d24'), hex('#3a8c2a'), hex('#469c30'), hex('#296b1e')]);
  // Round leaves at the frond tips.
  for (let i = 0; i < 6; i++) {
    const x = 1 + Math.floor(r() * 13), y = 2 + Math.floor(r() * 6);
    line(img, [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]], hex('#4fa836'));
  }
  // Potatoes peeking out of the soil.
  for (const x0 of [2, 8, 12]) {
    line(img, [[x0, 13], [x0 + 1, 13], [x0 - 1, 14], [x0, 14], [x0 + 1, 14], [x0 + 2, 14], [x0, 15], [x0 + 1, 15]], hex('#c8a05a'));
    img.set(x0 + 1, 14, hex('#a8843e'));
  }
};

FARM_PAINTERS.beetroots_crop = (img, r) => {
  img.clear();
  fronds(img, r, 8, 2, [hex('#3d8a2c'), hex('#4a9a34'), hex('#357a26')]);
  // Red leaf stalks (beetroot leaves have red veins).
  for (let i = 0; i < 5; i++) {
    const x = 2 + Math.floor(r() * 12);
    for (let y = 12; y > 7 - Math.floor(r() * 3); y--) img.set(x, y, hex('#8a1f3a'));
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
