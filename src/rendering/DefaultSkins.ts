import { SKIN_BOXES, type SkinBox, faceRects } from '../skins/SkinFormat';

/**
 * The built-in player skins, painted in the classic 64x64 layout like any uploaded skin: one for everybody and one
 * per arcade team (a red or blue shirt). They are the fallback whenever a custom skin is missing, switched off or
 * hidden. Painted procedurally (no image files in the repo), with a fixed random sequence so they always look the same.
 */
const SKIN = ['#c99a7a', '#bf8f6f', '#d1a585'];
const PANTS = ['#3a3f9a', '#323688', '#4248aa'];
const HAIR = ['#3b2414', '#4a2e1a', '#33200f'];
export const SHIRTS = {
  neutral: ['#2d9fa6', '#268a90', '#33b0b8'],
  red: ['#c8372f', '#b32d26', '#d8443b'],
  blue: ['#2f5fc8', '#2850b0', '#3a6fdc'],
} as const;

type Put = (x: number, y: number, w: number, h: number, colors: readonly string[]) => void;

/** Paints one default skin into the 64x64 cell whose top-left corner is (ox, oy) of `ctx`. */
export function paintDefaultSkin(ctx: CanvasRenderingContext2D, ox: number, oy: number, shirt: readonly string[]): void {
  let seed = 0x2545f491;
  const rand = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const pixel = (x: number, y: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, 1, 1); };
  // Base colour most of the time, sparse variation pixels (Minecraft-like noise).
  const fill: Put = (x, y, w, h, colors) => {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) pixel(x + i, y + j, colors[rand() < 0.6 ? 0 : 1 + Math.floor(rand() * Math.max(1, colors.length - 1)) % colors.length]);
    }
  };
  const faces = (box: SkinBox, colors: readonly string[]) => {
    for (const [fx, fy, fw, fh] of faceRects(box)) fill(box.u + fx, box.v + fy, fw, fh, colors);
  };

  // Head: skin, then hair on top, at the back and as a fringe; the face is the classic two eyes and a mouth.
  const head = SKIN_BOXES.head;
  faces(head, SKIN);
  const [top, , right, front, left, back] = faceRects(head).map(([fx, fy, fw, fh]) => ({ x: head.u + fx, y: head.v + fy, w: fw, h: fh }));
  fill(top.x, top.y, top.w, top.h, HAIR);
  fill(back.x, back.y, back.w, back.h, HAIR);
  fill(front.x, front.y, front.w, 2, HAIR);
  pixel(front.x, front.y + 2, HAIR[0]); pixel(front.x + 7, front.y + 2, HAIR[0]);
  fill(right.x, right.y, right.w, 2, HAIR);
  fill(left.x, left.y, left.w, 2, HAIR);
  // Sideburn on the half of each side face that faces the back of the head.
  fill(right.x, right.y + 2, 4, 2, HAIR);
  fill(left.x + 4, left.y + 2, 4, 2, HAIR);
  const f = (x: number, y: number, c: string) => pixel(front.x + x, front.y + y, c);
  f(1, 4, '#ffffff'); f(2, 4, '#3a5bb0'); f(5, 4, '#3a5bb0'); f(6, 4, '#ffffff');
  f(3, 6, '#8a5a40'); f(4, 6, '#8a5a40');

  faces(SKIN_BOXES.body, shirt);
  faces(SKIN_BOXES.rightArm, SKIN);
  faces(SKIN_BOXES.leftArm, SKIN);
  faces(SKIN_BOXES.rightLeg, PANTS);
  faces(SKIN_BOXES.leftLeg, PANTS);
}
