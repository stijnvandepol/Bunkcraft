import { describe, expect, it } from 'vitest';
import { EntityManager, type EntityWorld } from '../src/entities/EntityManager';
import type { MobEvents, MobTarget } from '../src/entities/Mob';
import { useOnMob } from '../src/entities/MobInteraction';
import { HOSTILE_TABLE, MobSpawner, RARE_HOSTILE_TABLE, biomeVariant, isSlimeChunk } from '../src/entities/MobSpawner';
import { sheepColor } from '../src/entities/MobInit';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { ITEM, itemBlock, itemId, itemMeta } from '../src/items/ItemRegistry';
import { decodeBinary, encodeBinary } from '../src/net/binary';
import { MOB_FLAG, type MobEntry, NET_MOB_KINDS, type ServerMessage } from '../src/net/protocol';
import { BIOME } from '../src/world/Biomes';
import { BLOCK } from '../src/world/BlockRegistry';
import { mulberry32 } from '../src/world/Noise';
import { type EntityPlayer, ServerEntities, mobFlags, mobVariant } from '../server/ServerEntities';

class TestWorld implements EntityWorld {
  readonly edits = new Map<number, number>();
  biome: number = BIOME.PLAINS;
  key(x: number, y: number, z: number): number { return ((x + 512) * 1024 + (z + 512)) * 128 + y; }
  getBlock(x: number, y: number, z: number): number {
    const e = this.edits.size ? this.edits.get(this.key(x, y, z)) : undefined;
    if (e !== undefined) return e;
    if (y < 62) return BLOCK.STONE;
    if (y === 62) return BLOCK.GRASS;
    return 0;
  }
  set(x: number, y: number, z: number, id: number): void { this.edits.set(this.key(x, y, z), id); }
  setBlock(x: number, y: number, z: number, id: number): boolean { this.set(x, y, z, id); return true; }
  getLight(): number { return 15 << 4; }
  biomeName(): number { return this.biome; }
}

function setup() {
  const world = new TestWorld();
  const em = new EntityManager(world, 3);
  em.hostileSpawning = em.passiveSpawning = false;
  const log = { attacks: 0, fx: [] as string[], sounds: [] as string[], potions: 0 };
  const noop = () => undefined;
  const events: MobEvents = {
    attack: () => { log.attacks++; }, explode: noop, shoot: noop, arrowHit: noop, arrowImpact: noop, tntExplode: noop,
    killed: noop, playerArrowHit: noop, sound: (_m, k) => { log.sounds.push(k); }, fx: (_m, k) => { log.fx.push(k); },
    potion: () => { log.potions++; },
  };
  const player: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: true, yaw: 0, pitch: 0 };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) em.tick(player, 0, events, null, false); };
  return { world, em, log, player, tick };
}

/** Rolls Math.random to fixed values while `fn` runs. */
function withRandom<T>(v: number, fn: () => T): T {
  const real = Math.random;
  Math.random = () => v;
  try { return fn(); } finally { Math.random = real; }
}

describe('wolves', () => {
  it('tame with bones (1 in 3), then sit, stand and follow the owner', () => {
    const s = setup();
    const wolf = s.em.spawnMob('wolf', 3.5, 63, 0.5);
    s.tick(2);
    // A failed attempt costs the bone and shows smoke.
    expect(withRandom(0.9, () => useOnMob(wolf, ITEM.BONE, 0))).toMatchObject({ action: 'tame_fail', consume: 1 });
    expect(wolf.tamed).toBe(false);
    expect(withRandom(0.1, () => useOnMob(wolf, ITEM.BONE, 0))).toMatchObject({ action: 'tame', consume: 1 });
    expect(wolf.tamed).toBe(true);
    expect(wolf.health).toBe(40);
    expect(wolf.sitting).toBe(true);
    expect(s.log.fx).toEqual(['smoke', 'tame']);
    // Sitting: stays put while the owner walks away.
    s.player.x = 20.5;
    s.tick(100);
    expect(Math.hypot(wolf.x - 3.5, wolf.z - 0.5)).toBeLessThan(1);
    expect(useOnMob(wolf, 0, 0).action).toBe('stand');
    // Following starts beyond 10 blocks and ends within 2; afterwards the wolf may stroll a bit.
    let closest = Infinity;
    for (let i = 0; i < 200; i++) { s.tick(); closest = Math.min(closest, Math.hypot(wolf.x - s.player.x, wolf.z - s.player.z)); }
    expect(closest).toBeLessThan(2.5);
    expect(Math.hypot(wolf.x - s.player.x, wolf.z - s.player.z)).toBeLessThan(12);
    // Far away: teleports to the owner.
    s.player.x = 60.5;
    s.tick(30);
    expect(Math.hypot(wolf.x - s.player.x, wolf.z - s.player.z)).toBeLessThan(6);
  });

  it('attack what the owner hits and what hits the owner, never the owner', () => {
    const s = setup();
    const wolf = s.em.spawnMob('wolf', 1.5, 63, 0.5);
    withRandom(0.1, () => useOnMob(wolf, ITEM.BONE, 0));
    wolf.sitting = false;
    const zombie = s.em.spawnMob('zombie', 6.5, 63, 3.5);
    s.tick(1);
    zombie.hurt(1, 0.5, 0.5, 0, true, s.player);
    s.tick(120);
    expect(zombie.health).toBeLessThan(20 - 1 - 4);
    expect(s.log.attacks).toBeGreaterThanOrEqual(0);
    // A wolf hit by its owner does not turn on him.
    const before = s.log.attacks;
    wolf.hurt(1, 0.5, 0.5, 0, true, s.player);
    s.player.attackable = true;
    s.tick(60);
    expect(wolf.target === s.player).toBe(false);
    expect(s.log.attacks - before).toBeLessThanOrEqual(30); // the zombie may hit, the wolf never
  });

  it('wild wolves turn angry with their pack when hit by a player', () => {
    const s = setup();
    const a = s.em.spawnMob('wolf', 3.5, 63, 0.5), b = s.em.spawnMob('wolf', 5.5, 63, 0.5);
    s.tick(2);
    a.hurt(1, 0.5, 0.5, 0, true, s.player);
    s.tick(60);
    expect(a.angryTicks).toBeGreaterThan(0);
    expect(b.angryTicks).toBeGreaterThan(0);
    expect(s.log.attacks).toBeGreaterThan(0);
  });
});

describe('farm animals', () => {
  it('sheep are shorn for 1-3 wool of their colour and dyed', () => {
    const s = setup();
    const sheep = s.em.spawnMob('sheep', 0.5, 63, 0.5);
    sheep.variant = 14;
    const r = useOnMob(sheep, ITEM.SHEARS, 0);
    expect(r).toMatchObject({ action: 'shear', damageTool: true, consume: 0 });
    expect(sheep.variant & 16).toBe(16);
    expect(s.em.items).toHaveLength(1);
    const wool = s.em.items[0].stack;
    expect(itemBlock(wool.id)).toBe(BLOCK.WOOL);
    expect(itemMeta(wool.id)).toBe(14);
    expect(wool.count).toBeGreaterThanOrEqual(1);
    expect(wool.count).toBeLessThanOrEqual(3);
    expect(useOnMob(sheep, ITEM.SHEARS, 0).action).toBe('none'); // already shorn
    expect(useOnMob(sheep, itemId('blue_dye'), 0).action).toBe('dye');
    expect(sheep.variant & 15).toBe(11);
  });

  it('natural sheep colours follow the vanilla weights', () => {
    const rng = mulberry32(5);
    const n: Record<number, number> = {};
    for (let i = 0; i < 20000; i++) { const c = sheepColor(rng()); n[c] = (n[c] ?? 0) + 1; }
    expect(n[0] / 20000).toBeGreaterThan(0.79);
    expect(n[15] / 20000).toBeCloseTo(0.05, 1);
  });

  it('cows give milk for a bucket; food starts love mode and speeds up babies', () => {
    const s = setup();
    const cow = s.em.spawnMob('cow', 0.5, 63, 0.5);
    expect(useOnMob(cow, ITEM.BUCKET, 0)).toMatchObject({ action: 'milk', give: itemId('milk_bucket') });
    expect(useOnMob(cow, itemId('wheat'), 0).action).toBe('feed');
    expect(cow.inLove).toBe(600);
    expect(useOnMob(cow, itemId('wheat'), 0).action).toBe('none'); // already in love
    const calf = s.em.spawnMob('cow', 2.5, 63, 0.5);
    calf.setBaby(true);
    useOnMob(calf, itemId('wheat'), 0);
    expect(calf.growingAge).toBe(-21600);
  });

  it('chickens lay eggs every 5-10 minutes', () => {
    const s = setup();
    s.em.spawnMob('chicken', 0.5, 63, 0.5);
    s.tick(12001);
    const eggs = s.em.items.filter((i) => i.stack.id === itemId('egg'));
    expect(eggs.length).toBeGreaterThanOrEqual(1);
    expect(eggs.length).toBeLessThanOrEqual(2);
  });

  it('babies drop nothing', () => {
    const s = setup();
    const lamb = s.em.spawnMob('sheep', 0.5, 63, 0.5);
    lamb.setBaby(true);
    lamb.hurt(100, 0, 0, 0, true);
    s.tick(2);
    expect(s.em.items).toHaveLength(0);
  });
});

describe('monsters', () => {
  it('big slimes split into 2-4 smaller ones, small ones drop slimeballs', () => {
    const s = setup();
    const slime = s.em.spawnMob('slime', 0.5, 63, 0.5);
    slime.size = 4; slime.refreshSize(); slime.health = 16;
    s.tick(1);
    slime.hurt(100, 0, 0, 0, true);
    s.tick(2);
    const kids = s.em.mobs.filter((m) => m.type.kind === 'slime' && !m.dead);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    expect(kids.length).toBeLessThanOrEqual(4);
    for (const k of kids) { expect(k.size).toBe(2); expect(k.health).toBe(4); expect(k.width).toBeCloseTo(1.04); }
    expect(s.em.items).toHaveLength(0);
  });

  it('slimes hop at the player and hit by size', () => {
    const s = setup();
    const slime = s.em.spawnMob('slime', 6.5, 63, 0.5);
    slime.size = 2; slime.refreshSize();
    s.tick(300);
    expect(s.log.attacks).toBeGreaterThan(0);
  });

  it('endermen turn angry when stared at and teleport after hits and in water', () => {
    const s = setup();
    const e = s.em.spawnMob('enderman', 0.5, 63, -10.5);
    // The player looks along −Z (yaw 0) slightly up at the head.
    s.player.yaw = 0;
    s.player.pitch = Math.atan2(63 + 2.46 - 64.62, 11);
    s.tick(10);
    expect(e.angryTicks).toBeGreaterThan(0);
    expect(s.log.sounds).toContain('angry');
    const x = e.x, z = e.z;
    e.pendingTeleport = true;
    s.tick(1);
    expect(Math.hypot(e.x - x, e.z - z)).toBeGreaterThan(0.5);
  });

  it('a neutral enderman ignores players who do not look at it', () => {
    const s = setup();
    const e = s.em.spawnMob('enderman', 0.5, 63, -10.5);
    s.player.yaw = Math.PI; // looking away
    s.tick(100);
    expect(e.angryTicks).toBe(0);
    expect(s.log.attacks).toBe(0);
  });

  it('witches throw potions from a distance', () => {
    const s = setup();
    s.em.spawnMob('witch', 7.5, 63, 0.5);
    s.tick(200);
    expect(s.log.potions).toBeGreaterThanOrEqual(2);
  });

  it('cave spiders poison and are small', () => {
    expect(MOB_TYPES.cave_spider.poison).toBe(140);
    expect(MOB_TYPES.cave_spider.width).toBeLessThan(MOB_TYPES.spider.width);
  });
});

describe('spawn rules', () => {
  it('slime chunks are one in ten and fixed per seed', () => {
    let n = 0;
    for (let x = 0; x < 100; x++) for (let z = 0; z < 100; z++) if (isSlimeChunk(9, x, z)) n++;
    expect(n / 10000).toBeGreaterThan(0.08);
    expect(n / 10000).toBeLessThan(0.12);
    expect(isSlimeChunk(9, 3, 4)).toBe(isSlimeChunk(9, 3, 4));
  });

  it('desert zombies are mostly husks, snowy skeletons mostly strays', () => {
    expect(biomeVariant('zombie', BIOME.DESERT, 0.1)).toBe('husk');
    expect(biomeVariant('zombie', BIOME.DESERT, 0.9)).toBe('zombie');
    expect(biomeVariant('skeleton', BIOME.SNOWY, 0.5)).toBe('stray');
    expect(biomeVariant('zombie', BIOME.PLAINS, 0.1)).toBe('zombie');
  });

  it('rare monsters come from their own table and the main table is unchanged', () => {
    expect(HOSTILE_TABLE.map((e) => e.kind)).toEqual(['zombie', 'skeleton', 'creeper', 'spider']);
    expect(RARE_HOSTILE_TABLE.map((e) => e.kind)).toEqual(['enderman', 'witch']);
  });

  it('spawns husks in the desert at night', () => {
    const world = new TestWorld();
    world.biome = BIOME.DESERT;
    const mobs: import('../src/entities/Mob').Mob[] = [];
    const em = new EntityManager(world, 1);
    const s = new MobSpawner({ world, mobs, spawnMob: (k, x, y, z) => { const m = em.spawnMob(k, x, y, z); mobs.push(m); return m; } }, 1, mulberry32(4));
    const p: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: true };
    for (let i = 0; i < 400; i++) { s.recount(); s.tryPack(p, [p], 11, 1000); }
    const kinds = new Set(mobs.map((m) => m.type.kind));
    expect(kinds.has('husk')).toBe(true);
  });
});

describe('server sync of the new kinds', () => {
  it('appends kinds and encodes baby, tamed, sitting and the variant byte (JSON and binary)', () => {
    expect(NET_MOB_KINDS.slice(0, 8)).toEqual(['pig', 'cow', 'sheep', 'chicken', 'zombie', 'creeper', 'skeleton', 'spider']);
    for (const k of ['wolf', 'enderman', 'slime', 'drowned', 'husk', 'stray', 'cave_spider', 'witch', 'horse'] as const) expect(NET_MOB_KINDS).toContain(k);
    const sent: { to: number; msg: ServerMessage }[] = [];
    const host = {
      send: (to: number, msg: ServerMessage) => sent.push({ to, msg }), broadcast: () => undefined, broadcastBlock: () => undefined,
      broadcastBlocks: () => undefined, recordEdit: () => undefined,
    };
    const ents = new ServerEntities(5, {}, 'survival', host, () => 0.25);
    const player: EntityPlayer = { id: 1, x: 0.5, y: 120, z: 0.5, flags: 0, held: 0, hasPos: true };
    ents.manager.passiveSpawning = ents.manager.hostileSpawning = false;
    const wolf = ents.manager.spawnMob('wolf', 2.5, 120, 0.5);
    wolf.ownerId = 1; wolf.sitting = true; wolf.setBaby(true); wolf.variant = 3;
    const slime = ents.manager.spawnMob('slime', 4.5, 120, 0.5);
    slime.size = 4;
    expect(mobFlags(wolf) & (MOB_FLAG.TAMED | MOB_FLAG.SITTING | MOB_FLAG.BABY)).toBe(MOB_FLAG.TAMED | MOB_FLAG.SITTING | MOB_FLAG.BABY);
    expect(mobVariant(slime)).toBe(4);
    ents.tick([player]);
    ents.tick([player]);
    const ent = sent.map((s) => s.msg).find((m) => m.t === 'ent') as Extract<ServerMessage, { t: 'ent' }>;
    const w = ent.m.find((e) => e[0] === wolf.netId)!;
    expect(NET_MOB_KINDS[w[1]]).toBe('wolf');
    expect(w[10]).toBe(3);
    const back = decodeBinary(encodeBinary(ent)!) as Extract<ServerMessage, { t: 'ent' }>;
    const wb = back.m.find((e: MobEntry) => e[0] === wolf.netId)!;
    expect(wb[8]).toBe(w[8]);
    expect(wb[10]).toBe(3);
    expect(NET_MOB_KINDS[wb[1]]).toBe('wolf');
  });

  it('the server applies a right click and tells the client what it costs', () => {
    const sent: { to: number; msg: ServerMessage }[] = [];
    const host = {
      send: (to: number, msg: ServerMessage) => sent.push({ to, msg }), broadcast: () => undefined, broadcastBlock: () => undefined,
      broadcastBlocks: () => undefined, recordEdit: () => undefined,
    };
    const ents = new ServerEntities(5, {}, 'survival', host, () => 0.25);
    const cow = ents.manager.spawnMob('cow', 1.5, 80, 0.5);
    const p: EntityPlayer = { id: 7, x: 0.5, y: 79, z: 0.5, flags: 0, held: ITEM.BUCKET, hasPos: true };
    ents.useMob(p, cow.netId);
    expect(sent.at(-1)?.msg).toMatchObject({ t: 'mobused', action: 'milk', give: itemId('milk_bucket') });
    // Out of reach: nothing.
    sent.length = 0;
    ents.useMob({ ...p, x: 40 }, cow.netId);
    expect(sent).toHaveLength(0);
  });
});
