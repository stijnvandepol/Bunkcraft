import type { TextureSet } from '../rendering/TextureAtlas';
import { getBlockDef } from '../world/BlockRegistry';

const SIZE = 64;

/**
 * Renders isometric inventory icons from the same procedural textures the world uses,
 * by drawing three affine-transformed faces on a 2D canvas. Cached as data URLs.
 */
export class BlockIcons {
  private readonly cache = new Map<number, string>();

  constructor(private readonly textures: TextureSet) {}

  clear(): void {
    this.cache.clear();
  }

  get(id: number): string {
    let url = this.cache.get(id);
    if (!url) {
      url = this.render(id);
      this.cache.set(id, url);
    }
    return url;
  }

  private render(id: number): string {
    const def = getBlockDef(id);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (!def) return canvas.toDataURL();
    const t = def.textures;

    if (def.shape === 'cross') {
      ctx.drawImage(this.textures.canvas(t.all!), 4, 4, 56, 56);
      return canvas.toDataURL();
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
    return canvas.toDataURL();
  }
}
