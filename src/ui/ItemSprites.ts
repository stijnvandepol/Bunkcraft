import { mulberry32, hashString } from '../world/Noise';

/**
 * Procedural 16×16 item sprites (food, materials, tools) in the flat pixel-art style
 * Minecraft uses for non-block items. Returned as a 16×16 canvas.
 */
type Px = (x: number, y: number, c: string) => void;

const TIER_COLORS = [
  ['#6b4f2a', '#8f6a39', '#b08850'], // wood
  ['#5f5f5f', '#7e7e7e', '#9d9d9d'], // stone
  ['#9e9e9e', '#cfcfcf', '#f2f2f2'], // iron
  ['#1f9c96', '#3fd1c9', '#a6f5f0'], // diamond
  ['#c09a1c', '#f0d43c', '#fff6a8'], // gold
];
const HANDLE = ['#3e2a15', '#5c4024', '#7a5631'];

function line(px: Px, pts: [number, number][], c: string): void {
  for (const [x, y] of pts) px(x, y, c);
}

/** Diagonal handle from bottom-left towards the centre, shared by all tools. */
function handle(px: Px, len: number): void {
  for (let i = 0; i < len; i++) {
    px(2 + i, 13 - i, HANDLE[1]);
    px(3 + i, 13 - i, HANDLE[0]);
    if (i % 3 === 0) px(2 + i, 13 - i, HANDLE[2]);
  }
}

function drawTool(px: Px, kind: string, tier: number): void {
  const [dark, mid, light] = TIER_COLORS[tier];
  switch (kind) {
    case 'pickaxe':
      handle(px, 9);
      line(px, [[4, 3], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 3], [11, 4], [12, 5], [13, 6], [13, 7], [13, 8], [12, 9]], mid);
      line(px, [[5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 4], [11, 5], [12, 6], [12, 7], [12, 8]], dark);
      line(px, [[5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [11, 3], [12, 4], [14, 6], [14, 7]], light);
      break;
    case 'axe':
      handle(px, 9);
      for (let y = 1; y < 8; y++) for (let x = 8; x < 13; x++) if (x - 8 + (7 - y) > 2 && x < 13 - Math.abs(y - 4) / 2) px(x, y, mid);
      line(px, [[9, 1], [10, 1], [11, 2], [12, 3], [13, 4], [13, 5]], light);
      line(px, [[9, 7], [10, 7], [11, 6], [12, 6]], dark);
      break;
    case 'shovel':
      handle(px, 8);
      for (let y = 1; y < 7; y++) for (let x = 9; x < 15; x++) if (Math.abs(x - 12 + (y - 4)) + Math.abs(x - 12 - (y - 4)) < 6) px(x, y, mid);
      line(px, [[11, 1], [12, 1], [13, 2], [14, 3]], light);
      line(px, [[9, 5], [10, 6]], dark);
      break;
    case 'sword':
      for (let i = 0; i < 10; i++) {
        px(4 + i, 11 - i, mid);
        px(5 + i, 11 - i, light);
        px(4 + i, 10 - i, dark);
      }
      line(px, [[2, 9], [3, 10], [4, 11], [5, 12], [6, 13]], HANDLE[2]);
      line(px, [[2, 13], [3, 12], [1, 14], [2, 14]], HANDLE[1]);
      break;
  }
}

function blob(px: Px, cx: number, cy: number, rx: number, ry: number, fill: (x: number, y: number) => string): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) px(x, y, fill(x, y));
    }
  }
}

export function paintItemSprite(key: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  const r = mulberry32(hashString(key));
  const px: Px = (x, y, color) => {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  };
  const tool = /^(pickaxe|axe|shovel|sword)_(\d)$/.exec(key);
  if (tool) {
    drawTool(px, tool[1], Number(tool[2]));
    return c;
  }
  const pick = (cols: string[]) => cols[Math.floor(r() * cols.length)];
  switch (key) {
    case 'meat_pink':
    case 'meat_red':
    case 'meat_cooked':
    case 'rotten': {
      const pal = key === 'meat_pink' ? ['#f2a3a0', '#e48682', '#d66f6c'] : key === 'meat_red' ? ['#c9433d', '#b03630', '#e0625a']
        : key === 'meat_cooked' ? ['#9a5a2f', '#7c4521', '#b8733f'] : ['#7d6a3b', '#5f7a35', '#8a5b3d'];
      blob(px, 8, 8, 6, 4.5, () => pick(pal));
      blob(px, 9, 7, 2.5, 1.6, () => (key === 'meat_cooked' ? '#d8a070' : '#f6e3d8'));
      line(px, [[3, 10], [4, 11], [12, 11], [13, 10]], '#4a2a18');
      break;
    }
    case 'drumstick_raw':
    case 'drumstick_cooked': {
      const pal = key === 'drumstick_raw' ? ['#f1c7a8', '#e7b28f'] : ['#b8733f', '#9a5a2f'];
      blob(px, 6, 6, 4.5, 4.5, () => pick(pal));
      line(px, [[9, 9], [10, 10], [11, 11], [12, 12]], '#efe6d8');
      line(px, [[12, 13], [13, 12], [13, 13]], '#ffffff');
      break;
    }
    case 'gunpowder':
      for (let i = 0; i < 40; i++) px(4 + Math.floor(r() * 9), 6 + Math.floor(r() * 7), pick(['#3a3a3a', '#555555', '#6e6e6e', '#2a2a2a']));
      break;
    case 'feather':
      for (let i = 0; i < 11; i++) { px(3 + i, 13 - i, '#d8d8d8'); px(4 + i, 13 - i, '#ffffff'); px(3 + i, 12 - i, '#f0f0f0'); }
      line(px, [[2, 14], [3, 13]], '#8a8a8a');
      break;
    case 'coal':
      blob(px, 8, 8, 5, 4.5, () => pick(['#1d1d1d', '#2e2e2e', '#3d3d3d', '#151515']));
      break;
    case 'diamond':
      blob(px, 8, 8, 5, 5, (x, y) => ((x + y) % 4 === 0 ? '#e8fffd' : pick(['#3fd1c9', '#5ee8df', '#2ab3ac'])));
      break;
    case 'ingot':
      for (let y = 6; y < 11; y++) for (let x = 2 + (10 - y); x < 14 - (y - 6); x++) px(x, y, y === 6 ? '#ffffff' : pick(['#d8d8d8', '#c4c4c4', '#e6e6e6']));
      break;
    case 'gold_ingot':
      for (let y = 6; y < 11; y++) for (let x = 2 + (10 - y); x < 14 - (y - 6); x++) px(x, y, y === 6 ? '#fffbd0' : pick(['#f0d43c', '#e2bd22', '#f8e46a']));
      break;
    case 'flint':
      blob(px, 8, 8, 4, 5.5, (x, y) => (x + y < 13 ? pick(['#5a5a5a', '#6a6a6a']) : pick(['#2e2e2e', '#3c3c3c', '#262626'])));
      line(px, [[6, 4], [7, 4], [5, 5]], '#8a8a8a');
      break;
    case 'flint_and_steel':
      // Steel striker (top left) and a flint (bottom right), as in Minecraft.
      line(px, [[3, 3], [4, 3], [5, 3], [6, 3], [2, 4], [2, 5], [2, 6], [3, 7], [7, 4], [7, 5], [6, 6], [5, 7], [4, 7]], '#c4c4c4');
      line(px, [[3, 4], [4, 4], [5, 4], [6, 4], [3, 5], [3, 6], [6, 5], [5, 6], [4, 6]], '#8a8a8a');
      blob(px, 10.5, 10.5, 3.2, 3.2, (x, y) => (x + y < 20 ? '#6a6a6a' : pick(['#2e2e2e', '#3c3c3c'])));
      break;
    case 'stick':
      for (let i = 0; i < 10; i++) { px(4 + i, 12 - i, '#6e4e2c'); px(5 + i, 12 - i, '#4a3219'); }
      break;
    default:
      blob(px, 8, 8, 5, 5, () => '#ff00ff');
  }
  return c;
}
