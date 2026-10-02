/**
 * Procedural sprites for the content tables (materials, food, armor, hoes, shears). Keys look like
 * `ingot:d97b4a` (kind:colour), `food:apple` or `armor:<slot>:<material>`; see items/ItemContent.ts.
 */
export type Px = (x: number, y: number, c: string) => void;
type Rand = () => number;

function rgb(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Colour scaled by f (1 = same). */
function sh(h: string, f: number): string {
  const [r, g, b] = rgb(h);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1)}`;
}

function blob(px: Px, cx: number, cy: number, rx: number, ry: number, fill: (x: number, y: number, d: number) => string): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) px(x, y, fill(x, y, d));
    }
  }
}
function line(px: Px, pts: [number, number][], c: string): void {
  for (const [x, y] of pts) px(x, y, c);
}
function rect(px: Px, x0: number, y0: number, x1: number, y1: number, c: (x: number, y: number) => string): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, c(x, y));
}

const HANDLE = ['#3e2a15', '#5c4024', '#7a5631'];
const TIER = [
  ['#6b4f2a', '#8f6a39', '#b08850'],
  ['#5f5f5f', '#7e7e7e', '#9d9d9d'],
  ['#9e9e9e', '#cfcfcf', '#f2f2f2'],
  ['#1f9c96', '#3fd1c9', '#a6f5f0'],
  ['#c09a1c', '#f0d43c', '#fff6a8'],
];

function hoe(px: Px, tier: number): void {
  const [dark, mid, light] = TIER[tier];
  for (let i = 0; i < 9; i++) { px(2 + i, 13 - i, HANDLE[1]); px(3 + i, 13 - i, HANDLE[0]); if (i % 3 === 0) px(2 + i, 13 - i, HANDLE[2]); }
  line(px, [[6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [10, 3], [10, 4]], mid);
  line(px, [[7, 3], [8, 3], [9, 3], [9, 4]], dark);
  line(px, [[7, 1], [8, 1], [9, 1], [10, 1], [11, 2], [11, 3]], light);
}

function shears(px: Px): void {
  const a = '#c4c4c4', b = '#8a8a8a', c = '#e6e6e6';
  for (let i = 0; i < 8; i++) { px(12 - i, 2 + i, a); px(11 - i, 2 + i, c); px(3 + i, 2 + i, b); px(4 + i, 2 + i, a); }
  for (const [x, y] of [[2, 11], [2, 12], [3, 13], [4, 13], [5, 12], [5, 11], [4, 10], [3, 10]]) px(x, y, '#9a3a2a');
  for (const [x, y] of [[9, 11], [9, 12], [10, 13], [11, 13], [12, 12], [12, 11], [11, 10], [10, 10]]) px(x, y, '#9a3a2a');
}

const ARMOR_PAL = [
  ['#7a4a26', '#a56a38', '#c98550'], // leather
  ['#5f6266', '#8a8d92', '#b4b8be'], // chainmail
  ['#8f8f8f', '#cfcfcf', '#f4f4f4'], // iron
  ['#b08a14', '#f0d43c', '#fff2a0'], // gold
  ['#1f9c96', '#3fd1c9', '#b5fbf6'], // diamond
];

function armor(px: Px, slot: number, mat: number): void {
  const [dark, mid, light] = ARMOR_PAL[mat];
  const body = (x: number, y: number): string => {
    let c = mid;
    if (x <= 4 || y <= 3) c = light;
    if (x >= 11 || y >= 12) c = dark;
    if (mat === 1 && (x + y) % 2 === 0) c = sh(c, 0.82); // chain mesh
    return c;
  };
  const edge = sh(dark, 0.6);
  const draw = (cells: [number, number, number][]): void => {
    for (const [y, x0, x1] of cells) rect(px, x0, y, x1, y, body);
    // 1 px outline to read against the slot background.
    for (const [y, x0, x1] of cells) { px(x0 - 1, y, edge); px(x1 + 1, y, edge); }
  };
  switch (slot) {
    case 0: // helmet
      draw([[3, 5, 10], [4, 4, 11], [5, 3, 12], [6, 3, 12], [7, 3, 5], [8, 3, 5]]);
      rect(px, 10, 7, 12, 8, body);
      px(2, 5, edge); px(2, 6, edge); px(2, 7, edge); px(2, 8, edge); px(13, 5, edge); px(13, 6, edge);
      if (mat === 0) rect(px, 6, 3, 9, 3, () => light);
      break;
    case 1: // chestplate
      draw([[2, 3, 5], [3, 2, 13], [4, 2, 13], [5, 2, 13], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 3, 12], [12, 4, 11]]);
      rect(px, 10, 2, 12, 2, body);
      px(7, 3, edge); px(8, 3, edge);
      break;
    case 2: // leggings
      draw([[2, 3, 12], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 6], [7, 3, 6], [8, 3, 6], [9, 3, 6], [10, 3, 6], [11, 3, 6], [12, 3, 6]]);
      rect(px, 9, 6, 12, 12, body);
      px(8, 6, edge); px(8, 12, edge);
      break;
    default: // boots
      draw([[7, 3, 5], [8, 3, 5], [9, 3, 5], [10, 3, 5], [11, 2, 6], [12, 2, 6]]);
      rect(px, 10, 7, 12, 10, body);
      rect(px, 9, 11, 13, 12, body);
      break;
  }
}

function food(px: Px, r: Rand, kind: string): void {
  const pick = (cols: string[]) => cols[Math.floor(r() * cols.length)];
  switch (kind) {
    case 'apple': case 'golden_apple': {
      const gold = kind === 'golden_apple';
      const pal = gold ? ['#f0c828', '#e0b418', '#f8de50'] : ['#c42a1e', '#d63a2a', '#a82016'];
      blob(px, 8, 9, 5, 5, (x, y) => (x < 6 && y < 8 ? '#fff4c0' : pick(pal)));
      line(px, [[8, 3], [8, 4], [9, 2]], '#5a3a1a');
      line(px, [[10, 2], [11, 2], [10, 3]], '#4f9a2c');
      break;
    }
    case 'bread':
      blob(px, 8, 9, 6, 3.5, (_x, y) => (y < 8 ? pick(['#d8a050', '#c89040']) : pick(['#b8782c', '#a8681e'])));
      line(px, [[5, 8], [8, 7], [11, 8]], '#8a5a1c');
      break;
    case 'cookie':
      blob(px, 8, 8, 5, 5, () => pick(['#c88a48', '#b87a3a', '#d89a58']));
      line(px, [[6, 6], [9, 7], [7, 10], [10, 10], [5, 9]], '#4a2a12');
      break;
    case 'potato': case 'baked_potato': {
      const baked = kind === 'baked_potato';
      blob(px, 8, 9, 5.5, 4, () => pick(baked ? ['#b8782c', '#a8681e', '#c88a3c'] : ['#c8a05a', '#b8904a', '#d4ac66']));
      if (baked) line(px, [[6, 8], [7, 8], [8, 8], [9, 8]], '#f0e0a0');
      line(px, [[6, 11], [10, 7]], '#8a6a30');
      break;
    }
    case 'carrot': case 'golden_carrot': {
      const gold = kind === 'golden_carrot';
      const pal = gold ? ['#f0c828', '#e0b418'] : ['#e8821e', '#d87414', '#f29630'];
      for (let i = 0; i < 9; i++) { px(4 + i, 12 - i, pick(pal)); px(5 + i, 12 - i, pick(pal)); px(4 + i, 11 - i, pick(pal)); }
      line(px, [[12, 3], [13, 2], [13, 3], [14, 3], [12, 2], [11, 2]], '#4f9a2c');
      break;
    }
    case 'melon_slice':
      blob(px, 8, 6, 6, 5, (_x, y) => (y > 7 ? '#00000000' : '#d83a3a'));
      for (let x = 2; x <= 14; x++) { px(x, 8, '#5a8a2a'); px(x, 9, '#7ba02a'); }
      for (let x = 3; x <= 13; x++) if (x % 3 === 0) px(x, 6, '#1a1a1a');
      break;
    case 'pumpkin_pie':
      blob(px, 8, 9, 6.5, 4, (_x, y) => (y < 8 ? '#d27a28' : '#c8c0a8'));
      line(px, [[4, 8], [12, 8], [6, 7], [10, 7]], '#f4ecd8');
      line(px, [[8, 9], [8, 6]], '#8a4a14');
      break;
    case 'stew':
      blob(px, 8, 10, 6, 3.5, (_x, y) => (y < 9 ? '#8a5a38' : '#5a3a22'));
      line(px, [[5, 9], [6, 9], [8, 8], [10, 9], [11, 9]], '#b83a2a');
      line(px, [[7, 9], [9, 9]], '#e8dcc8');
      break;
    case 'cod': case 'cooked_cod': case 'salmon': case 'cooked_salmon': {
      const pal = kind === 'cod' ? ['#b8a888', '#a89878'] : kind === 'cooked_cod' ? ['#c8a060', '#b89050']
        : kind === 'salmon' ? ['#d8685a', '#c8584a'] : ['#c88a50', '#b87a40'];
      blob(px, 7, 8, 5.5, 3.2, () => pick(pal));
      line(px, [[12, 8], [13, 6], [13, 10], [14, 5], [14, 11]], pal[0]);
      px(4, 7, '#101010');
      break;
    }
    case 'berries':
      for (const [x, y] of [[5, 7], [9, 6], [7, 10], [11, 10], [4, 11]]) blob(px, x, y, 2, 2, () => pick(['#c4283a', '#d63848']));
      line(px, [[8, 3], [9, 4]], '#4f9a2c');
      break;
    case 'beetroot':
      blob(px, 8, 9, 4.5, 4.5, () => pick(['#8a1f3a', '#7a1830', '#9a2a48']));
      line(px, [[7, 4], [8, 3], [9, 4], [6, 3], [10, 3]], '#4f9a2c');
      break;
    default:
      blob(px, 8, 8, 5, 5, () => '#ff00ff');
  }
}

/** Paints `key` and returns true when it is one of the content-table sprites. */
export function paintExtraSprite(px: Px, r: Rand, key: string): boolean {
  const [kind, arg, arg2] = key.split(':');
  const pick = (cols: string[]) => cols[Math.floor(r() * cols.length)];
  const hoeMatch = /^hoe_(\d)$/.exec(key);
  if (hoeMatch) { hoe(px, Number(hoeMatch[1])); return true; }
  switch (kind) {
    case 'shears': shears(px); return true;
    case 'armor': armor(px, Number(arg), Number(arg2)); return true;
    case 'food': food(px, r, arg); return true;
    case 'coal': {
      const c = `#${arg}`;
      blob(px, 8, 8, 5, 4.5, () => pick([sh(c, 0.7), c, sh(c, 1.3), sh(c, 0.5)]));
      return true;
    }
    case 'ingot': {
      const c = `#${arg}`;
      for (let y = 6; y < 11; y++) for (let x = 2 + (10 - y); x < 14 - (y - 6); x++) px(x, y, y === 6 ? sh(c, 1.35) : pick([sh(c, 0.9), c, sh(c, 1.12)]));
      return true;
    }
    case 'raw': {
      const c = `#${arg}`;
      blob(px, 8, 8, 5, 5, (x, y) => (x + y < 13 ? sh(c, 1.15) : pick([sh(c, 0.7), sh(c, 0.85), c])));
      for (const [x, y] of [[6, 6], [9, 9], [10, 6]]) px(x, y, sh(c, 0.55));
      return true;
    }
    case 'gem': {
      const c = `#${arg}`;
      blob(px, 8, 8, 5, 5.5, (x, y) => ((x + y) % 4 === 0 ? sh(c, 1.5) : pick([c, sh(c, 0.8), sh(c, 1.2)])));
      for (const [x, y] of [[6, 5], [7, 5]]) px(x, y, sh(c, 1.6));
      return true;
    }
    case 'dust': {
      const c = `#${arg}`;
      for (let i = 0; i < 46; i++) px(3 + Math.floor(r() * 10), 6 + Math.floor(r() * 7), pick([sh(c, 0.7), c, sh(c, 1.25)]));
      return true;
    }
    case 'nugget': {
      const c = `#${arg}`;
      blob(px, 8, 9, 3, 2.6, (x, y) => (x + y < 16 ? sh(c, 1.2) : sh(c, 0.8)));
      return true;
    }
    case 'dye': {
      const c = `#${arg}`;
      blob(px, 8, 9, 4.5, 4.5, (x, y) => (x + y < 14 ? sh(c, 1.25) : pick([c, sh(c, 0.8)])));
      line(px, [[6, 6], [7, 6]], '#ffffffaa'.slice(0, 7));
      return true;
    }
    case 'seeds': {
      const c = `#${arg}`;
      for (let i = 0; i < 7; i++) { const x = 4 + Math.floor(r() * 8), y = 5 + Math.floor(r() * 7); px(x, y, c); px(x + 1, y, sh(c, 0.7)); }
      return true;
    }
    case 'leather':
      rect(px, 3, 3, 12, 12, (x, y) => (x < 5 || y < 5 ? '#c27a46' : x > 10 || y > 10 ? '#7a4a28' : pick(['#a65f33', '#b46a3b'])));
      line(px, [[5, 5], [10, 5], [5, 10], [10, 10]], '#4a2a14');
      return true;
    case 'paper':
      rect(px, 3, 2, 12, 13, (x, y) => (x === 3 || y === 2 ? '#ffffff' : x === 12 || y === 13 ? '#c8c8c0' : pick(['#f0f0e8', '#e8e8e0'])));
      for (const y of [5, 7, 9]) for (let x = 5; x <= 10; x++) px(x, y, '#b0b0a8');
      return true;
    case 'book':
      rect(px, 3, 2, 12, 13, (x, y) => (x <= 4 ? '#5a2a14' : x === 12 || y === 13 ? '#3a1a0a' : '#8a4a20'));
      rect(px, 6, 4, 10, 10, () => '#e8e0c0');
      line(px, [[7, 6], [8, 6], [9, 6], [7, 8], [8, 8]], '#8a7a50');
      return true;
    case 'clay':
      blob(px, 8, 8, 5, 4.5, () => pick(['#a0a8b8', '#9098a8', '#aab2c2']));
      return true;
    case 'brick':
      rect(px, 3, 5, 12, 10, (x, y) => (y === 5 ? '#d27a62' : y === 10 || x === 12 ? '#7a3a2a' : pick(['#a8483a', '#98402e', '#b0523f'])));
      return true;
    case 'snowball':
      blob(px, 8, 8, 5, 5, (x, y) => (x + y < 14 ? '#ffffff' : pick(['#dce8ec', '#eef4f6'])));
      return true;
    case 'wheat':
      for (let i = 0; i < 11; i++) px(8 - Math.floor(i / 5), 14 - i, '#a89a3a');
      for (let k = 0; k < 5; k++) { px(7 - (k % 2), 4 + k * 2, '#d8c050'); px(9 - (k % 2) * 0, 3 + k * 2, '#e8d060'); }
      return true;
    case 'bowl':
      blob(px, 8, 9, 6, 3.5, (_x, y) => (y < 8 ? '#a07040' : '#6a4a28'));
      line(px, [[4, 8], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [10, 8], [11, 8]], '#3a2a18');
      return true;
    default:
      return false;
  }
}
