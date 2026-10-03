import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GAME_MODES, canFly, hasSurvivalRules } from '../src/player/GameMode';
import { PHYSICS, approach } from '../src/player/Physics';
import { type MoveInput, Player } from '../src/player/Player';
import { MAX_AIR, MAX_HEALTH, MAX_HUNGER, PlayerStats } from '../src/player/PlayerStats';
import { BLOCK } from '../src/world/BlockRegistry';
import { TestWorld } from './helpers';

const idle: MoveInput = { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };
const air = (): number => 0;

function stepN(p: Player, w: { get: (x: number, y: number, z: number) => number }, n: number, input: Partial<MoveInput> = {}): void {
  for (let i = 0; i < n; i++) p.step({ ...idle, ...input }, w.get);
}

function floorWorld(): TestWorld {
  return new TestWorld().fill(-20, 0, -20, 20, 0, 20, BLOCK.STONE);
}

describe('GameMode rules', () => {
  it('survival and hardcore have survival rules, creative and spectator can fly', () => {
    expect(GAME_MODES.filter(hasSurvivalRules).sort()).toEqual(['hardcore', 'survival']);
    expect(GAME_MODES.filter(canFly).sort()).toEqual(['creative', 'spectator']);
  });
});

describe('Physics helpers', () => {
  it('approach moves towards the target without overshooting, from either side', () => {
    fc.assert(fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: 0.1, max: 100, noNaN: true }), (v, target, accel) => {
      const r = approach(v, target, accel, 1 / 60);
      expect(Math.abs(r - target)).toBeLessThanOrEqual(Math.abs(v - target) + 1e-9);
      if (v < target) expect(r).toBeLessThanOrEqual(target + 1e-9);
      else expect(r).toBeGreaterThanOrEqual(target - 1e-9);
    }), { numRuns: 500 });
  });
});

describe('Player movement', () => {
  it('walks at walking speed and sprints faster, on the floor', () => {
    const w = floorWorld();
    const walker = new Player();
    walker.setPosition(0.5, 1, 0.5);
    stepN(walker, w, 120, { forward: 1 });
    const sprinter = new Player();
    sprinter.setPosition(0.5, 1, 0.5);
    stepN(sprinter, w, 120, { forward: 1, sprint: true });
    expect(walker.onGround).toBe(true);
    expect(-walker.z + 0.5).toBeGreaterThan(5);
    expect(-sprinter.z).toBeGreaterThan(-walker.z + 1);
    expect(sprinter.sprinting).toBe(true);
    expect(sprinter.sprintDistance).toBeGreaterThan(0);
  });

  it('cannot sprint without enough food (canSprint) or while moving backwards', () => {
    const w = floorWorld();
    const p = new Player();
    p.setPosition(0.5, 1, 0.5);
    p.canSprint = false;
    stepN(p, w, 10, { forward: 1, sprint: true });
    expect(p.sprinting).toBe(false);
    p.canSprint = true;
    stepN(p, w, 10, { forward: -1, sprint: true });
    expect(p.sprinting).toBe(false);
  });

  it('jumps up and comes down again, counting the jump', () => {
    const w = floorWorld();
    const p = new Player();
    p.setPosition(0.5, 1, 0.5);
    stepN(p, w, 5);
    let top = p.y;
    p.step({ ...idle, jump: true }, w.get);
    for (let i = 0; i < 50; i++) { p.step(idle, w.get); top = Math.max(top, p.y); }
    expect(top - 1).toBeGreaterThan(1);
    expect(top - 1).toBeLessThan(1.5);
    expect(p.jumps).toBe(1);
    expect(p.onGround).toBe(true);
    expect(p.landedFall).toBeGreaterThanOrEqual(0);
  });

  it('records the fall distance of a landing (fall damage = distance - 3)', () => {
    const w = floorWorld();
    const p = new Player();
    p.setPosition(0.5, 11, 0.5);
    stepN(p, w, 120);
    expect(p.onGround).toBe(true);
    expect(p.landedFall).toBeGreaterThan(9.5);
    expect(p.landedFall).toBeLessThan(10.5);
  });

  it('does not accumulate fall distance in water', () => {
    const w = floorWorld().fill(-5, 1, -5, 5, 20, 5, BLOCK.WATER);
    const p = new Player();
    p.setPosition(0.5, 15, 0.5);
    stepN(p, w, 240);
    expect(p.inWater).toBe(true);
    expect(p.landedFall).toBe(0);
    expect(p.fallDistance).toBe(0);
  });

  it('sinks slowly in water, swims up when jumping and flags the head being under water', () => {
    const w = floorWorld().fill(-5, 1, -5, 5, 10, 5, BLOCK.WATER);
    const p = new Player();
    p.setPosition(0.5, 6, 0.5);
    stepN(p, w, 60);
    expect(p.y).toBeLessThan(6);
    expect(p.headInWater).toBe(true);
    const low = p.y;
    stepN(p, w, 60, { jump: true });
    expect(p.y).toBeGreaterThan(low);
  });

  it('toggles flight with a double tap on jump in creative, and landing ends it', () => {
    const w = floorWorld();
    const p = new Player();
    p.canFly = true;
    p.setPosition(0.5, 5, 0.5);
    p.step({ ...idle, jumpPressed: true }, w.get);
    expect(p.flying).toBe(false);
    p.step({ ...idle, jumpPressed: true }, w.get);
    expect(p.flying).toBe(true);
    stepN(p, w, 30, { jump: true });
    expect(p.y).toBeGreaterThan(6);
    stepN(p, w, 400, { descend: true });
    expect(p.onGround).toBe(true);
    expect(p.flying).toBe(false);
  });

  it('survival players cannot fly, whatever they tap', () => {
    const w = floorWorld();
    const p = new Player();
    p.canFly = false;
    p.flying = true;
    p.setPosition(0.5, 5, 0.5);
    p.step({ ...idle, jumpPressed: true }, w.get);
    p.step({ ...idle, jumpPressed: true }, w.get);
    expect(p.flying).toBe(false);
  });

  it('spectators fly through walls', () => {
    const w = new TestWorld().fill(-1, 0, -3, 1, 10, -1, BLOCK.STONE);
    const p = new Player();
    p.noclip = true;
    p.setPosition(0.5, 5, 2);
    stepN(p, w, 120, { forward: 1 });
    expect(p.z).toBeLessThan(-3);
  });

  it('stops at a wall and keeps its box out of solid blocks, whatever the input sequence', () => {
    const w = floorWorld().fill(3, 1, -20, 3, 6, 20, BLOCK.STONE).fill(-3, 1, -20, -3, 6, 20, BLOCK.STONE);
    const input = fc.record({ forward: fc.constantFrom(-1, 0, 1), strafe: fc.constantFrom(-1, 0, 1), jump: fc.boolean(), sprint: fc.boolean(), yaw: fc.double({ min: -4, max: 4, noNaN: true }) });
    fc.assert(fc.property(fc.array(input, { minLength: 1, maxLength: 40 }), (inputs) => {
      const p = new Player();
      p.canFly = false;
      p.setPosition(0.5, 1, 0.5);
      for (const i of inputs) {
        p.yaw = i.yaw;
        for (let k = 0; k < 6; k++) p.step({ ...idle, forward: i.forward, strafe: i.strafe, jump: i.jump, sprint: i.sprint }, w.get);
        expect(p.x).toBeGreaterThan(-3 + 0.3 - 0.01);
        expect(p.x).toBeLessThan(3 - 0.3 + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(1 - 1e-6);
      }
    }), { numRuns: 60 });
  });

  it('does not climb a full block by walking into it', () => {
    const w = floorWorld();
    const meta = (x: number, y: number, z: number) => (x === 0 && y === 1 && z === -2 ? 0 : 0);
    w.set(0, 1, -2, BLOCK.OAK_PLANKS);
    const p = new Player();
    p.setPosition(0.5, 1, 0.5);
    for (let i = 0; i < 90; i++) p.step({ ...idle, forward: 1 }, w.get, meta);
    // Full blocks are a wall for a player who does not jump: no step-up.
    expect(p.y).toBeCloseTo(1, 3);
  });

  it('unstick lifts a player out of a block', () => {
    const w = new TestWorld().fill(-2, 60, -2, 2, 70, 2, BLOCK.STONE);
    const p = new Player();
    p.setPosition(0.5, 62, 0.5);
    p.unstick(w.get);
    expect(p.y).toBeGreaterThanOrEqual(71);
  });
});

describe('PlayerStats hazards', () => {
  function setup(): { stats: PlayerStats; p: Player } {
    const p = new Player();
    p.setPosition(0.5, 64, 0.5);
    // Hunger 10: no natural regeneration and no starvation get in the way of the hazard under test.
    const stats = new PlayerStats();
    stats.hunger = 10;
    return { stats, p };
  }
  const run = (s: PlayerStats, p: Player, n: number, get: (x: number, y: number, z: number) => number = air, mode: 'survival' | 'creative' | 'hardcore' | 'spectator' = 'survival') => {
    for (let i = 0; i < n; i++) s.tick(p, get, mode);
  };

  it('drowning: 300 ticks of air, then 2 damage per second', () => {
    const { stats, p } = setup();
    p.headInWater = true;
    run(stats, p, 299);
    expect(stats.air).toBeLessThan(5);
    expect(stats.health).toBe(MAX_HEALTH);
    run(stats, p, 30);
    expect(stats.health).toBe(MAX_HEALTH - 2);
    p.headInWater = false;
    run(stats, p, 100);
    expect(stats.air).toBe(MAX_AIR);
  });

  it('lava hurts 4 and sets you on fire; fire burns until water puts it out', () => {
    const { stats, p } = setup();
    const lava = (x: number, y: number) => (y === 64 && x === 0 ? BLOCK.LAVA : 0);
    run(stats, p, 1, lava);
    expect(stats.health).toBe(MAX_HEALTH - 4);
    expect(stats.burnTicks).toBe(300);
    run(stats, p, 60);
    expect(stats.health).toBeLessThan(MAX_HEALTH - 4);
    p.inWater = true;
    run(stats, p, 1);
    expect(stats.burnTicks).toBe(0);
  });

  it('cactus pricks, poison never kills, and suffocation hurts inside opaque blocks only', () => {
    const { stats, p } = setup();
    const cactus = (x: number, y: number) => (y === 64 && x === 0 ? BLOCK.CACTUS : 0);
    run(stats, p, 1, cactus);
    expect(stats.health).toBe(MAX_HEALTH - 1);

    const poisoned = setup();
    poisoned.stats.poison = 5000;
    run(poisoned.stats, poisoned.p, 5000);
    expect(poisoned.stats.health).toBe(1);

    const stuck = setup();
    const solid = () => BLOCK.STONE;
    run(stuck.stats, stuck.p, 40, solid);
    expect(stuck.stats.health).toBeLessThan(MAX_HEALTH);
    const unloaded = setup();
    run(unloaded.stats, unloaded.p, 40, () => BLOCK.UNLOADED);
    expect(unloaded.stats.health).toBe(MAX_HEALTH);
  });

  it('the void hurts in every mode except spectator and kills even in creative', () => {
    for (const mode of ['survival', 'creative'] as const) {
      const { stats, p } = setup();
      p.setPosition(0, -100, 0);
      run(stats, p, 40, air, mode);
      expect(stats.health, mode).toBeLessThan(MAX_HEALTH);
    }
    const { stats, p } = setup();
    p.setPosition(0, -100, 0);
    run(stats, p, 40, air, 'spectator');
    expect(stats.health).toBe(MAX_HEALTH);
  });

  it('records the cause in the death message, with a killer verb per cause', () => {
    const cases: [Parameters<PlayerStats['damage']>[1], string, string][] = [
      ['mob', 'Zombie', 'was slain by Zombie'], ['arrow', 'Skeleton', 'was shot by Skeleton'], ['explosion', 'Creeper', 'was blown up by Creeper'],
    ];
    for (const [cause, killer, text] of cases) {
      const s = new PlayerStats();
      s.damage(100, cause, 'survival', killer);
      expect(s.dead).toBe(true);
      expect(s.deathMessage).toContain(text);
    }
    const f = new PlayerStats();
    f.damage(100, 'fall', 'survival');
    expect(f.deathMessage).toContain('fell from a high place');
    expect(f.damage(5, 'mob', 'survival')).toBe(false); // already dead
  });

  it('remembers the direction of the last hit for the hurt camera', () => {
    const s = new PlayerStats();
    s.damage(3, 'mob', 'survival', '', 1.25);
    expect(s.hurtDirection).toBe(1.25);
    expect(s.hurtTime).toBe(10);
  });

  it('ignores damage in creative and spectator, takes it in survival and hardcore', () => {
    for (const mode of GAME_MODES) {
      const s = new PlayerStats();
      expect(s.damage(3, 'mob', mode), mode).toBe(hasSurvivalRules(mode));
    }
  });

  it('serialises and restores health, hunger and air; a save made while dead restarts alive but flagged', () => {
    const s = new PlayerStats();
    s.damage(5, 'mob', 'survival');
    s.hunger = 12;
    s.air = 100;
    const t = new PlayerStats();
    t.load(JSON.parse(JSON.stringify(s.serialize())) as number[]);
    expect(t.health).toBe(15);
    expect(t.hunger).toBe(12);
    expect(t.air).toBe(100);
    expect(t.wasDead).toBe(false);
    const dead = new PlayerStats();
    dead.load([0, 5, 5, 0, 300]);
    expect(dead.wasDead).toBe(true);
    expect(dead.health).toBe(MAX_HEALTH);
    dead.load(undefined);
    expect(dead.health).toBe(MAX_HEALTH);
  });

  it('health, hunger and air stay inside their bounds under random events', () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant('damage' as const), n: fc.double({ min: -5, max: 30, noNaN: true }) }),
      fc.record({ k: fc.constant('heal' as const), n: fc.double({ min: -5, max: 30, noNaN: true }) }),
      fc.record({ k: fc.constant('eat' as const), n: fc.integer({ min: 0, max: 20 }) }),
      fc.record({ k: fc.constant('exhaust' as const), n: fc.double({ min: 0, max: 100, noNaN: true }) }),
      fc.record({ k: fc.constant('tick' as const), n: fc.integer({ min: 1, max: 100 }) }),
    );
    fc.assert(fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
      const { stats, p } = setup();
      for (const o of ops) {
        if (o.k === 'damage') stats.damage(o.n, 'mob', 'survival');
        else if (o.k === 'heal') stats.heal(Math.max(0, o.n));
        else if (o.k === 'eat') stats.eat(o.n, o.n / 2);
        else if (o.k === 'exhaust') stats.addExhaustion(o.n);
        else run(stats, p, o.n);
        expect(stats.health).toBeGreaterThanOrEqual(0);
        expect(stats.health).toBeLessThanOrEqual(MAX_HEALTH);
        expect(stats.hunger).toBeGreaterThanOrEqual(0);
        expect(stats.hunger).toBeLessThanOrEqual(MAX_HUNGER);
        expect(stats.saturation).toBeLessThanOrEqual(stats.hunger + 1e-9);
        expect(stats.exhaustion).toBeLessThanOrEqual(40 + 4);
        expect(stats.air).toBeLessThanOrEqual(MAX_AIR);
      }
    }), { numRuns: 150 });
  });
});

describe('PHYSICS constants', () => {
  it('describe a player that can jump one block but not two', () => {
    const h = (PHYSICS.JUMP_VELOCITY ** 2) / (2 * PHYSICS.GRAVITY);
    expect(h).toBeGreaterThan(1.0);
    expect(h).toBeLessThan(1.5);
  });
});
