import { describe, expect, it } from 'vitest';
import { BLOCK, CUBE_ID } from '../src/world/BlockRegistry';
import { DOOR_OPEN_BIT, NORTH, doorMeta } from '../src/world/BlockStates';
import {
  BUTTON_PRESSED, LEVER_ON, MAX_CHANGES_PER_TICK, NOTE_POWERED, PISTON_EXTENDED, PLATE_PRESSED, REPEATER_POWERED, RedstoneSim, TORCH_OFF,
  dustColor, dustConnectMask, useComponent,
} from '../src/world/Redstone';

const B = BLOCK;
const STONE = B.STONE;
const RB = CUBE_ID.redstone_block;
// Directions (face order): 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z. Facings: 0 north, 1 south, 2 west, 3 east.
const FLOOR = 3;

/** A sparse world: air everywhere, bedrock below y 0, a stone floor at y 63. */
class Grid {
  readonly cells = new Map<string, [number, number]>();
  sim: RedstoneSim;
  entities = new Map<string, number>();
  changes = 0;
  constructor() {
    this.sim = new RedstoneSim(this);
  }
  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    const c = this.cells.get(`${x},${y},${z}`);
    if (c) return c[0];
    return y === 63 ? STONE : B.AIR;
  }
  getMeta(x: number, y: number, z: number): number {
    return this.cells.get(`${x},${y},${z}`)?.[1] ?? 0;
  }
  setState(x: number, y: number, z: number, id: number, meta: number): void {
    this.cells.set(`${x},${y},${z}`, [id, meta]);
    this.changes++;
    this.sim.notify(x, y, z);
  }
  entitiesOn(x: number, y: number, z: number): number {
    return this.entities.get(`${x},${y},${z}`) ?? 0;
  }
  /** A player edit. */
  put(x: number, y: number, z: number, id: number, meta = 0): this {
    this.setState(x, y, z, id, meta);
    return this;
  }
  run(ticks: number): this {
    for (let i = 0; i < ticks; i++) this.sim.tick();
    return this;
  }
  power(x: number, y: number, z: number): number {
    return this.getMeta(x, y, z) & 15;
  }
}

describe('dust', () => {
  it('decays by 1 per block from a lever', () => {
    const g = new Grid();
    for (let x = 1; x <= 16; x++) g.put(x, 64, 0, B.REDSTONE_WIRE);
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON).run(1);
    for (let x = 1; x <= 16; x++) expect(g.power(x, 64, 0)).toBe(16 - x);
    // Lever off: the whole line goes dark in the same tick.
    g.put(0, 64, 0, B.LEVER, FLOOR).run(1);
    for (let x = 1; x <= 16; x++) expect(g.power(x, 64, 0)).toBe(0);
  });

  it('a loop of dust does not keep itself powered', () => {
    const g = new Grid();
    for (let x = 1; x <= 4; x++) { g.put(x, 64, 0, B.REDSTONE_WIRE); g.put(x, 64, 3, B.REDSTONE_WIRE); }
    for (let z = 1; z <= 2; z++) { g.put(1, 64, z, B.REDSTONE_WIRE); g.put(4, 64, z, B.REDSTONE_WIRE); }
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON).run(1);
    expect(g.power(4, 64, 3)).toBeGreaterThan(0);
    g.put(0, 64, 0, B.LEVER, FLOOR).run(1);
    for (const [, [id, meta]] of g.cells) if (id === B.REDSTONE_WIRE) expect(meta & 15).toBe(0);
  });

  it('climbs a block and goes down the other side', () => {
    const g = new Grid();
    g.put(2, 64, 0, STONE);
    g.put(1, 64, 0, B.REDSTONE_WIRE).put(2, 65, 0, B.REDSTONE_WIRE).put(3, 64, 0, B.REDSTONE_WIRE);
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON).run(1);
    expect([g.power(1, 64, 0), g.power(2, 65, 0), g.power(3, 64, 0)]).toEqual([15, 14, 13]);
    const get = (x: number, y: number, z: number) => g.getBlock(x, y, z), meta = (x: number, y: number, z: number) => g.getMeta(x, y, z);
    // The lower dust climbs the wall towards the east (up bit 8 << 4).
    expect(dustConnectMask(get, meta, 1, 64, 0) & (8 << 4)).toBeTruthy();
    // A solid block on top of the lower dust cuts the slope.
    g.put(1, 65, 0, STONE).run(1);
    expect(g.power(2, 65, 0)).toBe(0);
  });

  it('powers the block it points into, which powers a lamp next to it', () => {
    const g = new Grid();
    g.put(1, 64, 0, B.REDSTONE_WIRE).put(2, 64, 0, B.REDSTONE_WIRE).put(3, 64, 0, STONE).put(3, 64, 1, B.REDSTONE_LAMP);
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON).run(1);
    expect(g.getBlock(3, 64, 1)).toBe(B.REDSTONE_LAMP_LIT);
  });

  it('has Minecraft colours from dark to bright red', () => {
    expect(dustColor(0)).toBe(0x4d0000);
    expect(dustColor(15) >> 16).toBe(255);
    expect(dustColor(15) & 0xffff).toBe(0x3300);
  });
});

describe('repeater', () => {
  it('restores the signal to 15 after the delay', () => {
    const g = new Grid();
    for (let x = 1; x <= 14; x++) g.put(x, 64, 0, B.REDSTONE_WIRE);
    g.put(15, 64, 0, B.REPEATER, 3); // east, delay 1
    for (let x = 16; x <= 18; x++) g.put(x, 64, 0, B.REDSTONE_WIRE);
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON).run(1);
    expect(g.power(14, 64, 0)).toBe(2);
    expect(g.power(16, 64, 0)).toBe(0);
    g.run(1);
    expect(g.power(16, 64, 0)).toBe(0);
    g.run(1);
    expect(g.getMeta(15, 64, 0) & REPEATER_POWERED).toBeTruthy();
    expect(g.power(16, 64, 0)).toBe(15);
    expect(g.power(18, 64, 0)).toBe(13);
  });

  it('waits its delay (1-4 redstone ticks) and only passes the signal forwards', () => {
    const g = new Grid();
    g.put(1, 64, 0, B.REPEATER, 3 | (3 << 2)); // 4 redstone ticks = 8 game ticks
    g.put(2, 64, 0, B.REDSTONE_WIRE);
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON);
    // The edit is handled on the first tick; the output follows 8 game ticks later.
    g.run(8);
    expect(g.power(2, 64, 0)).toBe(0);
    g.run(1);
    expect(g.power(2, 64, 0)).toBe(15);
    // Backwards nothing gets through.
    const h = new Grid();
    h.put(1, 64, 0, B.REPEATER, 3).put(2, 64, 0, B.REDSTONE_WIRE).put(0, 64, 0, B.REDSTONE_WIRE);
    h.put(3, 64, 0, B.LEVER, FLOOR | LEVER_ON).run(10);
    expect(h.power(2, 64, 0)).toBe(15);
    expect(h.power(0, 64, 0)).toBe(0);
  });

  it('right click steps the delay', () => {
    expect(useComponent(B.REPEATER, 3)).toBe(3 | 4);
    expect(useComponent(B.REPEATER, 3 | 12)).toBe(3);
  });
});

describe('redstone torch', () => {
  it('inverts the block it is attached to', () => {
    const g = new Grid();
    g.put(0, 64, 0, STONE);
    g.put(1, 64, 0, B.REDSTONE_TORCH, 1); // on the east side of the block, attached towards −X
    g.put(2, 64, 0, B.REDSTONE_WIRE);
    g.run(1);
    expect(g.getMeta(1, 64, 0) & TORCH_OFF).toBe(0);
    expect(g.power(2, 64, 0)).toBe(15);
    // A lever on top of the block powers it strongly: the torch goes out after 2 ticks.
    g.put(0, 65, 0, B.LEVER, FLOOR | LEVER_ON).run(1);
    expect(g.getMeta(1, 64, 0) & TORCH_OFF).toBe(0);
    g.run(2);
    expect(g.getMeta(1, 64, 0) & TORCH_OFF).toBeTruthy();
    expect(g.power(2, 64, 0)).toBe(0);
  });

  it('a floor torch powers the block above it strongly', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.REDSTONE_TORCH, FLOOR).put(0, 65, 0, STONE).put(1, 65, 0, B.REDSTONE_LAMP).run(2);
    expect(g.getBlock(1, 65, 0)).toBe(B.REDSTONE_LAMP_LIT);
  });

  it('burns out when it toggles too fast, and stays dark', () => {
    const g = new Grid();
    g.put(0, 64, 0, STONE).put(1, 64, 0, B.REDSTONE_TORCH, 1).run(1);
    let toggles = 0;
    for (let i = 0; i < 12; i++) {
      g.put(0, 65, 0, B.LEVER, FLOOR | LEVER_ON).run(3);
      g.put(0, 65, 0, B.LEVER, FLOOR).run(3);
      if (!(g.getMeta(1, 64, 0) & TORCH_OFF)) toggles++;
    }
    expect(g.sim.stats.burnouts).toBeGreaterThan(0);
    expect(g.getMeta(1, 64, 0) & TORCH_OFF).toBeTruthy();
    expect(toggles).toBeLessThan(12);
    // After the reset it lights again.
    g.run(200);
    expect(g.getMeta(1, 64, 0) & TORCH_OFF).toBe(0);
  });

  it('a torch clock oscillates but stays inside the budgets', () => {
    const g = new Grid();
    // Torch on the east side of a block; a repeater carries its output around and back into the block.
    g.put(0, 64, 0, STONE).put(1, 64, 0, B.REDSTONE_TORCH, 1);
    g.put(1, 64, 1, B.REPEATER, 1); // south
    g.put(1, 64, 2, B.REDSTONE_WIRE).put(0, 64, 2, B.REDSTONE_WIRE).put(0, 64, 1, B.REDSTONE_WIRE);
    const states: number[] = [];
    for (let i = 0; i < 400; i++) {
      const before = g.changes;
      g.sim.tick();
      expect(g.changes - before).toBeLessThanOrEqual(MAX_CHANGES_PER_TICK);
      states.push(g.getMeta(1, 64, 0) & TORCH_OFF);
    }
    // It did oscillate, and burnout throttles it: never more than 8 turn-offs within any 60 ticks.
    const offs: number[] = states.map((s, i) => (i > 0 && s && !states[i - 1] ? 1 : 0));
    expect(offs.reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
    for (let i = 0; i + 60 <= offs.length; i++) expect(offs.slice(i, i + 60).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8);
  });
});

describe('consumers', () => {
  it('lamp lights at once and goes out 4 ticks after the power', () => {
    const g = new Grid();
    g.put(1, 64, 0, B.REDSTONE_LAMP).put(0, 64, 0, B.LEVER, 0 | LEVER_ON).run(1);
    expect(g.getBlock(1, 64, 0)).toBe(B.REDSTONE_LAMP_LIT);
    g.put(0, 64, 0, B.LEVER, 0).run(4);
    expect(g.getBlock(1, 64, 0)).toBe(B.REDSTONE_LAMP_LIT);
    g.run(1);
    expect(g.getBlock(1, 64, 0)).toBe(B.REDSTONE_LAMP);
  });

  it('a pressure plate opens a door and closes it 10 ticks after the player leaves', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.OAK_DOOR, doorMeta(NORTH, false, false, false)).put(0, 65, 0, B.OAK_DOOR, doorMeta(NORTH, true, false, false));
    g.put(0, 64, 1, B.PRESSURE_PLATE, 0).run(2);
    g.entities.set('0,64,1', 1);
    g.run(2);
    expect(g.getMeta(0, 64, 1) & PLATE_PRESSED).toBeTruthy();
    expect(g.getMeta(0, 64, 0) & DOOR_OPEN_BIT).toBeTruthy();
    expect(g.getMeta(0, 65, 0) & DOOR_OPEN_BIT).toBeTruthy();
    g.entities.clear();
    g.run(14);
    expect(g.getMeta(0, 64, 0) & DOOR_OPEN_BIT).toBe(0);
  });

  it('a manually opened door is not closed by an unrelated update', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.OAK_DOOR, doorMeta(NORTH, false, false, true)).put(0, 65, 0, B.OAK_DOOR, doorMeta(NORTH, true, false, true));
    g.put(1, 64, 0, STONE).run(2);
    expect(g.getMeta(0, 64, 0) & DOOR_OPEN_BIT).toBeTruthy();
  });

  it('a button gives a pulse of 20 (stone) game ticks', () => {
    const g = new Grid();
    g.put(0, 64, 0, STONE).put(1, 64, 0, B.BUTTON, 1).put(2, 64, 0, B.REDSTONE_LAMP);
    g.put(1, 64, 0, B.BUTTON, useComponent(B.BUTTON, 1)!).run(1);
    expect(g.getMeta(1, 64, 0) & BUTTON_PRESSED).toBeTruthy();
    expect(g.getBlock(2, 64, 0)).toBe(B.REDSTONE_LAMP_LIT);
    g.run(19);
    expect(g.getMeta(1, 64, 0) & BUTTON_PRESSED).toBeTruthy();
    g.run(1);
    expect(g.getMeta(1, 64, 0) & BUTTON_PRESSED).toBe(0);
    expect(g.getBlock(2, 64, 0)).toBe(B.REDSTONE_LAMP_LIT);
    g.run(5);
    expect(g.getBlock(2, 64, 0)).toBe(B.REDSTONE_LAMP);
  });

  it('a note block marks the rising edge of power', () => {
    const g = new Grid();
    g.put(1, 64, 0, B.NOTE_BLOCK, 5).put(0, 64, 0, B.LEVER, LEVER_ON).run(1);
    expect(g.getMeta(1, 64, 0)).toBe(5 | NOTE_POWERED);
    expect(useComponent(B.NOTE_BLOCK, 24 | NOTE_POWERED)).toBe(NOTE_POWERED);
  });

  it('TNT is lit by power', () => {
    const g = new Grid();
    const lit: string[] = [];
    g.sim.onIgnite = (x, y, z) => { lit.push(`${x},${y},${z}`); g.setState(x, y, z, B.AIR, 0); return true; };
    g.put(1, 64, 0, B.TNT).put(0, 64, 0, RB).run(1);
    expect(lit).toEqual(['1,64,0']);
  });

  it('components without support pop off', () => {
    const g = new Grid();
    const broken: number[] = [];
    g.sim.onBreak = (_x, _y, _z, id) => broken.push(id);
    g.put(0, 64, 0, STONE).put(1, 64, 0, B.LEVER, 1).put(0, 65, 0, B.REDSTONE_WIRE);
    g.put(0, 64, 0, B.AIR).run(1);
    expect(g.getBlock(1, 64, 0)).toBe(B.AIR);
    expect(g.getBlock(0, 65, 0)).toBe(B.AIR);
    expect(broken.sort()).toEqual([B.LEVER, B.REDSTONE_WIRE].sort());
  });
});

describe('pistons', () => {
  const extend = (g: Grid): Grid => g.put(0, 64, -1, RB).run(3);

  it('pushes up to 12 blocks', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.PISTON, 0); // facing +X
    for (let x = 1; x <= 12; x++) g.put(x, 64, 0, B.COBBLESTONE);
    extend(g);
    expect(g.getMeta(0, 64, 0) & PISTON_EXTENDED).toBeTruthy();
    expect(g.getBlock(1, 64, 0)).toBe(B.PISTON_HEAD);
    for (let x = 2; x <= 13; x++) expect(g.getBlock(x, 64, 0)).toBe(B.COBBLESTONE);
    // Normal piston: the blocks stay when it retracts.
    g.put(0, 64, -1, B.AIR).run(3);
    expect(g.getBlock(1, 64, 0)).toBe(B.AIR);
    expect(g.getBlock(2, 64, 0)).toBe(B.COBBLESTONE);
  });

  it('cannot push 13 blocks, obsidian or a chest', () => {
    for (const blocker of [B.OBSIDIAN, B.CHEST, B.BEDROCK]) {
      const g = new Grid();
      g.put(0, 64, 0, B.PISTON, 0).put(1, 64, 0, B.COBBLESTONE).put(2, 64, 0, blocker);
      extend(g);
      expect(g.getMeta(0, 64, 0) & PISTON_EXTENDED).toBe(0);
      expect(g.getBlock(1, 64, 0)).toBe(B.COBBLESTONE);
    }
    const g = new Grid();
    g.put(0, 64, 0, B.PISTON, 0);
    for (let x = 1; x <= 13; x++) g.put(x, 64, 0, B.COBBLESTONE);
    extend(g);
    expect(g.getMeta(0, 64, 0) & PISTON_EXTENDED).toBe(0);
  });

  it('breaks dust and plants in the way', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.PISTON, 0).put(1, 64, 0, B.COBBLESTONE).put(2, 64, 0, B.REDSTONE_WIRE);
    extend(g);
    expect(g.getBlock(2, 64, 0)).toBe(B.COBBLESTONE);
  });

  it('sticky piston pulls the block back', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.STICKY_PISTON, 0).put(1, 64, 0, B.STONE_BRICKS);
    extend(g);
    expect(g.getBlock(2, 64, 0)).toBe(B.STONE_BRICKS);
    g.put(0, 64, -1, B.AIR).run(3);
    expect(g.getBlock(1, 64, 0)).toBe(B.STONE_BRICKS);
    expect(g.getBlock(2, 64, 0)).toBe(B.AIR);
    expect(g.getMeta(0, 64, 0) & PISTON_EXTENDED).toBe(0);
  });

  it('a piston door: two sticky pistons open and close a 1x2 gap', () => {
    const g = new Grid();
    for (const y of [64, 65]) g.put(0, y, 0, B.STICKY_PISTON, 0).put(1, y, 0, B.STONE_BRICKS);
    g.put(0, 64, -1, RB).put(0, 65, -1, RB).run(3);
    expect(g.getBlock(2, 64, 0)).toBe(B.STONE_BRICKS);
    expect(g.getBlock(2, 65, 0)).toBe(B.STONE_BRICKS);
    g.put(0, 64, -1, B.AIR).put(0, 65, -1, B.AIR).run(3);
    expect(g.getBlock(1, 64, 0)).toBe(B.STONE_BRICKS);
    expect(g.getBlock(1, 65, 0)).toBe(B.STONE_BRICKS);
  });

  it('a head without its piston disappears, a piston without its head retracts', () => {
    const g = new Grid();
    g.put(0, 64, 0, B.PISTON, 0);
    extend(g);
    g.put(0, 64, 0, B.AIR).run(3);
    expect(g.getBlock(1, 64, 0)).toBe(B.AIR);
    const h = new Grid();
    h.put(0, 64, 0, B.PISTON, 0 | PISTON_EXTENDED).run(3);
    expect(h.getMeta(0, 64, 0) & PISTON_EXTENDED).toBe(0);
  });
});

describe('budgets', () => {
  it('a 2000-dust network beyond the change budget finishes over several ticks', () => {
    const g = new Grid();
    // A comb of 15-long lines fed by repeaters would be realistic; a plain grid of dust is the worst case.
    for (let z = 0; z < 40; z++) for (let x = 1; x <= 50; x++) g.put(x, 64, z, B.REDSTONE_WIRE);
    g.run(1);
    g.put(0, 64, 0, B.LEVER, FLOOR | LEVER_ON);
    const before = g.changes;
    g.sim.tick(4000, 100);
    expect(g.changes - before).toBeLessThanOrEqual(101);
    for (let i = 0; i < 40; i++) g.sim.tick(4000, 100);
    expect(g.power(1, 64, 0)).toBe(15);
    expect(g.power(10, 64, 5)).toBe(1);
    expect(g.power(20, 64, 20)).toBe(0);
    expect(g.sim.stats.deferred).toBeGreaterThan(0);
  });
});
