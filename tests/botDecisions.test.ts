import { describe, expect, it } from 'vitest';
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { NAME_PATTERN, type ModeState } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { Match, type MatchHost } from '../server/Match';
import { Bot, type BotEnv, pickClass } from '../server/bots/Bot';
import { BotAim, wrapAngle } from '../server/bots/BotAim';
import { BotManager, type BotHost, parseBotSettings } from '../server/bots/BotManager';
import { BOT_PREFIX, BOT_SKILLS, botName, skillFor } from '../server/bots/BotSkill';
import { arenaGraph } from '../server/bots/BotWorld';
import { NavGraph } from '../server/bots/NavGraph';
import { seeded } from './helpers/botDuel';

const DEG = Math.PI / 180;

describe('bot aim', () => {
  it('turns no faster than its turn speed (never an aimbot snap) and waits its reaction time', () => {
    const skill = BOT_SKILLS.veteran;
    const aim = new BotAim(skill, seeded(1));
    aim.acquire(7, 10);
    expect(aim.readyAt).toBeGreaterThanOrEqual(10 + skill.reaction * 0.75);
    const dt = 1 / 30;
    let prev = aim.yaw;
    // Target straight behind.
    for (let i = 0; i < 90; i++) {
      aim.track(dt, 0, 1.62, 0, 0, 1.1, 20, false, 0);
      const step = Math.abs(wrapAngle(aim.yaw - prev));
      expect(step).toBeLessThanOrEqual(skill.turnSpeed * DEG * dt + 1e-9);
      prev = aim.yaw;
    }
    // ...and ends up on it.
    expect(Math.abs(wrapAngle(aim.yaw - Math.PI))).toBeLessThan(4 * DEG);
  });

  it('the acquisition error settles to a steady wobble of about aimError', () => {
    for (const d of ['easy', 'veteran'] as const) {
      const skill = BOT_SKILLS[d];
      const aim = new BotAim(skill, seeded(3));
      aim.acquire(1, 0);
      const dt = 1 / 30;
      let sum = 0, n = 0;
      for (let i = 0; i < 30 * 20; i++) {
        aim.track(dt, 0, 1.62, 0, 0, 1.62, -30, false, 0);
        if (i > 30 * 3) { sum += Math.abs(wrapAngle(aim.yaw)); n++; }
      }
      const mean = sum / n / DEG;
      expect(mean).toBeLessThan(skill.aimError * 1.6);
      expect(mean).toBeGreaterThan(skill.aimError * 0.2);
    }
  });

  it('a skill varies a little per bot, never beyond the turn cap', () => {
    const rng = seeded(9);
    for (let i = 0; i < 50; i++) {
      const s = skillFor('veteran', rng);
      expect(s.turnSpeed).toBeLessThan(600);
      expect(Math.abs(s.reaction / BOT_SKILLS.veteran.reaction - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });
});

describe('bot choices', () => {
  it('big maps get more long guns, small maps more close-range classes', () => {
    const rng = seeded(4);
    const count = (half: number) => {
      let long = 0, close = 0;
      for (let i = 0; i < 2000; i++) {
        const c = pickClass(half, rng, BOT_SKILLS.hard);
        if (c.primary === 'sniper' || c.primary === 'dmr') long++;
        if (c.primary === 'smg' || c.primary === 'shotgun') close++;
      }
      return { long, close };
    };
    const big = count(48), small = count(32);
    expect(big.long).toBeGreaterThan(small.long * 1.5);
    expect(small.close).toBeGreaterThan(big.close * 1.3);
  });

  it('bot names carry the [BOT] tag, are unique, and no player can take one', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const n = botName(taken, seeded(i));
      expect(n.startsWith(BOT_PREFIX)).toBe(true);
      expect(taken.has(n.toLowerCase())).toBe(false);
      expect(NAME_PATTERN.test(n)).toBe(false);
      taken.add(n.toLowerCase());
    }
  });

  it('lobby settings are clamped and defaulted', () => {
    expect(parseBotSettings(undefined, 12)).toBeUndefined();
    expect(parseBotSettings({ count: 0 }, 12)).toBeUndefined();
    expect(parseBotSettings({ count: 50, difficulty: 'godlike' }, 12)).toEqual({ count: 11, difficulty: 'normal' });
    expect(parseBotSettings({ fill: 8, difficulty: 'hard' }, 12)).toEqual({ fill: 8, difficulty: 'hard' });
    expect(parseBotSettings({ fill: 40 }, 6)).toEqual({ fill: 6, difficulty: 'normal' });
  });
});

/** A bare match with one bot in it, for decision tests. */
function setup(type: 'ctf' | 'hardpoint' | 'tdm', mapId: string, getBlock?: (x: number, y: number, z: number) => number) {
  const map = getMap(mapId);
  const get = getBlock ?? ((x: number, y: number, z: number) => map.blockAt(0, x, y, z));
  let now = 100;
  const sinks = new Map<number, Bot>();
  const host: MatchHost = {
    now: () => now, send: (id, msg) => sinks.get(id)?.onMessage(msg, now), broadcast: () => {}, blocks: { getBlock: get },
    moveTo: () => {}, random: seeded(2), ping: () => 0,
  };
  const match = new Match(host, { type, scoreLimit: 100, timeLimitSec: 600, map: map.id });
  const graph = getBlock
    ? new NavGraph({ getBlock: get, bounds: map.bounds, inBounds: (x, z) => map.inBounds(x, z), floorY: ARENA_FLOOR_Y, maxHeight: 4 })
    : arenaGraph(map, 0, get);
  const env: BotEnv = { match, graph, blocks: { getBlock: get }, getBlock: get, rng: seeded(5), send: () => {}, mode: null, pathTokens: 99, heard: [] };
  const bot = new Bot(1, '[BOT] T', BOT_SKILLS.hard, env, 0, 1 / 30);
  sinks.set(1, bot);
  match.join(1, bot.name);
  match.join(2, 'Enemy');
  match.ready(1);
  const me = match.players.get(1)!;
  return { match, env, bot, me, graph, setNow: (t: number) => { now = t; } };
}

describe('bot decisions', () => {
  it('capture the flag: the carrier runs home, the others go for the enemy flag', () => {
    const { env, bot, me, graph, match } = setup('ctf', 'atomic');
    const [red, blue] = match.map.flags[0].team === 'red' ? match.map.flags : [...match.map.flags].reverse();
    const own = me.team === 'red' ? red : blue, enemy = me.team === 'red' ? blue : red;
    const flag = (f: typeof red, status: 'home' | 'carried', carrier = 0) => ({ team: f.team, status, x: f.x, y: f.y, z: f.z, carrier, returnIn: 0, hx: f.x, hy: f.y, hz: f.z });
    env.mode = { kind: 'ctf', flags: [flag(own, 'home'), flag(enemy, 'home')] } as ModeState;
    const objective = (bot as unknown as { objective(now: number, me: unknown): { node: number; urgent: boolean } }).objective.bind(bot);
    expect(objective(100, me).node).toBe(graph.nodeAt(enemy.x, enemy.y, enemy.z));
    env.mode = { kind: 'ctf', flags: [flag(own, 'home'), flag(enemy, 'carried', me.id)] } as ModeState;
    const home = objective(100, me);
    expect(home.node).toBe(graph.nodeAt(own.x, own.y, own.z));
    expect(home.urgent).toBe(true);
  });

  it('hardpoint: bots head for the live hill and spread out inside it', () => {
    const { env, bot, me, match, graph } = setup('hardpoint', 'atomic');
    const zones = match.map.zones;
    env.mode = {
      kind: 'zones', variant: 'hardpoint', rotateIn: 30, gap: false,
      zones: zones.map((z, i) => ({ name: z.name, x: z.x, y: z.y, z: z.z, r: z.r, active: i === 1, owner: '', progress: 0, progressTeam: '', contested: false, red: 0, blue: 0 })),
    } as ModeState;
    const objective = (bot as unknown as { objective(now: number, me: unknown): { node: number } }).objective.bind(bot);
    const n = objective(100, me).node;
    expect(Math.hypot(graph.nx[n] - zones[1].x, graph.nz[n] - zones[1].z)).toBeLessThanOrEqual(zones[1].r);
  });

  it('retreat: the cover it picks is out of the threat\'s sight', () => {
    // A yard with one wall: the threat stands on one side.
    const map = getMap('classic');
    const wall = (x: number, y: number, z: number) => {
      if (!map.inBounds(x + 0.5, z + 0.5)) return y <= ARENA_FLOOR_Y + 3 ? BLOCK.STONE : BLOCK.AIR;
      if (y <= ARENA_FLOOR_Y) return BLOCK.STONE;
      return x === 3 && z >= -4 && z <= 4 && y <= ARENA_FLOOR_Y + 3 ? BLOCK.STONE : BLOCK.AIR;
    };
    const { bot, graph } = setup('tdm', 'classic', wall);
    bot.mover.reset(0.5, ARENA_FLOOR_Y + 1, 0.5);
    const cover = (bot as unknown as { findCover(t: { x: number; y: number; z: number }): number }).findCover({ x: -12.5, y: ARENA_FLOOR_Y + 1, z: 0.5 });
    expect(cover).toBeGreaterThanOrEqual(0);
    expect(graph.nx[cover]).toBeGreaterThan(3); // behind the wall
    expect(Math.abs(graph.nz[cover])).toBeLessThan(5);
  });
});

describe('bot manager', () => {
  function fakeHost(humans: number, capacity: number): BotHost {
    const match = new Match({ now: () => 0, send: () => {}, broadcast: () => {}, blocks: { getBlock: () => 0 }, moveTo: () => {}, random: Math.random, ping: () => 0 },
      { type: 'tdm', scoreLimit: 10, timeLimitSec: 60, map: 'classic' });
    return {
      match, tickHz: 30, now: () => 0, graph: () => { throw new Error('unused'); }, getBlock: () => 0,
      humans: () => humans, capacity: () => capacity, names: () => new Set(), addBot: () => null, removeBot: () => {}, deliver: () => {}, random: Math.random,
    };
  }

  it('quick play fills to the target, a fixed count stays fixed, people always keep their seats', () => {
    expect(new BotManager(fakeHost(1, 12), { fill: 8 }).desired()).toBe(7);
    expect(new BotManager(fakeHost(3, 12), { fill: 8 }).desired()).toBe(5);
    expect(new BotManager(fakeHost(9, 12), { fill: 8 }).desired()).toBe(0);
    expect(new BotManager(fakeHost(0, 12), { fill: 8 }).desired()).toBe(0);
    expect(new BotManager(fakeHost(2, 12), { count: 3 }).desired()).toBe(3);
    expect(new BotManager(fakeHost(3, 4), { count: 3 }).desired()).toBe(1);
    expect(new BotManager(fakeHost(1, 12), undefined).desired()).toBe(0);
  });
});
