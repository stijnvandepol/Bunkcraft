import type { TextureSet } from '../rendering/TextureAtlas';
import { VARIANT_ITEM_BASE, getItemDef, itemBlock, itemMeta } from '../items/ItemRegistry';
import { DYE_RGB, getBlockDef, stateTextures } from '../world/BlockRegistry';
import { EAST, OCT_BOTTOM, STAIR_STRAIGHT, octantBoxes, stairMeta, stairOctants } from '../world/BlockStates';
import { paintItemSprite } from './ItemSprites';

const SIZE = 64;

/**
 * Renders isometric inventory icons from the same procedural textures the world uses,
 * by drawing three affine-transformed faces on a 2D canvas. Cached as data URLs.
 */
export class BlockIcons {
  private readonly cache = new Map<number, string>();

  constructor(private readonly textures: TextureSet) {}

  private readonly canvases = new Map<number, HTMLCanvasElement>();
  /** Bumped when icons are invalidated (texture pack change). */
  version = 0;

  clear(): void {
    this.cache.clear();
    this.canvases.clear();
    this.version++;
  }

  /** 64×64 icon canvas (cached). */
  canvas(id: number): HTMLCanvasElement {
    let c = this.canvases.get(id);
    if (!c) {
      c = this.render(id);
      this.canvases.set(id, c);
    }
    return c;
  }

  /** Icon as a data URL for <img> elements (cached). */
  get(id: number): string {
    let url = this.cache.get(id);
    if (!url) {
      url = this.canvas(id).toDataURL();
      this.cache.set(id, url);
    }
    return url;
  }

  /**
   * Isometric boxes (block units 0..1, x0 y0 z0 x1 y1 z1 per box) in the same projection as the cube icon:
   * the −X face on the left, the +Z face on the right and the top. Far boxes are painted first.
   */
  private drawBoxes(ctx: CanvasRenderingContext2D, top: CanvasImageSource, side: CanvasImageSource, boxes: number[], n: number): void {
    const s = 1.75;
    const order = Array.from({ length: n }, (_, k) => k)
      .sort((a, b) => boxes[a * 6 + 1] - boxes[b * 6 + 1] || (boxes[b * 6] - boxes[b * 6 + 2]) - (boxes[a * 6] - boxes[a * 6 + 2]));
    // Screen position of a block-space point on the cube icon (left corner of the top face at 4, 18).
    const px = (x: number, y: number, z: number): [number, number] => [4 + (x + z) * 16 * s, 18 + (z - x) * 8 * s + (1 - y) * 16 * s];
    for (const k of order) {
      const [x0, y0, z0, x1, y1, z1] = boxes.slice(k * 6, k * 6 + 6);
      const face = (img: CanvasImageSource, m: number[], o: [number, number], sx: number, sy: number, sw: number, sh: number, shade: number): void => {
        ctx.setTransform(m[0], m[1], m[2], m[3], o[0], o[1]);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        if (shade) { ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(0, 0, sw, sh); }
      };
      // −X face (left): z runs along the screen's down-right, texture rows are height.
      face(side, [s, s / 2, 0, s], px(x0, y1, z0), z0 * 16, (1 - y1) * 16, (z1 - z0) * 16, (y1 - y0) * 16, 0.22);
      // +Z face (right): x runs up-right.
      face(side, [s, -s / 2, 0, s], px(x0, y1, z1), x0 * 16, (1 - y1) * 16, (x1 - x0) * 16, (y1 - y0) * 16, 0.42);
      // Top.
      face(top, [s, -s / 2, s, s / 2], px(x0, y1, z0), x0 * 16, z0 * 16, (x1 - x0) * 16, (z1 - z0) * 16, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private render(id: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (id >= 256 && id < VARIANT_ITEM_BASE) {
      const sprite = getItemDef(id)?.sprite;
      if (sprite) ctx.drawImage(paintItemSprite(sprite), 4, 4, 56, 56);
      return canvas;
    }
    const def = getBlockDef(itemBlock(id));
    if (!def) return canvas;
    const meta = itemMeta(id);
    this.drawBlock(ctx, def, meta);
    if (def.dye) {
      // Dye families are one grey texture: multiply the icon by the colour of this variant (keeps the icon's alpha).
      const copy = document.createElement('canvas');
      copy.width = copy.height = SIZE;
      copy.getContext('2d')!.drawImage(canvas, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `#${DYE_RGB[meta & 15].toString(16).padStart(6, '0')}`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(copy, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    return canvas;
  }

  private drawBlock(ctx: CanvasRenderingContext2D, def: NonNullable<ReturnType<typeof getBlockDef>>, meta: number): void {
    const canvas = ctx.canvas;
    const t = stateTextures(def, meta);

    if (def.shape === 'cross' || def.shape === 'model') {
      ctx.drawImage(this.textures.canvas(t.all!), 4, 4, 56, 56);
      return;
    }

    const top = this.textures.canvas(t.top ?? t.all!);
    const side = this.textures.canvas(t.side ?? t.all!);
    if (def.shape === 'slab' || def.shape === 'stairs') {
      // A bottom slab, or a straight stair whose tall back is on the far side.
      const boxes: number[] = [];
      const n = octantBoxes(def.shape === 'slab' ? OCT_BOTTOM : stairOctants(stairMeta(EAST, false), STAIR_STRAIGHT), boxes);
      this.drawBoxes(ctx, top, side, boxes, n);
      return;
    }
    if (def.shape === 'door') {
      // Like Minecraft's item: the flat door, upper half over the lower half.
      ctx.drawImage(this.textures.canvas(t.top!), 12, 2, 40, 30);
      ctx.drawImage(this.textures.canvas(t.side!), 12, 32, 40, 30);
      return;
    }
    const s = 1.75; // 16 px texture → 28 px wide face
    // Left face.
    ctx.setTransform(s, s / 2, 0, s, 4, 18);
    ctx.drawImage(side, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, 16, 16);
    // Right face (the front of a furnace, chest or pumpkin).
    ctx.setTransform(s, -s / 2, 0, s, 32, 32);
    ctx.drawImage(def.facing && t.front ? this.textures.canvas(t.front) : side, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, 16, 16);
    // Top face.
    ctx.setTransform(s, -s / 2, s, s / 2, 4, 18);
    ctx.drawImage(top, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    void canvas;
  }
}
