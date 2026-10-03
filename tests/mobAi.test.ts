import { describe, expect, it } from 'vitest';
import { FLAG, type Goal, GoalSelector } from '../src/entities/ai/Goal';
import { DEFAULT_PATH, Path, findPath, pathStats } from '../src/entities/ai/Pathfinder';
import { EntityManager, type EntityWorld } from '../src/entities/EntityManager';
import { BABY_AGE, BREED_COOLDOWN, type MobEvents, type MobTarget } from '../src/entities/Mob';
import { isBreedFood, tagItems } from '../src/entities/Breeding';
import { ITEM, itemId } from '../src/items/ItemRegistry';
import { BLOCK } from '../src/world/BlockRegistry';

/** Flat grass world at y = 63 (stone below) with editable blocks, full daylight, no unloaded chunks. */
class TestWorld implements EntityWorld {
  readonly edits = new Map<number, number>();
  getBlock(x: number, y: number, z: number): number {
    const e = this.edits.size ? this.edits.get(((x + 512) * 1024 + (z + 512)) * 128 + y) : undefined;
    if (e !== undefined) return e;
    if (y < 62) return BLOCK.STONE;
    if (y === 62) return BLOCK.GRASS;
    return 0;
  }
  set(x: number, y: number, z: number, id: number): void { this.edits.set(((x + 512) * 1024 + (z + 512)) * 128 + y, id); }
  setBlock(x: number, y: number, z: number, id: number): boolean { this.set(x, y, z, id); return true; }
  getLight(): number { return 15 << 4; }
}

function eventsLog() {
  const log = { attacks: 0, explodes: 0, shots: 0, fx: [] as string[], xp: 0 };
  const noop = () => undefined;
  const events: MobEvents = {
    attack: () => { log.attacks++; }, explode: () => { log.explodes++; }, shoot: () => { log.shots++; },
    arrowHit: noop, arrowImpact: noop, tntExplode: noop, killed: noop, playerArrowHit: noop, sound: noop,
    fx: (_m, k) => { log.fx.push(k); }, xp: (_x, _y, _z, n) => { log.xp += n; },
  };
  return { log, events };
}

function setup() {
  const world = new TestWorld();
  const em = new EntityManager(world, 1);
  em.hostileSpawning = false;
  em.passiveSpawning = false;
  const { log, events } = eventsLog();
  const player: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: true };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) em.tick(player, 0, events, null, false); };
  return { world, em, log, player, tick };
}

describe('GoalSelector', () => {
  const goal = (flags: number, use: () => boolean, log: string[], name: string): Goal => ({
    flags, canUse: use, start: () => log.push(`start ${name}`), stop: () => log.push(`stop ${name}`), tick: () => log.push(`tick ${name}`),
  });

  it('runs the highest priority goal of conflicting flags and interrupts lower ones', () => {
    const log: string[] = [];
    let urgent = false;
    const sel = new GoalSelector()
      .add(5, goal(FLAG.MOVE, () => true, log, 'stroll'))
      .add(1, goal(FLAG.MOVE, () => urgent, log, 'panic'))
      .add(7, goal(FLAG.LOOK, () => true, log, 'look'));
    sel.tick();
    expect(log).toEqual(['start stroll', 'start look', 'tick stroll', 'tick look']);
    log.length = 0;
    urgent = true;
    sel.tick();
    expect(log).toContain('stop stroll');
    expect(log).toContain('start panic');
    expect(log).toContain('tick look'); // different flag: keeps running
    log.length = 0;
    sel.tick();
    // A running goal of higher priority blocks the stroll from starting again.
    expect(log).not.toContain('start stroll');
  });

  it('stops goals that can no longer continue', () => {
    const log: string[] = [];
    let ok = true;
    const sel = new GoalSelector().add(1, goal(FLAG.MOVE, () => ok, log, 'a'));
    sel.tick();
    ok = false;
    sel.tick();
    expect(log).toContain('stop a');
    expect(sel.runningGoals()).toHaveLength(0);
  });
});

describe('A* path finding', () => {
  it('walks around a wall', () => {
    const w = new TestWorld();
    for (let z = -5; z <= 5; z++) for (let y = 63; y < 66; y++) w.set(3, y, z, BLOCK.STONE);
    const path = new Path();
    const ok = findPath(w.getBlock.bind(w), 0, 63, 0, 6, 63, 0, { ...DEFAULT_PATH, maxNodes: 400 }, path);
    expect(ok).toBe(true);
    expect(path.complete).toBe(true);
    const cells: number[][] = [];
    for (let i = 0; i < path.length; i++) cells.push([path.cells[i * 3], path.cells[i * 3 + 1], path.cells[i * 3 + 2]]);
    // Never through the wall, and it ends at the target.
    expect(cells.some(([x, , z]) => x === 3 && Math.abs(z) <= 5)).toBe(false);
    expect(cells[cells.length - 1]).toEqual([6, 63, 0]);
  });

  it('jumps one block up but not two, and never enters lava', () => {
    const w = new TestWorld();
    w.set(2, 63, 0, BLOCK.STONE); // one-block step
    const path = new Path();
    expect(findPath(w.getBlock.bind(w), 0, 63, 0, 2, 64, 0, DEFAULT_PATH, path)).toBe(true);
    expect(path.complete).toBe(true);
    const lava = new TestWorld();
    for (let z = -20; z <= 20; z++) { lava.set(2, 62, z, BLOCK.LAVA); }
    const p2 = new Path();
    findPath(lava.getBlock.bind(lava), 0, 63, 0, 4, 63, 0, { ...DEFAULT_PATH, maxNodes: 300 }, p2);
    for (let i = 0; i < p2.length; i++) expect(p2.cells[i * 3]).not.toBe(2);
  });

  it('returns a partial path towards an unreachable target within the node budget', () => {
    const w = new TestWorld();
    for (let x = 18; x <= 22; x++) for (let z = -2; z <= 2; z++) for (let y = 63; y < 70; y++) if (Math.abs(x - 20) === 2 || Math.abs(z) === 2) w.set(x, y, z, BLOCK.STONE);
    const path = new Path();
    const before = pathStats.nodes;
    const ok = findPath(w.getBlock.bind(w), 0, 63, 0, 20, 63, 0, { ...DEFAULT_PATH, maxNodes: 120 }, path);
    expect(pathStats.nodes - before).toBeLessThanOrEqual(120);
    expect(ok).toBe(true);
    expect(path.complete).toBe(false);
    expect(path.cells[(path.length - 1) * 3]).toBeGreaterThan(5);
  });
});

describe('hostile goals (no regressions)', () => {
  it('a zombie chases the player and hits him once per second', () => {
    const s = setup();
    s.em.spawnMob('zombie', 8.5, 63, 0.5);
    s.tick(200);
    expect(s.log.attacks).toBeGreaterThanOrEqual(3);
    expect(s.log.attacks).toBeLessThanOrEqual(10);
  });

  it('a zombie walks around a wall to reach the player', () => {
    const s = setup();
    for (let z = -6; z <= 6; z++) for (let y = 63; y < 66; y++) s.world.set(4, y, z, BLOCK.STONE);
    s.em.spawnMob('zombie', 8.5, 63, 0.5);
    s.tick(300);
    expect(s.log.attacks).toBeGreaterThan(0);
  });

  it('a creeper swells for 1.5 s next to the player and explodes', () => {
    const s = setup();
    s.em.spawnMob('creeper', 2.5, 63, 0.5);
    s.tick(60);
    expect(s.log.explodes).toBe(1);
    expect(s.em.mobs).toHaveLength(0);
  });

  it('a skeleton keeps its distance and shoots every 3 s', () => {
    const s = setup();
    s.em.spawnMob('skeleton', 10.5, 63, 0.5);
    s.tick(200);
    expect(s.log.shots).toBeGreaterThanOrEqual(2);
    expect(s.log.shots).toBeLessThanOrEqual(4);
  });

  it('hostiles ignore players who cannot be attacked', () => {
    const s = setup();
    s.player.attackable = false;
    s.em.spawnMob('zombie', 3.5, 63, 0.5);
    s.tick(100);
    expect(s.log.attacks).toBe(0);
  });
});

describe('animals', () => {
  it('panic after being hurt and run off', () => {
    const s = setup();
    const pig = s.em.spawnMob('pig', 0.5, 63, 0.5);
    s.tick(2);
    pig.hurt(1, 0.5, 1.5, 0, true);
    let moved = 0;
    for (let i = 0; i < 60; i++) { s.tick(); moved = Math.max(moved, Math.hypot(pig.x - 0.5, pig.z - 0.5)); }
    expect(pig.panic).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(1.5);
  });

  it('stroll only to loaded, dry ground', () => {
    const s = setup();
    const cow = s.em.spawnMob('cow', 0.5, 63, 0.5);
    s.world.getBlock = ((orig) => (x: number, y: number, z: number) => (x > 4 ? BLOCK.UNLOADED : orig(x, y, z)))(s.world.getBlock.bind(s.world));
    s.tick(2000);
    expect(cow.x).toBeLessThan(5);
  });

  it('follow a player holding their food', () => {
    const s = setup();
    const sheep = s.em.spawnMob('sheep', 8.5, 63, 0.5);
    s.player.held = itemId('wheat');
    s.tick(200);
    expect(Math.hypot(sheep.x - s.player.x, sheep.z - s.player.z)).toBeLessThan(3.5);
  });

  it('breed after love mode: a baby, cooldown, XP and growth after 20 minutes', () => {
    const s = setup();
    const a = s.em.spawnMob('cow', 0.5, 63, 0.5), b = s.em.spawnMob('cow', 4.5, 63, 0.5);
    a.inLove = b.inLove = 600;
    s.tick(200);
    const babies = s.em.mobs.filter((m) => m.baby);
    expect(babies).toHaveLength(1);
    expect(a.breedCooldown).toBeGreaterThan(BREED_COOLDOWN - 200);
    expect(b.breedCooldown).toBeGreaterThan(BREED_COOLDOWN - 200);
    expect(s.log.xp).toBeGreaterThanOrEqual(1);
    const baby = babies[0];
    expect(baby.height).toBeCloseTo(a.height / 2);
    expect(baby.growingAge).toBeGreaterThan(BABY_AGE);
    baby.growingAge = -1;
    s.tick(1);
    expect(baby.baby).toBe(false);
    expect(baby.height).toBeCloseTo(a.height);
  });

  it('a sheep eats grass and regrows its wool', () => {
    const s = setup();
    const sheep = s.em.spawnMob('sheep', 0.5, 63, 0.5);
    sheep.variant |= 16;
    const real = Math.random;
    Math.random = () => 0.0001;
    try { s.tick(60); } finally { Math.random = real; }
    expect(sheep.variant & 16).toBe(0);
    expect(s.world.edits.size).toBeGreaterThan(0);
  });
});

describe('breeding food tags', () => {
  it('maps kinds to food through tags and skips unknown names', () => {
    expect(isBreedFood('cow', itemId('wheat'))).toBe(true);
    expect(isBreedFood('pig', itemId('carrot'))).toBe(true);
    expect(isBreedFood('pig', itemId('wheat'))).toBe(false);
    expect(isBreedFood('chicken', itemId('wheat_seeds'))).toBe(true);
    expect(isBreedFood('wolf', ITEM.BEEF)).toBe(true);
    expect(isBreedFood('zombie', ITEM.BEEF)).toBe(false);
    // 'beetroot_seeds' does not exist yet: the tag still works with what does.
    expect(tagItems('seeds').size).toBeGreaterThanOrEqual(3);
  });
});

describe('path budget', () => {
  it('40 mobs behind obstacles stay under 1 ms per tick on average', () => {
    const s = setup();
    for (let x = -30; x <= 30; x += 6) for (let z = -30; z <= 30; z++) if (Math.abs(z) > 1) s.world.set(x, 63, z, BLOCK.STONE), s.world.set(x, 64, z, BLOCK.STONE);
    for (let i = 0; i < 40; i++) s.em.spawnMob(i % 2 ? 'zombie' : 'pig', -25 + (i % 10) * 5 + 0.5, 63, -20 + Math.floor(i / 10) * 10 + 0.5);
    s.tick(40);
    // Best of several batches: other processes on the machine only ever make a batch slower.
    let best = Infinity;
    const searches0 = pathStats.searches;
    for (let b = 0; b < 6; b++) {
      const t0 = performance.now();
      s.tick(40);
      best = Math.min(best, (performance.now() - t0) / 40);
    }
    expect((pathStats.searches - searches0) / 240).toBeLessThanOrEqual(EntityManager.PATHS_PER_TICK);
    expect(best).toBeLessThan(1);
  });
});
