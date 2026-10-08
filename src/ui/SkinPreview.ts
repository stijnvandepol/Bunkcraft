import { SHIRTS, paintDefaultSkin } from '../rendering/DefaultSkins';
import { SKIN_BOXES, SKIN_SIZE, type SkinBox } from '../skins/SkinFormat';

/**
 * A rotating preview of a skin on the player model, drawn with the 2D canvas (no second WebGL context in a menu).
 * Every face of every box is a parallelogram under an orthographic view, so it is one `drawImage` with an affine
 * transform; faces are sorted back to front and shaded like the game does (darker sides and bottom).
 * Boxes mirror the model in MobTypes.ts: a base layer and the slightly larger overlay layer on top.
 */
type V3 = [number, number, number];

interface PreviewBox { from: V3; to: V3; skin: SkinBox; grow: number }

const B = SKIN_BOXES;
/** Model pixels, front = −Z, the player's left = −X (same as MobTypes.playerType). */
const BOXES: PreviewBox[] = [
  { from: [-4, 24, -4], to: [4, 32, 4], skin: B.head, grow: 0 },
  { from: [-4, 12, -2], to: [4, 24, 2], skin: B.body, grow: 0 },
  { from: [-8, 12, -2], to: [-4, 24, 2], skin: B.leftArm, grow: 0 },
  { from: [4, 12, -2], to: [8, 24, 2], skin: B.rightArm, grow: 0 },
  { from: [-4, 0, -2], to: [0, 12, 2], skin: B.leftLeg, grow: 0 },
  { from: [0, 0, -2], to: [4, 12, 2], skin: B.rightLeg, grow: 0 },
  { from: [-4, 24, -4], to: [4, 32, 4], skin: B.hat, grow: 0.5 },
  { from: [-4, 12, -2], to: [4, 24, 2], skin: B.jacket, grow: 0.25 },
  { from: [-8, 12, -2], to: [-4, 24, 2], skin: B.leftSleeve, grow: 0.25 },
  { from: [4, 12, -2], to: [8, 24, 2], skin: B.rightSleeve, grow: 0.25 },
  { from: [-4, 0, -2], to: [0, 12, 2], skin: B.leftPants, grow: 0.25 },
  { from: [0, 0, -2], to: [4, 12, 2], skin: B.rightPants, grow: 0.25 },
];

/** Brightness of a face by its normal: top, front/back, sides, bottom (the game's Minecraft-like shading). */
const SHADES = [1, 0.82, 0.65, 0.5];

interface Face {
  /** Top-left corner, the corner right of it and the corner below it (model space). */
  o: V3; r: V3; d: V3;
  /** Source rectangle in the skin. */
  sx: number; sy: number; sw: number; sh: number;
  shade: number;
  normal: V3;
}

function facesOf(b: PreviewBox): Face[] {
  const [x0, y0, z0] = [b.from[0] - b.grow, b.from[1] - b.grow, b.from[2] - b.grow];
  const [x1, y1, z1] = [b.to[0] + b.grow, b.to[1] + b.grow, b.to[2] + b.grow];
  const { u, v, w, h, d } = b.skin;
  const f = (o: V3, r: V3, dn: V3, sx: number, sy: number, sw: number, sh: number, shade: number, normal: V3): Face =>
    ({ o, r, d: dn, sx, sy, sw, sh, shade, normal });
  // Corner order as in MobRenderer.boxGeometry: top-left, top-right, bottom-left of each face as seen from outside.
  return [
    f([x1, y1, z0], [x0, y1, z0], [x1, y0, z0], u + d, v + d, w, h, 1, [0, 0, -1]), // front
    f([x0, y1, z1], [x1, y1, z1], [x0, y0, z1], u + 2 * d + w, v + d, w, h, 1, [0, 0, 1]), // back
    f([x1, y1, z1], [x1, y1, z0], [x1, y0, z1], u, v + d, d, h, 2, [1, 0, 0]), // +X
    f([x0, y1, z0], [x0, y1, z1], [x0, y0, z0], u + d + w, v + d, d, h, 2, [-1, 0, 0]), // −X
    f([x1, y1, z1], [x0, y1, z1], [x1, y1, z0], u + d, v, w, d, 0, [0, 1, 0]), // top
    f([x1, y0, z0], [x0, y0, z0], [x1, y0, z1], u + d + w, v, w, d, 3, [0, -1, 0]), // bottom
  ];
}

const FACES: Face[] = BOXES.flatMap(facesOf);

/** Canonical skin pixels (64x64 RGBA) of the default skin, for a preview of "no custom skin". */
export function defaultSkinPixels(): Uint8Array {
  const c = document.createElement('canvas');
  c.width = c.height = SKIN_SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  paintDefaultSkin(ctx, 0, 0, SHIRTS.neutral);
  return new Uint8Array(ctx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data);
}

export class SkinPreview {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The skin at four brightness levels (index = face shade). */
  private readonly shaded: HTMLCanvasElement[] = [];
  private angle = 0.6;
  private frame = 0;
  private last = 0;
  private running = false;
  /** Pixels of the model's height: the canvas is sized so the whole model fits at this scale. */
  private readonly scale: number;
  private order: { face: Face; depth: number }[] = [];

  constructor(scale = 5) {
    this.scale = scale;
    this.el = document.createElement('canvas');
    this.el.className = 'skin-preview';
    this.el.width = 24 * scale;
    this.el.height = 38 * scale;
    this.el.setAttribute('role', 'img');
    this.ctx = this.el.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.setPixels(defaultSkinPixels());
  }

  /** Shows these canonical skin pixels (64x64 RGBA). */
  setPixels(rgba: Uint8Array): void {
    const base = document.createElement('canvas');
    base.width = base.height = SKIN_SIZE;
    const bctx = base.getContext('2d')!;
    bctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), SKIN_SIZE, SKIN_SIZE), 0, 0);
    this.shaded.length = 0;
    for (const shade of SHADES) {
      const c = document.createElement('canvas');
      c.width = c.height = SKIN_SIZE;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(base, 0, 0);
      // Darken only the opaque pixels, so the cut-out parts of the overlay layer stay see-through.
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
      ctx.fillRect(0, 0, SKIN_SIZE, SKIN_SIZE);
      this.shaded.push(c);
    }
    this.draw();
  }

  /** Starts turning; stops by itself when the canvas leaves the page. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      if (!this.el.isConnected && this.frame > 0) { this.running = false; return; }
      // Reduced motion: a still three-quarter view.
      const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!still) this.angle += Math.min(0.1, (now - this.last) / 1000) * 0.9;
      this.last = now;
      this.draw();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private draw(): void {
    const { ctx, scale } = this;
    const w = this.el.width, h = this.el.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);
    const tilt = 0.2; // the viewer looks slightly down on the model
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const k = scale * 0.92;
    // Model → view: yaw around Y, then pitch around X. The viewer stands at −Z (the model faces −Z at angle 0), so a
    // larger z is farther away. Orthographic; the screen y axis grows downwards.
    const rotate = (p: V3): V3 => {
      const x = p[0] * cos + p[2] * sin;
      const z = -p[0] * sin + p[2] * cos;
      return [x, p[1] * ct + z * st, z * ct - p[1] * st];
    };
    const project = (p: V3): V3 => {
      const v = rotate(p);
      // The viewer faces +Z: the model's +X (its right) is on the viewer's left.
      return [w / 2 - v[0] * k, h - (v[1] + 2) * k, v[2]];
    };
    this.order.length = 0;
    for (const face of FACES) {
      // A face is seen when its normal points at the viewer (towards −Z in view space).
      if (rotate(face.normal)[2] >= -0.0001) continue;
      const mid: V3 = [
        face.o[0] + (face.r[0] - face.o[0]) / 2 + (face.d[0] - face.o[0]) / 2,
        face.o[1] + (face.r[1] - face.o[1]) / 2 + (face.d[1] - face.o[1]) / 2,
        face.o[2] + (face.r[2] - face.o[2]) / 2 + (face.d[2] - face.o[2]) / 2,
      ];
      this.order.push({ face, depth: rotate(mid)[2] });
    }
    // Far faces first.
    this.order.sort((a, b) => b.depth - a.depth);
    for (const { face } of this.order) {
      const o = project(face.o), r = project(face.r), d = project(face.d);
      ctx.setTransform(
        (r[0] - o[0]) / face.sw, (r[1] - o[1]) / face.sw,
        (d[0] - o[0]) / face.sh, (d[1] - o[1]) / face.sh,
        o[0], o[1],
      );
      ctx.drawImage(this.shaded[face.shade], face.sx, face.sy, face.sw, face.sh, 0, 0, face.sw, face.sh);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
