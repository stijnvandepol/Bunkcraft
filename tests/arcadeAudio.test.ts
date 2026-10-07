import { describe, expect, it } from 'vitest';
import { impactMaterial } from '../src/core/audio/impacts';
import { buildCatalog } from '../src/core/audio/catalog';
import { BLOCK } from '../src/world/BlockRegistry';

describe('bullet impact sounds by material', () => {
  it('maps the arena blocks to a material', () => {
    expect(impactMaterial(BLOCK.STONE_BRICKS)).toBe('stone');
    expect(impactMaterial(BLOCK.CONCRETE)).toBe('stone');
    expect(impactMaterial(BLOCK.OAK_PLANKS)).toBe('wood');
    expect(impactMaterial(BLOCK.FENCE)).toBe('wood');
    expect(impactMaterial(BLOCK.GLASS)).toBe('glass');
    expect(impactMaterial(BLOCK.STAINED_GLASS_PANE)).toBe('glass');
    expect(impactMaterial(BLOCK.IRON_BARS)).toBe('metal');
    expect(impactMaterial(BLOCK.WHITE_WOOL)).toBe('wool');
    expect(impactMaterial(BLOCK.OAK_LEAVES)).toBe('leaves');
    expect(impactMaterial(BLOCK.DIRT)).toBe('soil');
    expect(impactMaterial(BLOCK.SAND)).toBe('soil');
    expect(impactMaterial(-1)).toBe('stone');
  });

  it('the audio report covers the new combat sounds', () => {
    const names = new Set(buildCatalog().map((e) => e.name));
    for (const n of ['weapon.impact.glass', 'weapon.impact.metal', 'weapon.impact.wood', 'weapon.whizz', 'weapon.whizz.sniper', 'player.heartbeat',
      'weapon.hitmarker', 'weapon.hitmarker.head', 'weapon.kill']) {
      expect(names.has(n), n).toBe(true);
    }
  });
});
