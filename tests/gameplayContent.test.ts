import { describe, expect, it } from 'vitest';
import { PlayerInventory } from '../src/items/Inventory';
import { getItemDef, itemFromState, itemId, maxDurability } from '../src/items/ItemRegistry';
import { ARMOR_BASE_DURABILITY, ARMOR_MATERIALS } from '../src/items/ItemContent';
import { toolUse } from '../src/items/ToolUse';
import { ARMOR_CAUSES, armorWear, damageReduction, reduceDamage } from '../src/player/Armor';
import { Player } from '../src/player/Player';
import { PlayerStats } from '../src/player/PlayerStats';
import { ChunkMesher } from '../src/rendering/ChunkMesher';
import { BLOCK, BOX_KIND, CUBE_ID, TALL } from '../src/world/BlockRegistry';
import { collisionBoxes, connectMask, isValidMeta } from '../src/world/BlockShapes';
import { BOX_BED, BOX_FENCE, BOX_PANE, BOX_WALL, SIDE_BIT, bedPartner, boxCollision, ladderSide, visualBoxes } from '../src/world/BoxShapes';
import { EAST, NORTH, SOUTH, WEST } from '../src/world/BlockStates';
import { CHUNK_AREA } from '../src/world/constants';
import { resolvePlacement } from '../src/world/Placement';
import { clipAxis } from '../src/player/Collision';
import { emptyChunk, setLocal, TestWorld } from './helpers';

class StateWorld extends TestWorld {
  private readonly metas = new Map<string, number>();
  put(x: number, y: number, z: number, id: number, meta = 0): this {
    this.set(x, y, z, id);
    this.metas.set(`${x},${y},${z}`, meta);
    return this;
  }
  readonly meta = (x: number, y: number, z: number): number => this.metas.get(`${x},${y},${z}`) ?? 0;
}

describe('armor (Java 1.21)', () => {
  it('reduces damage with the vanilla formula', () => {
    // 20 armor points without toughness: 80% reduction at most for small hits (armor / 5 = 4 of 25 → 16%... capped by the min/max rule).
    expect(damageReduction(10, 0, 0)).toBe(0);
    expect(damageReduction(5, 20, 0)).toBeCloseTo(Math.min(20, Math.max(4, 20 - 5 / 2)) / 25, 10);
    // Full leather (7 points) against a 3 damage hit.
    expect(reduceDamage(3, 7, 0)).toBeCloseTo(3 * (1 - Math.max(7 / 5, 7 - 3 / 2) / 25), 10);
    // Toughness helps against big hits: full diamond (20 points, 8 toughness) takes less than iron-like 20/0 from 20 damage.
    expect(reduceDamage(20, 20, 8)).toBeLessThan(reduceDamage(20, 20, 0));
    // Never more than 80% off.
    expect(damageReduction(1, 40, 0)).toBeLessThanOrEqual(0.8);
  });

  it('wears each piece by a quarter of the damage, at least 1', () => {
    expect(armorWear(1)).toBe(1);
    expect(armorWear(3)).toBe(1);
    expect(armorWear(8)).toBe(2);
    expect(armorWear(20)).toBe(5);
  });

  it('has the vanilla points, toughness and durability per piece', () => {
    const piece = (name: string) => getItemDef(itemId(name))!;
    expect(piece('iron_chestplate').armor).toMatchObject({ points: 6, toughness: 0 });
    expect(piece('diamond_helmet').armor).toMatchObject({ points: 3, toughness: 2 });
    expect(piece('golden_leggings').armor).toMatchObject({ points: 3 });
    expect(piece('chainmail_boots').armor).toMatchObject({ points: 1 });
    expect(maxDurability(itemId('iron_chestplate'))).toBe(240);
    expect(maxDurability(itemId('leather_helmet'))).toBe(55);
    expect(maxDurability(itemId('diamond_boots'))).toBe(429);
    expect(maxDurability(itemId('golden_helmet'))).toBe(77);
    // Full sets: 7 / 12 / 15 / 11 / 20 points.
    const totals = ARMOR_MATERIALS.map((m) => m.points.reduce((a, b) => a + b, 0));
    expect(totals).toEqual([7, 12, 15, 11, 20]);
    expect(ARMOR_BASE_DURABILITY).toEqual([11, 16, 15, 13]);
  });

  it('is worn through the inventory and saved with it', () => {
    const inv = new PlayerInventory();
    inv.set(0, { id: itemId('iron_helmet'), count: 1 });
    inv.set(1, { id: itemId('diamond_chestplate'), count: 1 });
    expect(inv.equipFromSlot(0)).toBe(true);
    expect(inv.equipFromSlot(1)).toBe(true);
    expect(inv.get(0).id).toBe(0);
    expect(inv.armorTotals()).toEqual({ points: 10, toughness: 2 });
    // Swapping: wearing another helmet puts the first back.
    inv.set(2, { id: itemId('golden_helmet'), count: 1 });
    inv.equipFromSlot(2);
    expect(inv.get(2).id).toBe(itemId('iron_helmet'));
    const copy = new PlayerInventory();
    copy.load(JSON.parse(JSON.stringify(inv.serialize())));
    expect(copy.armor[0].id).toBe(itemId('golden_helmet'));
    expect(copy.armor[1].id).toBe(itemId('diamond_chestplate'));
    expect(copy.armorTotals()).toEqual(inv.armorTotals());
    // Old saves have no armor records.
    const old = new PlayerInventory();
    old.load(inv.serialize().slice(0, 36));
    expect(old.armorTotals().points).toBe(0);
  });

  it('breaks pieces that run out of durability', () => {
    const inv = new PlayerInventory();
    inv.setArmor(3, { id: itemId('leather_boots'), count: 1, damage: 64 });
    expect(inv.wearArmor(1)).toBe(1);
    expect(inv.armor[3].id).toBe(0);
  });

  it('shrinks the damage the player takes, except for causes armor ignores', () => {
    const stats = new PlayerStats();
    let worn = 0;
    stats.armorPoints = 20;
    stats.armorToughness = 8;
    stats.onArmorHit = (w) => { worn += w; };
    expect(stats.damage(10, 'mob', 'survival')).toBe(true);
    expect(stats.health).toBeCloseTo(20 - reduceDamage(10, 20, 8), 5);
    expect(worn).toBe(armorWear(10));
    stats.reset();
    worn = 0;
    stats.damage(5, 'fall', 'survival');
    expect(stats.health).toBe(15);
    expect(worn).toBe(0);
    expect(ARMOR_CAUSES.has('fall')).toBe(false);
    expect(ARMOR_CAUSES.has('arrow')).toBe(true);
  });
});

describe('tool uses', () => {
  const air = BLOCK.AIR;
  it('hoe tills, shovel makes paths, axe strips', () => {
    expect(toolUse('hoe', BLOCK.GRASS, air)?.to).toBe(CUBE_ID.farmland);
    expect(toolUse('hoe', BLOCK.DIRT, air)?.to).toBe(CUBE_ID.farmland);
    expect(toolUse('hoe', CUBE_ID.coarse_dirt, air)?.to).toBe(BLOCK.DIRT);
    expect(toolUse('hoe', BLOCK.STONE, air)).toBeNull();
    expect(toolUse('hoe', BLOCK.GRASS, BLOCK.STONE)).toBeNull();
    expect(toolUse('shovel', BLOCK.GRASS, air)?.to).toBe(CUBE_ID.dirt_path);
    expect(toolUse('shovel', CUBE_ID.podzol, air)?.to).toBe(CUBE_ID.dirt_path);
    expect(toolUse('shovel', BLOCK.GRASS, BLOCK.STONE)).toBeNull();
    expect(toolUse('axe', BLOCK.OAK_LOG, BLOCK.STONE)?.to).toBe(CUBE_ID.stripped_oak_log);
    expect(toolUse('axe', CUBE_ID.cherry_log, air)?.to).toBe(CUBE_ID.stripped_cherry_log);
    expect(toolUse('axe', BLOCK.OAK_PLANKS, air)).toBeNull();
    expect(toolUse('shears', CUBE_ID.pumpkin, air)?.to).toBe(CUBE_ID.carved_pumpkin);
    expect(toolUse('pickaxe', BLOCK.GRASS, air)).toBeNull();
  });

  it('has the Java 1.21 damage and durability numbers', () => {
    const t = (name: string) => getItemDef(itemId(name))!.tool!;
    expect(t('wooden_sword').damage).toBe(4);
    expect(t('stone_sword').damage).toBe(5);
    expect(t('iron_sword').damage).toBe(6);
    expect(t('diamond_sword').damage).toBe(7);
    expect(t('golden_sword').damage).toBe(4);
    expect(t('wooden_axe').damage).toBe(7);
    expect(t('iron_axe').damage).toBe(9);
    expect(t('diamond_axe').damage).toBe(9);
    expect(t('diamond_pickaxe').damage).toBe(5);
    expect(t('stone_shovel').damage).toBe(3.5);
    expect(t('diamond_hoe').damage).toBe(1);
    expect(t('golden_pickaxe')).toMatchObject({ speed: 12, durability: 32, tier: 0 });
    expect(t('diamond_pickaxe')).toMatchObject({ speed: 8, durability: 1561, tier: 3 });
    expect(t('shears')).toMatchObject({ kind: 'shears', durability: 238 });
  });
});

describe('box shapes', () => {
  it('know their kind and which are tall', () => {
    expect(BOX_KIND[BLOCK.FENCE]).toBe(BOX_FENCE);
    expect(TALL[BLOCK.FENCE]).toBe(1);
    expect(TALL[BLOCK.WALL]).toBe(1);
    expect(TALL[BLOCK.CARPET]).toBe(0);
  });

  it('connect fences, walls and panes to solid neighbours and their own kind', () => {
    const w = new StateWorld();
    w.put(0, 64, 0, BLOCK.FENCE);
    expect(connectMask(BOX_FENCE, w.get, w.meta, 0, 64, 0)).toBe(0);
    w.put(1, 64, 0, BLOCK.FENCE);
    w.put(0, 64, -1, BLOCK.STONE);
    w.put(-1, 64, 0, BLOCK.GLASS);
    expect(connectMask(BOX_FENCE, w.get, w.meta, 0, 64, 0)).toBe(SIDE_BIT[0] | SIDE_BIT[3]);
    // A gate connects only along its panel.
    w.put(0, 64, 1, BLOCK.FENCE_GATE, NORTH);
    expect(connectMask(BOX_FENCE, w.get, w.meta, 0, 64, 0) & SIDE_BIT[1]).toBe(0);
    w.put(0, 64, 1, BLOCK.FENCE_GATE, EAST);
    expect(connectMask(BOX_FENCE, w.get, w.meta, 0, 64, 0) & SIDE_BIT[1]).toBe(SIDE_BIT[1]);
    // Panes do not join fences.
    w.put(5, 64, 5, BLOCK.GLASS_PANE);
    w.put(6, 64, 5, BLOCK.FENCE);
    expect(connectMask(BOX_PANE, w.get, w.meta, 5, 64, 5)).toBe(0);
    w.put(4, 64, 5, BLOCK.IRON_BARS);
    expect(connectMask(BOX_PANE, w.get, w.meta, 5, 64, 5)).toBe(SIDE_BIT[2]);
  });

  it('collide 1.5 blocks high and the physics sees it', () => {
    const out = new Float64Array(64);
    const n = boxCollision(BOX_FENCE, 0, 0, out);
    expect(n).toBe(1);
    expect(out[4]).toBe(1.5);
    const wall = boxCollision(BOX_WALL, 0, SIDE_BIT[0] | SIDE_BIT[1], out);
    expect(wall).toBe(3);
    // A player standing on a fence: moving down one block from 1.4 above the fence's cell stops at 1.5.
    const w = new StateWorld();
    w.put(0, 64, 0, BLOCK.FENCE);
    const box = { minX: 0.2, maxX: 0.8, minZ: 0.2, maxZ: 0.8, minY: 66.0, maxY: 67.8 };
    const dy = clipAxis(box, 1, -2, w.get, w.meta);
    expect(dy).toBeCloseTo(-0.5, 5);
  });

  it('closed gates collide, open ones do not; trapdoors lie flat or stand', () => {
    const out = new Float64Array(64);
    expect(boxCollision(BOX_FENCE + 0, 0, 0, out)).toBeGreaterThan(0);
    const w = new StateWorld();
    w.put(0, 64, 0, BLOCK.FENCE_GATE, 0);
    expect(collisionBoxes(BLOCK.FENCE_GATE, 0, w.get, w.meta, 0, 64, 0, out)).toBe(1);
    w.put(0, 64, 0, BLOCK.FENCE_GATE, 4);
    expect(collisionBoxes(BLOCK.FENCE_GATE, 4, w.get, w.meta, 0, 64, 0, out)).toBe(0);
    collisionBoxes(BLOCK.TRAPDOOR, 0, w.get, w.meta, 0, 64, 0, out);
    expect(out[4]).toBeCloseTo(3 / 16, 5);
    collisionBoxes(BLOCK.TRAPDOOR, 4, w.get, w.meta, 0, 64, 0, out); // top half
    expect(out[1]).toBeCloseTo(13 / 16, 5);
    collisionBoxes(BLOCK.TRAPDOOR, 8 | NORTH, w.get, w.meta, 0, 64, 0, out); // open against the north side
    expect(out[5]).toBeCloseTo(3 / 16, 5);
  });

  it('draw fences with an arm per connection', () => {
    const out = new Float64Array(64);
    expect(visualBoxes(BOX_FENCE, 0, 0, out)).toBe(1);
    expect(visualBoxes(BOX_FENCE, 0, 15, out)).toBe(1 + 4 * 2);
    expect(visualBoxes(BOX_PANE, 0, 15, out)).toBe(5);
  });

  it('place beds in two blocks and ladders on walls', () => {
    const w = new StateWorld();
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, BLOCK.STONE);
    const base = { id: BLOCK.BED, hitX: 0, hitY: 63, hitZ: 0, nx: 0, ny: 1, nz: 0, fracY: 1, yaw: 0, getBlock: w.get, getMeta: w.meta };
    const bed = resolvePlacement(base)!;
    expect(bed.meta & 3).toBe(NORTH);
    expect(bed.upper).toBeDefined();
    expect(bed.upper!.z).toBe(bed.z - 1);
    expect(bed.upper!.meta & 4).toBe(4);
    expect(bedPartner(bed.x, bed.z, bed.meta)).toEqual({ x: bed.upper!.x, z: bed.upper!.z });
    expect(bedPartner(bed.upper!.x, bed.upper!.z, bed.upper!.meta)).toEqual({ x: bed.x, z: bed.z });
    expect(BOX_KIND[BLOCK.BED]).toBe(BOX_BED);
    // No bed over a gap.
    w.set(0, 63, -1, BLOCK.AIR);
    expect(resolvePlacement(base)).toBeNull();

    w.set(2, 64, 2, BLOCK.STONE);
    const ladder = resolvePlacement({ ...base, id: BLOCK.LADDER, hitX: 2, hitY: 64, hitZ: 2, nx: 0, ny: 0, nz: 1 })!;
    expect(ladder).toMatchObject({ x: 2, y: 64, z: 3, meta: NORTH });
    expect(ladderSide(1, 0)).toBe(WEST);
    expect(ladderSide(-1, 0)).toBe(EAST);
    expect(ladderSide(0, -1)).toBe(SOUTH);
    expect(resolvePlacement({ ...base, id: BLOCK.LADDER, hitX: 2, hitY: 64, hitZ: 2, nx: 0, ny: 1, nz: 0 })).toBeNull();
  });

  it('validates the state of the new blocks', () => {
    expect(isValidMeta(BLOCK.TRAPDOOR, 0xff)).toBe(true);
    expect(isValidMeta(BLOCK.LADDER, 3)).toBe(true);
    expect(isValidMeta(BLOCK.LADDER, 4)).toBe(false);
    expect(isValidMeta(BLOCK.FENCE, 7)).toBe(true);
    expect(isValidMeta(BLOCK.SLAB_X, (23 << 2) | 2)).toBe(true);
    expect(isValidMeta(BLOCK.SLAB_X, 3)).toBe(false);
  });

  it('are meshed without crashing, with tint for dyed blocks', () => {
    const mesher = new ChunkMesher();
    const chunks = Array.from({ length: 9 }, () => emptyChunk());
    const metas = Array.from({ length: 9 }, () => null as Uint8Array | null);
    const centre = chunks[4];
    const meta = new Uint8Array(centre.length);
    const put = (x: number, y: number, z: number, id: number, m = 0) => { setLocal(centre, x, y, z, id); meta[x | (z << 4) | (y << 8)] = m; };
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) setLocal(centre, x, 60, z, BLOCK.STONE);
    put(2, 61, 2, BLOCK.FENCE, 3);
    put(3, 61, 2, BLOCK.FENCE, 3);
    put(5, 61, 2, BLOCK.WALL, 2);
    put(7, 61, 2, BLOCK.GLASS_PANE);
    put(9, 61, 2, BLOCK.CARPET, 14);
    put(11, 61, 2, BLOCK.TRAPDOOR, 5 << 4);
    put(2, 61, 5, BLOCK.FENCE_GATE, 3 << 3);
    put(4, 61, 5, BLOCK.LADDER, 1);
    put(6, 61, 5, BLOCK.BED, (14 << 3) | 1);
    put(6, 61, 6, BLOCK.BED, (14 << 3) | 1 | 4);
    put(8, 61, 5, BLOCK.CHEST, 2);
    put(10, 61, 5, BLOCK.SAPLING, 3);
    put(12, 61, 5, BLOCK.WOOL, 11);
    put(13, 61, 5, BLOCK.DOOR, 3 << 5);
    put(14, 61, 5, BLOCK.SLAB_X, 6 << 2);
    put(14, 61, 7, BLOCK.STAIRS_X, 8 << 3);
    metas[4] = meta;
    const r = mesher.mesh(chunks, Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA)), true, metas);
    expect(r.cutout).not.toBeNull();
    expect(r.opaque).not.toBeNull();
    // Blue wool is tinted (0x3c44aa), plain stone is not.
    const tints = new Set<number>();
    for (let i = 0; i < r.opaque!.tint.length; i += 4) tints.add((r.opaque!.tint[i] << 16) | (r.opaque!.tint[i + 1] << 8) | r.opaque!.tint[i + 2]);
    expect(tints.has(0x3c44aa)).toBe(true);
    expect(tints.has(0xffffff)).toBe(true);
    const cut = new Set<number>();
    for (let i = 0; i < r.cutout!.tint.length; i += 4) cut.add((r.cutout!.tint[i] << 16) | (r.cutout!.tint[i + 1] << 8) | r.cutout!.tint[i + 2]);
    expect(cut.has(0xb02e26)).toBe(true); // red carpet
  });

  it('keeps the player on top of a wall', () => {
    const w = new StateWorld();
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, BLOCK.STONE);
    w.put(0, 64, 0, BLOCK.WALL);
    const p = new Player();
    p.setPosition(0.5, 66.2, 0.5);
    for (let i = 0; i < 90; i++) p.step({ forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false }, w.get, w.meta);
    expect(p.y).toBeGreaterThan(65.4);
    expect(p.onGround).toBe(true);
  });

  it('lets the player climb a ladder', () => {
    const w = new StateWorld();
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, BLOCK.STONE);
    for (let y = 64; y < 72; y++) { w.put(0, y, 0, BLOCK.LADDER, 0); w.set(0, y, -1, BLOCK.STONE); }
    const p = new Player();
    p.setPosition(0.5, 64, 0.5);
    for (let i = 0; i < 60; i++) p.step({ forward: 0, strafe: 0, jump: true, jumpPressed: false, sprint: false, descend: false }, w.get, w.meta);
    expect(p.y).toBeGreaterThan(66);
    const climbed = p.y;
    // Sneaking holds the position.
    for (let i = 0; i < 30; i++) p.step({ forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: true }, w.get, w.meta);
    expect(Math.abs(p.y - climbed)).toBeLessThan(0.1);
    // No fall damage from a long drop onto the ladder: fall distance stays 0.
    expect(p.fallDistance).toBe(0);
  });
});

describe('item variants of the new blocks', () => {
  it('name every wood and material', () => {
    expect(getItemDef(itemFromState(BLOCK.DOOR, 5 << 5))?.displayName).toBe('Dark Oak Door');
    expect(getItemDef(itemFromState(BLOCK.FENCE_GATE, 7 << 3))?.displayName).toBe('Cherry Fence Gate');
    expect(getItemDef(itemFromState(BLOCK.WALL, 11))?.displayName).toBe('Cobbled Deepslate Wall');
    expect(getItemDef(itemFromState(BLOCK.SLAB_X, 0))?.displayName).toBe('Granite Slab');
    expect(getItemDef(itemFromState(BLOCK.STAIRS_X, 23 << 3))?.displayName).toBe('Smooth Red Sandstone Stairs');
    expect(getItemDef(itemFromState(BLOCK.BED, 14 << 3))?.displayName).toBe('Red Bed');
    expect(getItemDef(itemFromState(BLOCK.SAPLING, 6))?.displayName).toBe('Cherry Sapling');
  });
});
