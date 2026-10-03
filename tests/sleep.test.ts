import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { BED_HEAD_BIT } from '../src/world/BoxShapes';
import { DEFAULT_DIFFICULTY, type Difficulty } from '../src/world/Difficulty';
import { GameRules } from '../src/world/GameRules';
import { MSG, SLEEP_TICKS, bedRespawnPoint, canSleepNow, monstersNearby, sleepSkipsNight } from '../src/world/Sleep';
import { type CommandHost, emptyModeration, runCommand } from '../server/Commands';
import { ServerSurvival, type SurvivalHost } from '../server/SurvivalRules';

/** A tiny world: stone up to y 63, air above; beds are placed with placeBed. */
function bedWorld(extra: Record<string, number> = {}) {
  const blocks = new Map<string, number>();
  const metas = new Map<string, number>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  return {
    blocks, metas, key,
    getBlock: (x: number, y: number, z: number) => {
      const k = key(x, y, z);
      if (k in extra) return extra[k];
      if (blocks.has(k)) return blocks.get(k)!;
      return y <= 63 ? BLOCK.STONE : BLOCK.AIR;
    },
    getMeta: (x: number, y: number, z: number) => metas.get(key(x, y, z)) ?? 0,
  };
}

describe('sleep rules', () => {
  it('allows sleeping at night or in a thunderstorm', () => {
    expect(canSleepNow(0, false)).toBe(true);
    expect(canSleepNow(0.39, false)).toBe(true);
    expect(canSleepNow(1, false)).toBe(false);
    expect(canSleepNow(1, true)).toBe(true);
  });

  it('finds monsters within 8 blocks sideways and 5 up or down', () => {
    const zombie = (x: number, y: number, z: number, dead = false) => ({ x, y, z, dead, type: { hostile: true } });
    const pig = { x: 1, y: 0, z: 1, dead: false, type: { hostile: false } };
    expect(monstersNearby([pig], 0, 0, 0)).toBe(false);
    expect(monstersNearby([zombie(7, 0, -7)], 0, 0, 0)).toBe(true);
    expect(monstersNearby([zombie(9, 0, 0)], 0, 0, 0)).toBe(false);
    expect(monstersNearby([zombie(0, 6, 0)], 0, 0, 0)).toBe(false);
    expect(monstersNearby([zombie(0, 0, 0, true)], 0, 0, 0)).toBe(false);
  });

  it('skips the night by the sleeping percentage', () => {
    expect(sleepSkipsNight(1, 1, 100)).toBe(true);
    expect(sleepSkipsNight(1, 2, 100)).toBe(false);
    expect(sleepSkipsNight(2, 2, 100)).toBe(true);
    expect(sleepSkipsNight(1, 2, 50)).toBe(true);
    expect(sleepSkipsNight(1, 3, 50)).toBe(false);
    expect(sleepSkipsNight(1, 10, 0)).toBe(true);
    expect(sleepSkipsNight(0, 1, 0)).toBe(false);
  });
});

function placeBed(w: ReturnType<typeof bedWorld>, facing: number): { foot: [number, number]; head: [number, number] } {
  const dx = [0, -1, 0, 1], dz = [1, 0, -1, 0];
  // Whatever the facing table is, bedRespawnPoint only needs a consistent pair: try the partner bedPartner computes.
  w.blocks.set(w.key(0, 64, 0), BLOCK.BED);
  w.metas.set(w.key(0, 64, 0), facing);
  // Locate the partner by asking for every neighbour that makes a valid bed.
  for (let i = 0; i < 4; i++) {
    const hx = dx[i], hz = dz[i];
    w.blocks.set(w.key(hx, 64, hz), BLOCK.BED);
    w.metas.set(w.key(hx, 64, hz), facing | BED_HEAD_BIT);
    if (bedRespawnPoint(w.getBlock, w.getMeta, hx, 64, hz)) return { foot: [0, 0], head: [hx, hz] };
    w.blocks.delete(w.key(hx, 64, hz));
  }
  throw new Error('no partner');
}

describe('bed respawn point', () => {
  it('puts the player next to the bed, on the floor', () => {
    const w = bedWorld();
    placeBed(w, 0);
    const p = bedRespawnPoint(w.getBlock, w.getMeta, 0, 64, 0)!;
    expect(p).not.toBeNull();
    expect(p.y).toBe(64);
    expect(w.getBlock(Math.floor(p.x), 64, Math.floor(p.z))).toBe(BLOCK.AIR);
  });

  it('is null when the bed is gone', () => {
    const w = bedWorld();
    expect(bedRespawnPoint(w.getBlock, w.getMeta, 0, 64, 0)).toBeNull();
  });

  it('is null when every spot around and above is blocked', () => {
    const w = bedWorld();
    placeBed(w, 0);
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 66; y++) {
      if (!w.blocks.has(w.key(x, y, z))) w.blocks.set(w.key(x, y, z), BLOCK.STONE);
    }
    expect(bedRespawnPoint(w.getBlock, w.getMeta, 0, 64, 0)).toBeNull();
  });
});

describe('ServerSurvival sleeping', () => {
  function setup(opts: { day?: number; mobs?: { x: number; y: number; z: number; dead: boolean; type: { hostile: boolean } }[] } = {}) {
    const w = bedWorld();
    placeBed(w, 0);
    const sent: { to: number; msg: ServerMessage }[] = [];
    let skipped = -1;
    const beds: Record<string, unknown> = {};
    const host: SurvivalHost = {
      send: (to, msg) => sent.push({ to, msg }),
      broadcast: (msg) => sent.push({ to: -1, msg }),
      getBlock: w.getBlock, getMeta: w.getMeta,
      mobs: () => (opts.mobs ?? []) as never,
      dayFactor: () => opts.day ?? 0,
      thundering: () => false,
      skipNight: (t) => { skipped = t; },
      setBed: (name, bed) => { beds[name] = bed; },
    };
    const s = new ServerSurvival(host);
    return { s, sent, beds, skipped: () => skipped };
  }
  const alice = { id: 1, name: 'Alice', x: 0.5, y: 64, z: 2.5, hasPos: true };
  const bob = { id: 2, name: 'Bob', x: 5, y: 64, z: 5, hasPos: true };

  it('sets the respawn point by day but refuses to sleep', () => {
    const { s, sent, beds } = setup({ day: 1 });
    s.bed(alice, 0, 64, 0, 1);
    expect(beds.Alice).toEqual({ x: 0, y: 64, z: 0 });
    const texts = sent.map((m) => (m.msg.t === 'chat' ? m.msg.text : m.msg.t));
    expect(texts).toContain(MSG.respawnSet);
    expect(texts).toContain(MSG.notNight);
    expect(s.sleeping).toBe(0);
  });

  it('refuses with monsters near the bed', () => {
    const { s, sent } = setup({ mobs: [{ x: 3, y: 64, z: 3, dead: false, type: { hostile: true } }] });
    s.bed(alice, 0, 64, 0, 1);
    expect(sent.some((m) => m.msg.t === 'chat' && m.msg.text === MSG.monsters)).toBe(true);
    expect(s.sleeping).toBe(0);
  });

  it('skips the night only when everybody slept 100 ticks (default 100 %)', () => {
    const { s, skipped } = setup();
    s.bed(alice, 0, 64, 0, 2);
    expect(s.sleeping).toBe(1);
    for (let i = 0; i < SLEEP_TICKS + 5; i++) s.tick([alice, bob]);
    expect(skipped()).toBe(-1);
    s.rules.set('playersSleepingPercentage', 50);
    s.tick([alice, bob]);
    expect(skipped()).toBeGreaterThanOrEqual(0);
    expect(s.sleeping).toBe(0);
  });

  it('wakes a sleeper who walks away', () => {
    const { s } = setup();
    s.bed(alice, 0, 64, 0, 1);
    s.tick([{ ...alice, x: 10 }]);
    expect(s.sleeping).toBe(0);
  });

  it('ignores beds out of reach and non-bed blocks', () => {
    const { s, beds } = setup();
    s.bed({ ...alice, x: 40 }, 0, 64, 0, 1);
    s.bed(alice, 3, 63, 3, 1);
    expect(beds).toEqual({});
  });

  it('saves only what differs from the defaults', () => {
    const { s } = setup();
    const data: { difficulty?: Difficulty; rules?: Record<string, boolean | number> } = {};
    s.save(data);
    expect(data).toEqual({});
    s.difficulty = 'hard';
    s.rules.set('keepInventory', true);
    s.save(data);
    expect(data).toEqual({ difficulty: 'hard', rules: { keepInventory: true } });
    const back = setup().s;
    back.load(data);
    expect(back.difficulty).toBe('hard');
    expect(back.rules.get('keepInventory')).toBe(true);
    back.load({});
    expect(back.difficulty).toBe(DEFAULT_DIFFICULTY);
  });
});

describe('commands: /difficulty, /gamerule, /effect, /spawnpoint', () => {
  function host(over: Partial<CommandHost> = {}) {
    const replies: string[] = [];
    const effects: unknown[][] = [];
    let difficulty: Difficulty = 'normal';
    const rules = new GameRules();
    let changed = 0;
    const h: CommandHost = {
      mod: emptyModeration(), arcade: false, gameMode: 'survival', moderated: true,
      online: () => [], find: (n) => ({ name: n, op: false, owner: false, x: 0, y: 0, z: 0 }),
      reply: (_to, t) => replies.push(t), broadcastSystem: (t) => replies.push(t), say: () => undefined,
      kick: () => undefined, ban: () => undefined, unban: () => false, setOp: () => undefined, save: () => undefined,
      teleport: () => undefined, setGameMode: () => undefined, setTime: () => undefined,
      give: () => true, seed: () => 1, spawn: () => undefined,
      survival: { get difficulty() { return difficulty; }, setDifficulty: (d) => { difficulty = d; }, rules, rulesChanged: () => { changed++; } },
      setSpawnpoint: () => true,
      effect: (...a) => { effects.push(a); return true; },
      ...over,
    };
    return { h, replies, effects, rules, getDifficulty: () => difficulty, changed: () => changed };
  }
  const op = { name: 'Op', op: true, owner: false };
  const player = { name: 'Pat', op: false, owner: false };

  it('lets operators change the difficulty and rules', () => {
    const t = host();
    runCommand(t.h, op, '/difficulty hard');
    expect(t.getDifficulty()).toBe('hard');
    runCommand(t.h, op, '/gamerule keepInventory true');
    expect(t.rules.get('keepInventory')).toBe(true);
    expect(t.changed()).toBe(1);
    runCommand(t.h, player, '/difficulty peaceful');
    expect(t.getDifficulty()).toBe('hard');
  });

  it('keeps Hardcore at Hard', () => {
    const t = host({ gameMode: 'hardcore' });
    runCommand(t.h, op, '/difficulty easy');
    expect(t.getDifficulty()).toBe('normal');
    expect(t.replies.at(-1)).toContain('Hardcore');
  });

  it('/effect: operators always, everybody in creative', () => {
    const t = host();
    runCommand(t.h, player, '/effect give Pat speed 10 2');
    expect(t.effects.length).toBe(0);
    runCommand(t.h, op, '/effect give Pat speed 10 2');
    expect(t.effects[0]).toEqual(['Pat', 'give', 'speed', 1, 200]);
    const c = host({ gameMode: 'creative' });
    runCommand(c.h, player, '/effect clear Pat');
    expect(c.effects[0]).toEqual(['Pat', 'clear', undefined]);
    runCommand(c.h, player, '/effect give Pat nonsense');
    expect(c.replies.at(-1)).toContain('Unknown effect');
  });

  it('/spawnpoint sets the respawn point', () => {
    const t = host();
    runCommand(t.h, op, '/spawnpoint');
    expect(t.replies.at(-1)).toContain('spawn point');
  });
});
