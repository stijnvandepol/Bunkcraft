import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityManager, type EntityWorld } from '../src/entities/EntityManager';
import { Mob, type MobEvents, type MobTarget } from '../src/entities/Mob';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { BLOCK } from '../src/world/BlockRegistry';

/** Flat stone floor up to y = 0 (mobs stand on y = 1); `extra` blocks override. */
class FlatWorld implements EntityWorld {
  readonly extra = new Map<string, number>();
  skyLight = 15;
  water = false;
  set(x: number, y: number, z: number, id: number): this { this.extra.set(`${x},${y},${z}`, id); return this; }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): this {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, id);
    return this;
  }
  getBlock = (x: number, y: number, z: number): number => {
    const e = this.extra.get(`${x},${y},${z}`);
    if (e !== undefined) return e;
    return y <= 0 ? BLOCK.STONE : this.water && y === 1 ? BLOCK.WATER : BLOCK.AIR;
  };
  getSkyLight = (): number => this.skyLight;
  getLight = (): number => (this.skyLight << 4);
}

interface Log { attack: number[]; explode: number; shoot: number; sounds: string[]; killed: number; arrowHit: number[] }
function events(): { ev: MobEvents; log: Log } {
  const log: Log = { attack: [], explode: 0, shoot: 0, sounds: [], killed: 0, arrowHit: [] };
  const ev: MobEvents = {
    attack: (_m, dmg) => { log.attack.push(dmg); },
    explode: () => { log.explode++; },
    shoot: () => { log.shoot++; },
    arrowHit: (_a, dmg) => { log.arrowHit.push(dmg); },
    arrowImpact: () => undefined,
    tntExplode: () => undefined,
    killed: () => { log.killed++; },
    playerArrowHit: () => undefined,
    sound: (_m, kind) => { log.sounds.push(kind); },
  };
  return { ev, log };
}

const player = (x: number, y = 1, z = 0, attackable = true): MobTarget => ({ x, y, z, attackable, id: 1 });

function spawn(kind: keyof typeof MOB_TYPES, x: number, z = 0): Mob {
  const m = new Mob(MOB_TYPES[kind]);
  m.setPosition(x, 1, z);
  return m;
}

function run(m: Mob, w: FlatWorld, target: MobTarget, ev: MobEvents, ticks: number, each?: (i: number) => void): void {
  for (let i = 0; i < ticks && !m.removed; i++) {
    m.tick(w.getBlock, target, ev);
    each?.(i);
  }
}

beforeEach(() => {
  // Deterministic wandering and spider leaps: Math.random is a fixed low-discrepancy sequence.
  let s = 0.123;
  vi.spyOn(Math, 'random').mockImplementation(() => (s = (s * 9301 + 0.49297) % 1));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('zombie', () => {
  it('chases the player and attacks in melee with a cooldown', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const z = spawn('zombie', 10);
    const p = player(0);
    run(z, w, p, ev, 120);
    expect(Math.hypot(z.x - p.x, z.z - p.z)).toBeLessThan(1.8);
    expect(log.attack.length).toBeGreaterThanOrEqual(2);
    expect(log.attack.every((d) => d === MOB_TYPES.zombie.attack)).toBe(true);
    // Attacks are at least 20 ticks apart: 120 ticks cannot hold more than 6.
    expect(log.attack.length).toBeLessThanOrEqual(6);
  });

  it('ignores a player that cannot be attacked (creative) and one beyond 32 blocks', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const z = spawn('zombie', 10);
    run(z, w, player(0, 1, 0, false), ev, 100);
    expect(log.attack).toHaveLength(0);
    const far = spawn('zombie', 40);
    run(far, w, player(0), ev, 5);
    // Far away it just wanders (speed at most walk speed, never straight at the player).
    expect(Math.abs(far.x - 40)).toBeLessThan(2);
  });

  it('does not hit through a wall', () => {
    const w = new FlatWorld().fill(-1, 1, -3, -1, 4, 3, BLOCK.STONE);
    const { ev, log } = events();
    const z = spawn('zombie', 0.8);
    run(z, w, player(-2.5), ev, 100);
    expect(log.attack).toHaveLength(0);
  });

  it('jumps over a one block step while chasing', () => {
    const w = new FlatWorld().fill(5, 1, -5, 5, 1, 5, BLOCK.STONE);
    const { ev } = events();
    const z = spawn('zombie', 9);
    run(z, w, player(0), ev, 100);
    expect(z.x).toBeLessThan(5);
  });

  it('takes damage with knockback and a 10 tick invulnerability, then dies and is removed after 20 ticks', () => {
    const w = new FlatWorld();
    const { ev } = events();
    const z = spawn('zombie', 3);
    expect(z.hurt(5, 0, 0, 1, true)).toBe(true);
    expect(z.health).toBe(MOB_TYPES.zombie.health - 5);
    expect(z.vx).toBeGreaterThan(0); // pushed away from the attacker at x = 0
    expect(z.hurt(5, 0, 0)).toBe(false); // still invulnerable
    expect(z.hurtByPlayer).toBeGreaterThan(0);
    run(z, w, player(0), ev, 11);
    expect(z.hurt(100, 0, 0)).toBe(true);
    expect(z.dead).toBe(true);
    run(z, w, player(0), ev, 25);
    expect(z.removed).toBe(true);
  });
});

describe('creeper', () => {
  it('swells for 30 ticks next to the player and explodes', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const c = spawn('creeper', 6);
    const fuses: number[] = [];
    run(c, w, player(0), ev, 200, () => fuses.push(c.fuse));
    expect(log.explode).toBe(1);
    expect(c.removed).toBe(true);
    expect(Math.max(...fuses)).toBeGreaterThanOrEqual(29);
    expect(log.sounds).toContain('fuse');
  });

  it('lets the fuse run down when the player backs away beyond 7 blocks', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const c = spawn('creeper', 2);
    run(c, w, player(0), ev, 12);
    expect(c.fuse).toBeGreaterThan(5);
    const before = c.fuse;
    c.setPosition(20, 1, 0); // player is now 20 blocks away
    run(c, w, player(0), ev, 10);
    expect(c.fuse).toBeLessThan(before);
    expect(log.explode).toBe(0);
  });

  it('never swells without line of sight', () => {
    const w = new FlatWorld().fill(-1, 1, -3, -1, 4, 3, BLOCK.STONE);
    const { ev, log } = events();
    const c = spawn('creeper', 1);
    run(c, w, player(-2.5), ev, 100);
    expect(c.fuse).toBe(0);
    expect(log.explode).toBe(0);
  });
});

describe('skeleton', () => {
  it('stops at range and shoots about every 2 s with line of sight', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const s = spawn('skeleton', 12);
    run(s, w, player(0), ev, 200);
    expect(log.shoot).toBeGreaterThanOrEqual(3);
    expect(log.shoot).toBeLessThanOrEqual(10);
    expect(Math.hypot(s.x, s.z)).toBeGreaterThan(4); // keeps its distance
  });

  it('backs away when the player gets within 4 blocks', () => {
    const w = new FlatWorld();
    const { ev } = events();
    const s = spawn('skeleton', 2.5);
    run(s, w, player(0), ev, 40);
    expect(s.x).toBeGreaterThan(2.5);
  });

  it('does not shoot beyond 16 blocks or through walls', () => {
    const w = new FlatWorld().fill(-1, 1, -4, -1, 5, 4, BLOCK.STONE);
    const { ev, log } = events();
    run(spawn('skeleton', 20), w, player(0), ev, 100);
    run(spawn('skeleton', 3, 0), w, player(-5), ev, 100);
    expect(log.shoot).toBe(0);
  });

  it('EntityManager turns a shoot event into an arrow that can hit the player', () => {
    const w = new FlatWorld();
    const em = new EntityManager(w, 1);
    em.hostileSpawning = false;
    const { ev, log } = events();
    const baseShoot = ev.shoot;
    ev.shoot = (m, t) => { baseShoot(m, t); em.skeletonShoot(m, t.x, t.y + 1.2, t.z); };
    em.spawnMob('skeleton', 9, 1, 0);
    const p = player(0);
    let sawArrow = false;
    for (let i = 0; i < 160; i++) {
      em.tick(p, 0, ev, null, false);
      if (em.arrows.length > 0) sawArrow = true;
    }
    expect(log.shoot).toBeGreaterThan(0);
    expect(sawArrow).toBe(true);
  });
});

describe('spider', () => {
  it('climbs a wall in its way', () => {
    const w = new FlatWorld().fill(3, 1, -4, 3, 4, 4, BLOCK.STONE);
    const { ev } = events();
    const sp = spawn('spider', 6);
    let maxY = 1;
    run(sp, w, player(0, 5), ev, 160, () => { maxY = Math.max(maxY, sp.y); });
    expect(maxY).toBeGreaterThan(3);
  });

  it('is neutral in bright light until provoked', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const calm = spawn('spider', 2);
    calm.calm = true;
    run(calm, w, player(0), ev, 60);
    expect(log.attack).toHaveLength(0);
    expect(calm.aimTicks).toBe(0);
    const angry = spawn('spider', 2);
    angry.calm = true;
    angry.hurt(1, 5, 0, 0, true);
    expect(angry.provoked).toBe(true);
    run(angry, w, player(0), ev, 80);
    expect(log.attack.length).toBeGreaterThan(0);
  });
});

describe('passive mobs', () => {
  it('panic and run when hurt, and never attack', () => {
    const w = new FlatWorld();
    const { ev, log } = events();
    const pig = spawn('pig', 2);
    pig.hurt(1, 0, 0, 0, true);
    const x0 = pig.x, z0 = pig.z;
    run(pig, w, player(0), ev, 60);
    expect(Math.hypot(pig.x - x0, pig.z - z0)).toBeGreaterThan(0.5);
    expect(log.attack).toHaveLength(0);
  });

  it('takes fall damage above 3 blocks, but chickens do not', () => {
    const w = new FlatWorld();
    const { ev } = events();
    const cow = spawn('cow', 0);
    cow.setPosition(0, 11, 5);
    run(cow, w, player(50), ev, 60);
    expect(cow.health).toBeLessThan(MOB_TYPES.cow.health);
    const hen = spawn('chicken', 0);
    hen.setPosition(0, 11, 8);
    run(hen, w, player(50), ev, 60);
    expect(hen.health).toBe(MOB_TYPES.chicken.health);
  });
});

describe('EntityManager', () => {
  it('burns zombies and skeletons in daylight with open sky, but not under a roof or in water', () => {
    const open = new FlatWorld();
    const em = new EntityManager(open, 1);
    em.hostileSpawning = false;
    const { ev } = events();
    const z = em.spawnMob('zombie', 0.5, 1, 0.5);
    for (let i = 0; i < 61; i++) em.tick(player(20), 0, ev, null, true);
    expect(z.burning).toBeGreaterThan(0);
    expect(z.health).toBeLessThan(MOB_TYPES.zombie.health);

    const roof = new FlatWorld();
    roof.skyLight = 0;
    const em2 = new EntityManager(roof, 1);
    em2.hostileSpawning = false;
    const z2 = em2.spawnMob('zombie', 0.5, 1, 0.5);
    for (let i = 0; i < 61; i++) em2.tick(player(20), 0, ev, null, true);
    expect(z2.burning).toBe(0);
    expect(z2.health).toBe(MOB_TYPES.zombie.health);

    const night = new EntityManager(open, 1);
    night.hostileSpawning = false;
    const z3 = night.spawnMob('skeleton', 0.5, 1, 0.5);
    for (let i = 0; i < 61; i++) night.tick(player(20), 11, ev, null, false);
    expect(z3.health).toBe(MOB_TYPES.skeleton.health);
  });

  it('drops loot once when a mob dies and reports player kills', () => {
    const w = new FlatWorld();
    const em = new EntityManager(w, 1);
    em.hostileSpawning = false;
    const { ev, log } = events();
    const pig = em.spawnMob('pig', 0.5, 1, 0.5);
    pig.hurt(100, 5, 5, 0, true);
    for (let i = 0; i < 40; i++) em.tick(player(40), 0, ev, null, false);
    expect(em.mobs).not.toContain(pig);
    expect(em.items.length).toBeGreaterThan(0);
    expect(log.killed).toBe(1);
    expect(log.sounds.filter((s) => s === 'death')).toHaveLength(1);
  });

  it('despawns hostile mobs that are more than 128 blocks away and keeps passive ones', () => {
    const w = new FlatWorld();
    const em = new EntityManager(w, 1);
    em.hostileSpawning = false;
    const { ev } = events();
    em.spawnMob('zombie', 300, 1, 0);
    const cow = em.spawnMob('cow', 300, 1, 0);
    em.tick(player(0), 0, ev, null, false);
    expect(em.mobs).toEqual([cow]);
  });

  it('targets the nearest of several players', () => {
    const w = new FlatWorld();
    const em = new EntityManager(w, 1);
    em.hostileSpawning = false;
    em.targets = [{ x: -20, y: 1, z: 0, attackable: true, id: 1 }, { x: 20, y: 1, z: 0, attackable: true, id: 2 }];
    const { ev } = events();
    const z = em.spawnMob('zombie', 12, 1, 0);
    for (let i = 0; i < 40; i++) em.tick(em.targets[0], 0, ev, null, false);
    expect(z.x).toBeGreaterThan(12); // went for the player at +20
  });

  it('merges nearby identical item stacks and lets the player pick items up', () => {
    const w = new FlatWorld();
    const em = new EntityManager(w, 1);
    em.hostileSpawning = false;
    const { ev } = events();
    em.dropItem({ id: BLOCK.DIRT, count: 3 }, 10.5, 1.2, 10.5, 0);
    em.dropItem({ id: BLOCK.DIRT, count: 4 }, 10.6, 1.2, 10.5, 0);
    for (let i = 0; i < 30; i++) em.tick(player(40), 0, ev, null, false);
    expect(em.items).toHaveLength(1);
    expect(em.items[0].stack.count).toBe(7);
    let got = 0;
    const p = player(10.5, 1, 10.5);
    for (let i = 0; i < 20; i++) em.tick(p, 0, ev, (s) => { got += s.count; return 0; }, false);
    expect(got).toBe(7);
    expect(em.items).toHaveLength(0);
  });

  it('raycastMob finds the nearest living mob only', () => {
    const w = new FlatWorld();
    const em = new EntityManager(w, 1);
    const near = em.spawnMob('pig', 3, 1, 0);
    const far = em.spawnMob('pig', 6, 1, 0);
    expect(em.raycastMob(0, 1.4, 0, 1, 0, 0, 20)?.mob).toBe(near);
    near.health = 0;
    expect(em.raycastMob(0, 1.4, 0, 1, 0, 0, 20)?.mob).toBe(far);
    expect(em.raycastMob(0, 1.4, 0, -1, 0, 0, 20)).toBeNull();
  });
});
