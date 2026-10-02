/**
 * Title logo in the classic voxel-game style, drawn procedurally: chunky block letters
 * with a stone texture on the front, per-block bevel highlights, a dark 3D extrusion
 * and a black outline. The glyphs are BunkCraft's own 5×7 design.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  B: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.'],
  C: ['.XXXX', 'X....', 'X....', 'X....', 'X....', 'X....', '.XXXX'],
  F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X', 'X...X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
};

const CELL = 12; // canvas pixels per letter block
const GAP = 1; // blocks between letters
const DEPTH = 5; // extrusion depth in canvas pixels
const PAD = 6;

export function createLogo(text: string, stone: HTMLCanvasElement): HTMLCanvasElement {
  const letters = text.toUpperCase().split('').map((c) => GLYPHS[c] ?? GLYPHS.T);
  const cols = letters.length * 5 + (letters.length - 1) * GAP;
  const rows = 7;
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL + PAD * 2 + DEPTH;
  canvas.height = rows * CELL + PAD * 2 + DEPTH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const cells: [number, number][] = [];
  letters.forEach((g, li) => {
    const ox = li * (5 + GAP);
    g.forEach((row, y) => row.split('').forEach((c, x) => { if (c === 'X') cells.push([ox + x, y]); }));
  });
  const px = (cx: number) => PAD + cx * CELL;

  // 1. Black outline behind everything (covers front + extrusion, 2px wider).
  ctx.fillStyle = '#000';
  for (const [x, y] of cells) ctx.fillRect(px(x) - 2, px(y) - 2, CELL + DEPTH + 4, CELL + DEPTH + 4);

  // 2. Extrusion: the glyph repeated down-right, darkening with depth.
  for (let d = DEPTH; d >= 1; d--) {
    const shade = 30 + Math.round((DEPTH - d) * 9);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    for (const [x, y] of cells) ctx.fillRect(px(x) + d, px(y) + d, CELL, CELL);
  }

  // 3. Front face: stone texture continuous across the letters (scaled 2×, pixel-crisp).
  const pattern = ctx.createPattern(scaled(stone, 2), 'repeat')!;
  ctx.fillStyle = pattern;
  for (const [x, y] of cells) ctx.fillRect(px(x), px(y), CELL, CELL);

  // 4. Bevel: light top/left and dark bottom/right edge on each block's exposed sides.
  const has = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of cells) {
    const X = px(x), Y = px(y);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    if (!has.has(`${x},${y - 1}`)) ctx.fillRect(X, Y, CELL, 2);
    if (!has.has(`${x - 1},${y}`)) ctx.fillRect(X, Y, 2, CELL);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (!has.has(`${x},${y + 1}`)) ctx.fillRect(X, Y + CELL - 2, CELL, 2);
    if (!has.has(`${x + 1},${y}`)) ctx.fillRect(X + CELL - 2, Y, 2, CELL);
  }
  // Subtle vertical gradient: brighter top, darker bottom (like a lit stone face).
  const grad = ctx.createLinearGradient(0, PAD, 0, PAD + rows * CELL);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad;
  for (const [x, y] of cells) ctx.fillRect(px(x), px(y), CELL, CELL);
  return canvas;
}

function scaled(src: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width * factor;
  c.height = src.height * factor;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
