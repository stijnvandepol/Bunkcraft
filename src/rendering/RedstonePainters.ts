import { type Img, type Rand, P, hex, noisy, paintPlanks, pick, shade } from './PaintKit';

/**
 * Procedural textures of the redstone blocks (plain pixel art in Minecraft's colours; nothing copied). Box-shaped blocks
 * map the part of the texture they cover (image row 0 is the top of the block), so the torch and lever handle are
 * painted in the columns the boxes use.
 */
type Painter = (img: Img, r: Rand) => void;
export const REDSTONE_PAINTERS: Record<string, Painter> = {};
const put = (name: string, p: Painter): void => { REDSTONE_PAINTERS[name] = p; };

const STONE = ['#7b7b7b', '#838383', '#8b8b8b', '#929292'];

// Dust: light grey grains, multiplied in the shader by the colour of its signal strength.
put('redstone_dust', (i, r) => {
  noisy(i, r, P('#b8b8b8', '#cfcfcf', '#e2e2e2', '#f4f4f4'), 0.3, 6);
  for (let k = 0; k < 18; k++) i.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#ffffff'));
  for (let k = 0; k < 10; k++) i.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#8a8a8a'));
});

/** A 2 px torch stick in columns 7-8 from `top` down, with a red (or dark) tip. */
function torch(i: Img, r: Rand, lit: boolean, top: number): void {
  i.clear();
  const wood = P('#5c4024', '#6e4e2c', '#7d5a33');
  for (let y = top + 2; y < 16; y++) for (let x = 7; x < 9; x++) i.set(x, y, pick(wood, r()));
  const tip = lit ? [hex('#ff3a20'), hex('#ffb0a0'), hex('#d01010'), hex('#ff5a40')] : [hex('#5a1a14'), hex('#7a2a20'), hex('#3a0e0a'), hex('#4a1410')];
  i.set(7, top, tip[0]); i.set(8, top, tip[1]); i.set(7, top + 1, tip[2]); i.set(8, top + 1, tip[3]);
}
// A floor torch is 10/16 tall: its tip is at image row 6.
put('redstone_torch', (i, r) => torch(i, r, true, 6));
put('redstone_torch_off', (i, r) => torch(i, r, false, 6));

put('lever', (i, r) => {
  i.clear();
  const wood = P('#5c4024', '#6e4e2c', '#7d5a33', '#8a6640');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) i.set(x, y, pick(wood, r()));
});

function repeater(i: Img, r: Rand, on: boolean): void {
  noisy(i, r, P('#a0a0a0', '#a8a8a8', '#b0b0b0'), 0.7, 2);
  // The dust track along the middle, with the torch spots at both ends.
  const dust = on ? P('#e01010', '#ff3020', '#c00808') : P('#5a0a08', '#6a1010', '#4a0606');
  for (let y = 1; y < 15; y++) for (let x = 7; x < 9; x++) i.set(x, y, pick(dust, r()));
  for (let x = 2; x < 14; x++) i.set(x, 13, pick(dust, r()));
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#c4c4c4')); i.set(k, 15, hex('#7a7a7a')); }
}
put('repeater', (i, r) => repeater(i, r, false));
put('repeater_on', (i, r) => repeater(i, r, true));

function lamp(i: Img, r: Rand, on: boolean): void {
  const glass = on ? P('#f6d29a', '#ffe7b8', '#e9b06a', '#fff2d4') : P('#5a3a22', '#6b4628', '#7a5230', '#4a2f1a');
  noisy(i, r, glass, 0.4, 4);
  const frame = on ? hex('#b07a3c') : hex('#3a2414');
  for (let k = 0; k < 16; k++) { i.set(k, 0, frame); i.set(k, 15, frame); i.set(0, k, frame); i.set(15, k, frame); }
  // A frame of four panes.
  for (let k = 1; k < 15; k++) { i.set(k, 7, shade(frame, 1.1)); i.set(7, k, shade(frame, 1.1)); }
}
put('redstone_lamp', (i, r) => lamp(i, r, false));
put('redstone_lamp_on', (i, r) => lamp(i, r, true));

put('note_block', (i, r) => {
  paintPlanks(i, r, P('#6b4228', '#7a4c2e', '#874f2f', '#94603a'), hex('#40261a'));
  // A dark speaker grille in the middle.
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) i.set(x, y, (x + y) % 2 ? hex('#2a1810') : hex('#3c2418'));
});

function pistonWood(i: Img, r: Rand): void {
  paintPlanks(i, r, P('#9c7f4e', '#a78a57', '#b39560', '#bc9f6a'), hex('#6b5332'));
}
put('piston_top', (i, r) => {
  pistonWood(i, r);
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#7a7a7a')); i.set(k, 15, hex('#7a7a7a')); i.set(0, k, hex('#7a7a7a')); i.set(15, k, hex('#7a7a7a')); }
});
put('piston_top_sticky', (i, r) => {
  pistonWood(i, r);
  // The slime pad.
  for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) i.set(x, y, pick(P('#6fc25a', '#7fd068', '#5fae4c'), r()));
});
put('piston_side', (i, r) => {
  noisy(i, r, P(...STONE), 0.5, 4);
  // Wooden band at the front (top rows of the image), iron trim below it.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) i.set(x, y, pick(P('#9c7f4e', '#a78a57', '#b39560'), r()));
  for (let x = 0; x < 16; x++) i.set(x, 4, hex('#5e5e5e'));
  for (let y = 7; y < 12; y++) for (let x = 6; x < 10; x++) i.set(x, y, hex('#9a9a9a'));
});
put('piston_bottom', (i, r) => {
  noisy(i, r, P(...STONE), 0.5, 4);
  for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) i.set(x, y, hex('#5a5a5a'));
});
put('piston_inner', (i, r) => {
  noisy(i, r, P('#5e5e5e', '#666666', '#6e6e6e'), 0.5, 4);
  for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) i.set(x, y, pick(P('#9c7f4e', '#a78a57'), r()));
});
