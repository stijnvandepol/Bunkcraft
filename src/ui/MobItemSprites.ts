/** Procedural 16×16 sprites for the mob items (`mob:<name>` keys, see items/MobItems.ts). */
type Px = (x: number, y: number, c: string) => void;

function ellipse(px: Px, cx: number, cy: number, rx: number, ry: number, fill: (x: number, y: number, d: number) => string | null): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 1) continue;
      const c = fill(x, y, d);
      if (c) px(x, y, c);
    }
  }
}

function pail(px: Px): void {
  for (let y = 4; y <= 13; y++) {
    const left = 3 + Math.floor((y - 4) / 5), right = 12 - Math.floor((y - 4) / 5);
    for (let x = left; x <= right; x++) px(x, y, x === left ? '#9a9a9a' : x === right ? '#707070' : ['#c4c4c4', '#b0b0b0', '#d8d8d8'][(x + y) % 3]);
  }
  for (let x = 2; x <= 13; x++) px(x, 3, x === 2 || x === 13 ? '#8a8a8a' : '#e6e6e6');
  for (const [x, y] of [[4, 1], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 1]]) px(x, y, '#7a7a7a');
}

export function paintMobSprite(px: Px, key: string): boolean {
  if (!key.startsWith('mob:')) return false;
  switch (key.slice(4)) {
    case 'egg':
      ellipse(px, 7.5, 8.5, 4.2, 5.5, (x, y, d) => (d > 0.75 ? '#c9b48c' : x < 6 && y < 7 ? '#fbf3e2' : (x * 7 + y * 3) % 11 === 0 ? '#d8c29a' : '#efe0c0'));
      break;
    case 'milk':
      pail(px);
      for (let x = 4; x <= 11; x++) { px(x, 4, '#ffffff'); px(x, 5, x < 6 ? '#f0f0f0' : '#fafafa'); }
      break;
    case 'saddle':
      ellipse(px, 8, 7, 6, 3.5, (x, y) => (y < 5 ? '#a0652e' : (x + y) % 5 === 0 ? '#6e3f18' : '#8a5426'));
      for (let y = 9; y < 15; y++) { px(4, y, '#5a3412'); px(11, y, '#5a3412'); }
      px(4, 14, '#c4c4c4'); px(11, 14, '#c4c4c4');
      break;
    case 'pearl':
      ellipse(px, 8, 8, 4.5, 4.5, (x, y, d) => (d > 0.7 ? '#0d3b33' : x < 7 && y < 7 ? '#4fd8c0' : (x + y) % 3 === 0 ? '#1f7a6a' : '#2a9a86'));
      px(6, 6, '#c8fff4');
      break;
    case 'slime':
      ellipse(px, 8, 8.5, 4.5, 4, (x, y, d) => (d > 0.72 ? '#3f8a2e' : x < 7 && y < 7 ? '#b4f59a' : '#7ccf5c'));
      break;
    default:
      return false;
  }
  return true;
}
