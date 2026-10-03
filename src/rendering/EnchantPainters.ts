import { type Img, type Rand, P, hex, noisy, pick, shade } from './PaintKit';

/**
 * Procedural textures of the enchanting table, anvil and grindstone (merged into CONTENT_PAINTERS). Plain pixel art in the
 * colours of the Minecraft blocks; nothing is copied from the game.
 */
type Painter = (img: Img, r: Rand) => void;
export const ENCHANT_PAINTERS: Record<string, Painter> = {};
const put = (name: string, p: Painter): void => { ENCHANT_PAINTERS[name] = p; };

const OBSIDIAN = ['#0f0a18', '#1b1229', '#2a1d40', '#140d22'];

function obsidian(img: Img, r: Rand): void {
  noisy(img, r, P(...OBSIDIAN), 0.55, 4);
  // A few purple glints like obsidian's.
  for (let k = 0; k < 6; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#4a3270'));
}

put('enchanting_table_bottom', obsidian);

put('enchanting_table_side', (i, r) => {
  obsidian(i, r);
  // The block is 12 px high: rows 4..15 show. Red cloth hangs over the top 3 rows with a gold seam.
  const cloth = P('#9a1f24', '#b32a2e', '#7f1a1f');
  for (let y = 4; y <= 7; y++) {
    for (let x = 0; x < 16; x++) {
      if (y === 7 && (x % 4 === 1 || x % 4 === 2)) continue;
      i.set(x, y, y === 6 ? hex('#d9a520') : shade(pick(cloth, r()), y === 4 ? 1.15 : 1));
    }
  }
});

put('enchanting_table_top', (i, r) => {
  // Red cloth with a gold border and the diamond corners of Minecraft's table.
  noisy(i, r, P('#9a1f24', '#a8262a', '#8a1c21'), 0.5, 3);
  const gold = hex('#d9a520'), dark = hex('#5c0f13');
  for (let k = 0; k < 16; k++) { i.set(k, 0, dark); i.set(k, 15, dark); i.set(0, k, dark); i.set(15, k, dark); }
  for (let k = 2; k < 14; k++) { i.set(k, 2, gold); i.set(k, 13, gold); i.set(2, k, gold); i.set(13, k, gold); }
  const diamond = [hex('#5ee8df'), hex('#2ab3ac')];
  for (const [cx, cy] of [[1, 1], [14, 1], [1, 14], [14, 14]]) {
    i.set(cx, cy, diamond[0]);
    i.set(cx + (cx < 8 ? 1 : -1), cy, diamond[1]);
    i.set(cx, cy + (cy < 8 ? 1 : -1), diamond[1]);
  }
  // A dark circle in the middle where the book floats.
  for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) if (Math.hypot(x - 7.5, y - 7.5) < 2.8) i.set(x, y, shade(i.get(x, y), 0.6));
});

const IRON = ['#3f3f43', '#47474c', '#38383c', '#505056'];

put('anvil', (i, r) => {
  noisy(i, r, P(...IRON), 0.6, 4);
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#5e5e64')); i.set(k, 15, hex('#2a2a2e')); }
});

function anvilTop(img: Img, r: Rand, cracks: number): void {
  noisy(img, r, P(...IRON), 0.6, 4);
  // The working face: a lighter inset.
  for (let y = 3; y <= 12; y++) for (let x = 2; x <= 13; x++) img.set(x, y, shade(pick(P('#55555b', '#5c5c62', '#4f4f55'), r()), 1));
  for (let x = 2; x <= 13; x++) img.set(x, 3, hex('#6c6c73'));
  const c = hex('#222226');
  for (let k = 0; k < cracks; k++) {
    let x = 3 + Math.floor(r() * 10), y = 4 + Math.floor(r() * 8);
    for (let s = 0; s < 5; s++) {
      img.set(x, y, c);
      x += r() < 0.5 ? 1 : -1;
      y += r() < 0.6 ? 1 : 0;
      if (x < 2 || x > 13 || y > 12) break;
    }
  }
}
put('anvil_top', (i, r) => anvilTop(i, r, 0));
put('chipped_anvil_top', (i, r) => anvilTop(i, r, 3));
put('damaged_anvil_top', (i, r) => anvilTop(i, r, 7));

put('grindstone_side', (i, r) => {
  // The wheel's face: smooth grey stone with a ring and a dark hub.
  noisy(i, r, P('#8c8c8c', '#9a9a9a', '#7e7e7e'), 0.6, 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 5.5 && d < 6.6) i.set(x, y, hex('#6a6a6a'));
      if (d < 1.6) i.set(x, y, hex('#4a3a28'));
    }
  }
});

put('grindstone_round', (i, r) => {
  noisy(i, r, P('#8c8c8c', '#9a9a9a', '#848484'), 0.5, 2);
  for (let x = 0; x < 16; x += 3) for (let y = 0; y < 16; y++) i.set(x, y, shade(i.get(x, y), 0.9));
});
