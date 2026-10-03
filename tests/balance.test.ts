import { describe, expect, it } from 'vitest';
import { PHYSICS, blockReach } from '../src/player/Physics';
import { type MoveInput, Player } from '../src/player/Player';
import { ITEM, blockDrop, getItemDef, itemFromState, itemId, miningWear } from '../src/items/ItemRegistry';
import { BLOCK } from '../src/world/BlockRegistry';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { explosionDamage, explosionDropChance } from '../src/entities/Explosion';
import { Mob, type MobEvents, SKELETON_SHOT_INTERVAL, followRange } from '../src/entities/Mob';
import { TestWorld } from './helpers';

/** Regression tests for the gameplay numbers checked against Minecraft Java 1.21 (docs/qa/BALANCE.md). */

const floor = new TestWorld().fill(-20, 63, -3, 30, 63, 3, BLOCK.STONE);

function move(over: Partial<MoveInput>): MoveInput {
  return { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false, ...over };
}

/** Ground speed in blocks/s after the player has settled (1 s of walking, then 1 s measured). */
function groundSpeed(input: MoveInput): number {
  const p = new Player();
  p.canFly = false;
  p.setPosition(-15.5, 64, 0.5);
  p.yaw = -Math.PI / 2; // facing +X
  for (let i = 0; i < 60; i++) p.step(input, floor.get);
  const x0 = p.x;
  for (let i = 0; i < 60; i++) p.step(input, floor.get);
  return p.x - x0;
}

describe('balance: stack sizes', () => {
  it('stacks beds (every colour) to 1, buckets and snowballs to 16, tools, armor and stew to 1', () => {
    for (let colour = 0; colour < 16; colour++) expect(getItemDef(itemFromState(BLOCK.BED, colour))?.maxStack).toBe(1);
    expect(getItemDef(ITEM.BUCKET)?.maxStack).toBe(16);
    expect(getItemDef(itemId('snowball'))?.maxStack).toBe(16);
    for (const name of ['diamond_pickaxe', 'iron_sword', 'bow', 'shears', 'iron_chestplate', 'mushroom_stew', 'water_bucket']) {
      expect(getItemDef(itemId(name))?.maxStack, name).toBe(1);
    }
    for (const name of ['stone', 'oak_planks', 'cooked_porkchop', 'arrow', 'torch']) expect(getItemDef(itemId(name))?.maxStack, name).toBe(64);
  });
});

describe('balance: mob drops', () => {
  it('cows drop 1-3 beef and 0-2 leather', () => {
    const leather = itemId('leather');
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const drops = MOB_TYPES.cow.drops(true);
      const beef = drops.find((s) => s.id === ITEM.BEEF)!;
      expect(beef.count).toBeGreaterThanOrEqual(1);
      expect(beef.count).toBeLessThanOrEqual(3);
      const l = drops.find((s) => s.id === leather)?.count ?? 0;
      expect(l).toBeLessThanOrEqual(2);
      seen.add(l);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});

function mobEvents(onShoot: () => void = () => {}): MobEvents {
  const none = (): void => {};
  return {
    attack: none, explode: none, shoot: onShoot, arrowHit: none, arrowImpact: none, tntExplode: none, killed: none, playerArrowHit: none, sound: none,
  };
}

describe('balance: mob AI', () => {
  it('uses Minecraft follow ranges: zombie 35, the other hostiles 16', () => {
    expect(followRange(MOB_TYPES.zombie)).toBe(35);
    for (const kind of ['skeleton', 'creeper', 'spider'] as const) expect(followRange(MOB_TYPES[kind]), kind).toBe(16);
  });

  it('a zombie 33 blocks away comes for the player', () => {
    const z = new Mob(MOB_TYPES.zombie);
    z.setPosition(-15.5, 64, 0.5);
    const target = { x: 17.5, y: 64, z: 0.5, attackable: true };
    for (let i = 0; i < 60; i++) z.tick(floor.get, target, mobEvents());
    expect(z.x).toBeGreaterThan(-12);
  });

  it('a skeleton shoots once every 3 seconds (40 ticks wait + 20 ticks draw)', () => {
    const s = new Mob(MOB_TYPES.skeleton);
    s.setPosition(0.5, 64, 0.5);
    const target = { x: 8.5, y: 64, z: 0.5, attackable: true };
    let shots = 0;
    for (let i = 0; i < 300; i++) s.tick(floor.get, target, mobEvents(() => shots++));
    expect(SKELETON_SHOT_INTERVAL).toBe(40);
    expect(shots).toBe(5); // ticks 20, 80, 140, 200, 260
  });
});

describe('balance: explosions', () => {
  it('deals floor(7 × power × (impact² + impact) + 1) to mobs and players alike', () => {
    expect(explosionDamage(0, 3)).toBe(43); // creeper point blank
    expect(explosionDamage(0, 4)).toBe(57); // TNT point blank
    expect(explosionDamage(3, 3)).toBe(Math.floor(7 * 3 * (0.25 + 0.5) + 1));
    expect(explosionDamage(6, 3)).toBe(0);
    expect(explosionDamage(8, 4)).toBe(0);
  });

  it('drops every block from TNT and 1/power from other explosions (Java 1.21)', () => {
    expect(explosionDropChance(4, true)).toBe(1);
    expect(explosionDropChance(3, false)).toBeCloseTo(1 / 3, 9);
  });
});

describe('balance: mining', () => {
  it('wears tools 1 per block, swords 2, and nothing on blocks that break instantly', () => {
    expect(miningWear(ITEM.IRON_PICKAXE, BLOCK.STONE)).toBe(1);
    expect(miningWear(ITEM.IRON_SWORD, BLOCK.DIRT)).toBe(2);
    expect(miningWear(ITEM.IRON_SHOVEL, BLOCK.TORCH)).toBe(0);
    expect(miningWear(ITEM.DIAMOND_AXE, BLOCK.TNT)).toBe(0);
    expect(miningWear(ITEM.DIAMOND_AXE, BLOCK.POPPY)).toBe(0);
    expect(miningWear(BLOCK.DIRT, BLOCK.STONE)).toBe(0);
  });

  it('dead bushes drop 0-2 sticks without shears', () => {
    const counts = new Set<number>();
    for (let i = 0; i < 300; i++) counts.add(blockDrop(BLOCK.DEAD_BUSH, 0)?.count ?? 0);
    expect([...counts].sort()).toEqual([0, 1, 2]);
  });

  it('keeps vanilla tool tiers: speed, durability and attack damage', () => {
    const tiers = [
      ['wooden', 2, 59], ['stone', 4, 131], ['iron', 6, 250], ['diamond', 8, 1561], ['golden', 12, 32],
    ] as const;
    for (const [t, speed, durability] of tiers) {
      const pick = getItemDef(itemId(`${t}_pickaxe`))!.tool!;
      expect(pick.speed, t).toBe(speed);
      expect(pick.durability, t).toBe(durability);
    }
    expect(['wooden', 'stone', 'iron', 'diamond', 'golden'].map((t) => getItemDef(itemId(`${t}_sword`))!.tool!.damage)).toEqual([4, 5, 6, 7, 4]);
    expect(['wooden', 'stone', 'iron', 'diamond', 'golden'].map((t) => getItemDef(itemId(`${t}_axe`))!.tool!.damage)).toEqual([7, 9, 9, 9, 7]);
  });
});

describe('balance: player', () => {
  it('reaches blocks 4.5 away in survival and 5 in creative (block_interaction_range)', () => {
    expect(blockReach(false)).toBe(4.5);
    expect(blockReach(true)).toBe(5);
    expect(PHYSICS.REACH).toBe(4.5);
  });

  it('walks 4.317, sprints 5.612 and sneaks 1.295 blocks/s', () => {
    expect(groundSpeed(move({ forward: 1 }))).toBeCloseTo(4.317, 1);
    expect(groundSpeed(move({ forward: 1, sprint: true }))).toBeCloseTo(5.612, 1);
    expect(groundSpeed(move({ forward: 1, descend: true }))).toBeCloseTo(1.295, 1);
  });

  it('cannot sprint while sneaking', () => {
    expect(groundSpeed(move({ forward: 1, descend: true, sprint: true }))).toBeCloseTo(1.295, 1);
  });

  it('jumps about 1.25 blocks high (jump_strength 0.42, gravity 0.08)', () => {
    const p = new Player();
    p.canFly = false;
    p.setPosition(0.5, 64, 0.5);
    p.step(move({}), floor.get);
    let top = p.y;
    p.step(move({ jump: true }), floor.get);
    for (let i = 0; i < 60; i++) {
      p.step(move({}), floor.get);
      top = Math.max(top, p.y);
    }
    expect(top - 64).toBeGreaterThan(1.2);
    expect(top - 64).toBeLessThan(1.3);
  });
});
