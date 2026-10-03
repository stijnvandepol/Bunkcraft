/**
 * The inventory guard pays for placed blocks (QA: a modified client placed diamond ore it never had and mined it).
 * Honest play must never be refused: every block item, placed the way the client places it, is backed by exactly
 * the one item it uses up.
 */
import { describe, expect, it } from 'vitest';
import { InventoryGuard, classifyEdit, placingItem } from '../server/InventoryGuard';
import { ITEM, getItemDef, isBlockItem, itemBlock, itemFromState, itemId, itemMeta } from '../src/items/ItemRegistry';
import { BLOCK, BOX_KIND, CUBE_ID, SHAPE, SHAPE_CROSS, SHAPE_MODEL, getBlockDef } from '../src/world/BlockRegistry';
import { allCreativeItems, buildCreativeTabs } from '../src/ui/CreativeTabs';
import { BOX_BED } from '../src/world/BoxShapes';
import { resolvePlacement } from '../src/world/Placement';

const REDSTONE = itemId('redstone');

/** A flat stone world at y ≤ 63 with a stone pillar at (0, 64..66, 0) to click on from the side. */
class FlatWorld {
  readonly blocks = new Map<string, [number, number]>();
  get = (x: number, y: number, z: number): number => this.blocks.get(`${x},${y},${z}`)?.[0] ?? (y <= 63 || (x === 0 && z === 0 && y <= 66) ? BLOCK.STONE : BLOCK.AIR);
  meta = (x: number, y: number, z: number): number => this.blocks.get(`${x},${y},${z}`)?.[1] ?? 0;
  set(x: number, y: number, z: number, id: number, meta: number): void { this.blocks.set(`${x},${y},${z}`, [id, meta]); }
}

/** Sends one edit through the guard the way GameServer.onBlock does, and applies it when accepted. */
function edit(g: InventoryGuard, w: FlatWorld, x: number, y: number, z: number, id: number, meta: number): boolean {
  const ok = g.authorizeEdit({ x, y, z }, w.get(x, y, z), w.meta(x, y, z), id, meta, w.get(x, y + 1, z));
  if (ok) w.set(x, y, z, id, meta);
  return ok;
}

/** Places `item` like Interaction.place: main block, then the neighbour change, then the upper half. */
function place(g: InventoryGuard, w: FlatWorld, item: number, click: { side: boolean; fracY: number; yaw: number }): boolean | null {
  const dust = item === REDSTONE;
  const id = dust ? BLOCK.REDSTONE_WIRE : itemBlock(item), baseMeta = dust ? 0 : itemMeta(item);
  const hit = click.side ? { hitX: 0, hitY: 65, hitZ: 0, nx: 1, ny: 0, nz: 0 } : { hitX: 4, hitY: 63, hitZ: 4, nx: 0, ny: 1, nz: 0 };
  const p = resolvePlacement({
    id, variant: baseMeta, ...hit, fracY: click.fracY, fracX: 0.3, fracZ: 0.7, yaw: click.yaw, pitch: 0, getBlock: w.get, getMeta: w.meta,
  });
  if (!p) return null;
  if (!edit(g, w, p.x, p.y, p.z, id, p.meta | baseMeta)) return false;
  if (p.neighbor && !edit(g, w, p.neighbor.x, p.neighbor.y, p.neighbor.z, p.neighbor.id, p.neighbor.meta)) return false;
  if (p.upper && !edit(g, w, p.upper.x, p.upper.y, p.upper.z, id, p.upper.meta | baseMeta)) return false;
  return true;
}

const placeable = allCreativeItems(buildCreativeTabs()).filter((id) => id === REDSTONE || (isBlockItem(id) && getBlockDef(itemBlock(id))?.inInventory !== false));
const CLICKS = [
  { side: false, fracY: 1, yaw: 0 }, { side: false, fracY: 1, yaw: Math.PI / 2 }, { side: false, fracY: 1, yaw: Math.PI },
  { side: false, fracY: 1, yaw: -Math.PI / 2 }, { side: true, fracY: 0.2, yaw: Math.PI / 2 }, { side: true, fracY: 0.8, yaw: -Math.PI / 2 },
];

describe('placing blocks is paid from the inventory', () => {
  it('covers a good spread of block items (variants, colours, slabs, stairs, doors, beds)', () => {
    expect(placeable.length).toBeGreaterThan(150);
    expect(placeable.some((id) => id >= 1024)).toBe(true);
    expect(placeable.some((id) => BOX_KIND[itemBlock(id)] === BOX_BED && itemMeta(id) > 0)).toBe(true);
  });

  it('accepts every block item the player holds, in every orientation, using up exactly that item', () => {
    const failures: string[] = [];
    let placed = 0;
    for (const item of placeable) {
      for (const click of CLICKS) {
        const w = new FlatWorld();
        const g = new InventoryGuard([{ id: item, count: 1 }]);
        const r = place(g, w, item, click);
        if (r === null) continue;
        placed++;
        if (r === false || g.poolCount !== 0) failures.push(`${getItemDef(item)?.name ?? item} ${JSON.stringify(click)}: ${r === false ? 'refused' : `pool ${g.poolCount}`}`);
      }
    }
    expect(failures).toEqual([]);
    expect(placed).toBeGreaterThan(placeable.length * 4);
  });

  it('refuses every block item the player does not hold (the diamond ore exploit)', () => {
    const accepted: string[] = [];
    let refused = 0;
    for (const item of placeable) {
      const w = new FlatWorld();
      const g = new InventoryGuard([{ id: ITEM.STICK, count: 1 }]);
      const r = place(g, w, item, CLICKS[0]);
      if (r === true) accepted.push(getItemDef(item)?.name ?? String(item));
      if (r === false) refused++;
    }
    expect(accepted).toEqual([]);
    expect(refused).toBeGreaterThan(placeable.length * 0.9);
    const g = new InventoryGuard([]);
    expect(g.authorizeEdit({ x: 0, y: 64, z: 0 }, BLOCK.AIR, 0, BLOCK.DIAMOND_ORE, 0, BLOCK.AIR)).toBe(false);
  });

  it('maps placed states back to their item (variant bits kept, facing dropped)', () => {
    expect(placingItem(BLOCK.WOOL, 14)).toBe(itemFromState(BLOCK.WOOL, 14));
    expect(placingItem(BLOCK.REDSTONE_WIRE, 9)).toBe(REDSTONE);
    expect(placingItem(BLOCK.BEDROCK, 0)).toBe(BLOCK.BEDROCK); // a real item; only creative ever has it
  });

  it('a slab on a slab costs a second slab', () => {
    const w = new FlatWorld();
    const g = new InventoryGuard([{ id: BLOCK.STONE_SLAB, count: 1 }]);
    const click = { side: false, fracY: 1, yaw: 0 };
    expect(place(g, w, BLOCK.STONE_SLAB, click)).toBe(true);
    // The second click on the slab's top makes it double, but there is no slab left.
    const p = resolvePlacement({ id: BLOCK.STONE_SLAB, hitX: 4, hitY: 64, hitZ: 4, nx: 0, ny: 1, nz: 0, fracY: 0.5, yaw: 0, getBlock: w.get, getMeta: w.meta })!;
    expect(p.y).toBe(64);
    expect(edit(g, w, p.x, p.y, p.z, BLOCK.STONE_SLAB, p.meta)).toBe(false);
    const g2 = new InventoryGuard([{ id: BLOCK.STONE_SLAB, count: 2 }]);
    const w2 = new FlatWorld();
    expect(place(g2, w2, BLOCK.STONE_SLAB, click)).toBe(true);
    expect(edit(g2, w2, p.x, p.y, p.z, BLOCK.STONE_SLAB, p.meta)).toBe(true);
    expect(g2.poolCount).toBe(0);
  });

  it('the upper half of a door or the head of a bed is free only right after its item was paid', () => {
    const w = new FlatWorld();
    // An upper door half on its own, without a door in the inventory, is a door out of nothing.
    expect(edit(new InventoryGuard([{ id: BLOCK.STONE, count: 5 }]), w, 8, 65, 8, BLOCK.DOOR, 4)).toBe(false);
    const g = new InventoryGuard([{ id: BLOCK.DOOR, count: 1 }, { id: BLOCK.STONE, count: 5 }]);
    expect(edit(g, w, 8, 64, 8, BLOCK.DOOR, 0)).toBe(true);
    expect(edit(g, w, 8, 65, 8, BLOCK.DOOR, 4)).toBe(true);
    // ...and only once.
    expect(edit(g, w, 9, 64, 8, BLOCK.DOOR, 0)).toBe(false);
  });

  it('changing the colour or material of a block in place is a new block', () => {
    const w = new FlatWorld();
    w.set(5, 64, 5, BLOCK.WOOL, 0);
    const g = new InventoryGuard([{ id: BLOCK.STONE, count: 1 }]);
    expect(edit(g, w, 5, 64, 5, BLOCK.WOOL, 14)).toBe(false);
  });

  it('crafts a block on the spot when the client crafted it after its last state (log → planks → placed)', () => {
    const planks = BLOCK.OAK_PLANKS;
    const w = new FlatWorld();
    const g = new InventoryGuard([{ id: BLOCK.OAK_LOG, count: 1 }]);
    expect(edit(g, w, 2, 64, 2, itemBlock(planks), itemMeta(planks))).toBe(true);
    // One log made four planks; one was placed. The next state with three planks passes.
    expect(g.check([[planks, 3, 0]]).ok).toBe(true);
  });

  it('buckets: pouring needs a full bucket and gives the empty one back; scooping fills it', () => {
    const w = new FlatWorld();
    const g = new InventoryGuard([{ id: ITEM.BUCKET, count: 1 }]);
    expect(edit(g, w, 3, 64, 3, BLOCK.WATER, 0)).toBe(false);
    w.set(6, 64, 6, BLOCK.WATER, 0);
    expect(edit(g, w, 6, 64, 6, BLOCK.AIR, 0)).toBe(true); // scoop: bucket → water bucket
    expect(edit(g, w, 3, 64, 3, BLOCK.WATER, 0)).toBe(true); // pour it again before any state
    expect(g.check([[ITEM.BUCKET, 1, 0]]).ok).toBe(true);
    const lava = new InventoryGuard([{ id: ITEM.LAVA_BUCKET, count: 1 }]);
    expect(edit(lava, new FlatWorld(), 3, 64, 3, BLOCK.LAVA, 0)).toBe(true);
    expect(lava.check([[ITEM.BUCKET, 1, 0]]).ok).toBe(true);
  });

  it('tools change blocks without using an item; toggles and breaking are free', () => {
    expect(classifyEdit(BLOCK.GRASS, 0, CUBE_ID.farmland, 0, BLOCK.AIR).kind).toBe('tool');
    expect(classifyEdit(BLOCK.OAK_LOG, 0, CUBE_ID.stripped_oak_log, 0, BLOCK.AIR).kind).toBe('tool');
    expect(classifyEdit(BLOCK.LEVER, 0, BLOCK.LEVER, 8, BLOCK.AIR).kind).toBe('free');
    expect(classifyEdit(BLOCK.DIAMOND_ORE, 0, BLOCK.AIR, 0, BLOCK.AIR).kind).toBe('free');
    const g = new InventoryGuard([]);
    expect(g.authorizeEdit({ x: 0, y: 63, z: 0 }, BLOCK.GRASS, 0, CUBE_ID.farmland, 0, BLOCK.AIR)).toBe(true);
  });

  it('plants, saplings and torches are paid like blocks', () => {
    const cross = placeable.filter((id) => SHAPE[itemBlock(id)] === SHAPE_CROSS || SHAPE[itemBlock(id)] === SHAPE_MODEL);
    expect(cross.length).toBeGreaterThan(5);
    for (const item of cross) {
      const g = new InventoryGuard([{ id: item, count: 1 }]);
      expect(place(g, new FlatWorld(), item, CLICKS[0])).toBe(true);
    }
  });

  it('right after creative (trust next state) placing is not checked', () => {
    const g = new InventoryGuard([]);
    g.trustNextState();
    expect(g.authorizeEdit({ x: 0, y: 64, z: 0 }, BLOCK.AIR, 0, BLOCK.DIAMOND_ORE, 0, BLOCK.AIR)).toBe(true);
  });
});
