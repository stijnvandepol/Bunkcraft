import type { TextureSet } from '../rendering/TextureAtlas';
import { getItemDef } from '../items/ItemRegistry';
import { getBlockDef } from '../world/BlockRegistry';
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

  private render(id: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (id >= 256) {
      const sprite = getItemDef(id)?.sprite;
      if (sprite) ctx.drawImage(paintItemSprite(sprite), 4, 4, 56, 56);
      return canvas;
    }
    const def = getBlockDef(id);
    if (!def) return canvas;
    const t = def.textures;

    if (def.shape === 'cross' || def.shape === 'model') {
      ctx.drawImage(this.textures.canvas(t.all!), 4, 4, 56, 56);
      return canvas;
    }

    const top = this.textures.canvas(t.top ?? t.all!);
    const side = this.textures.canvas(t.side ?? t.all!);
    const s = 1.75; // 16 px texture → 28 px wide face
    // Left face.
    ctx.setTransform(s, s / 2, 0, s, 4, 18);
    ctx.drawImage(side, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, 16, 16);
    // Right face.
    ctx.setTransform(s, -s / 2, 0, s, 32, 32);
    ctx.drawImage(side, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, 16, 16);
    // Top face.
    ctx.setTransform(s, -s / 2, s, s / 2, 4, 18);
    ctx.drawImage(top, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }
}
