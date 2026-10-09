import { ARENA_FLOOR_Y } from '../../src/modes/maps';
import { BLOCK } from '../../src/world/BlockRegistry';
import type { ServerMessage } from '../../src/net/protocol';
import { Match, type MatchHost } from '../../server/Match';
import { Bot, type BotEnv } from '../../server/bots/Bot';
import type { BotSkill } from '../../server/bots/BotSkill';
import { NavGraph } from '../../server/bots/NavGraph';

/** Seeded uniform random numbers (mulberry32): duels are reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An open yard (floor only), HALF blocks from the centre each way. */
const HALF = 30;
const yard = (x: number, y: number, z: number) => (Math.abs(x + 0.5) > HALF || Math.abs(z + 0.5) > HALF ? BLOCK.AIR : y <= ARENA_FLOOR_Y ? BLOCK.STONE : BLOCK.AIR);
let yardGraph: NavGraph | null = null;

/** One kill in a duel: the victim's time from its first damage to its death (first hit to death), the hits it took, whether they came as one burst (no pause over 0.6 s: a kill from full health, the time a player has to react) and whether any was a headshot. */
export interface KillSample { killer: number; ttk: number; chained: boolean; hits: number; head: boolean; weapon: string }
/** Hits further apart than this (seconds) belong to different bursts of fire. */
const BURST_GAP = 0.6;

export interface DuelResult { a: number; b: number; draws: number; kills: KillSample[]; lifeSec: number[] }

/**
 * Simulated duels between two aim profiles: rounds on an open yard, both players at full health a random
 * 10-40 blocks apart, facing roughly (±60°) towards each other, fighting until one dies (or 12 s pass: a
 * draw). Real `Match` combat (spread, damage falloff, hitboxes, recoil kicks) and the real bot code
 * (noticing, strafing, aim, fire discipline); the same class for both, so only the skill differs.
 */
export function duel(a: BotSkill, b: BotSkill, o: { rounds: number; seed: number; primary?: string; primaryB?: string; optic?: string; dist?: number }): DuelResult {
  const rng = seeded(o.seed);
  yardGraph ??= new NavGraph({ getBlock: yard, bounds: { minX: -HALF - 1, maxX: HALF + 1, minZ: -HALF - 1, maxZ: HALF + 1 }, inBounds: (x, z) => Math.abs(x) < HALF - 1 && Math.abs(z) < HALF - 1, floorY: ARENA_FLOOR_Y, maxHeight: 3 });
  let now = 1000;
  const bots = new Map<number, Bot>();
  const taken = new Map<number, { first: number; last: number; broken: boolean; hits: number; head: boolean }>();
  const kills: KillSample[] = [];
  const host: MatchHost = {
    now: () => now,
    send: (id, msg) => {
      if (msg.t === 'hit') {
        const rec = taken.get(msg.victim) ?? { first: now, last: now, broken: false, hits: 0, head: false };
        if (now - rec.last > BURST_GAP) rec.broken = true;
        rec.last = now; rec.hits++; rec.head ||= msg.head === true;
        taken.set(msg.victim, rec);
        if (msg.killed) {
          const killer = match.players.get(id);
          kills.push({ killer: id - 1, ttk: now - rec.first, chained: !rec.broken, hits: rec.hits, head: rec.head, weapon: killer?.primary ?? '' });
          taken.delete(msg.victim);
        }
      }
      bots.get(id)?.onMessage(msg, now);
    },
    broadcast: (msg: ServerMessage, except) => { for (const [id, bot] of bots) if (id !== except) bot.onMessage(msg, now); },
    blocks: { getBlock: yard },
    moveTo: () => {},
    random: rng,
    ping: () => 0,
    interpDelay: 0.066,
  };
  const match = new Match(host, { type: 'ffa', scoreLimit: 100_000, timeLimitSec: 1_000_000, map: 'classic' });
  const env: BotEnv = {
    match, graph: yardGraph, blocks: { getBlock: yard }, getBlock: yard, rng,
    mode: null, pathTokens: 3, heard: [],
    send: (id, msg) => {
      switch (msg.t) {
        case 'pos': match.setPosition(id, msg.x, msg.y, msg.z, msg.yaw, msg.pitch); break;
        case 'fire': match.fire(id, msg); break;
        case 'reload': match.reload(id, msg.slot); break;
        case 'weapon': match.switchWeapon(id, msg.slot); break;
        case 'loadout': match.setLoadout(id, (id === 2 ? o.primaryB : undefined) ?? o.primary ?? 'rifle', 'pistol', o.optic ?? 'reddot', 'none'); break;
        default: break;
      }
    },
  };
  const skills = [a, b];
  for (let i = 0; i < 2; i++) {
    const id = i + 1;
    bots.set(id, new Bot(id, `P${i}`, skills[i], env, i, 1 / 30));
    match.join(id, `P${i}`);
    match.ready(id);
  }
  const dt = 1 / 30;
  const tick = () => {
    now += dt;
    env.pathTokens = 3;
    for (const bot of bots.values()) bot.tick(now, true);
    match.tick();
    while (env.heard.length && now - env.heard[0].t > 2) env.heard.shift();
  };
  // Warm-up: classes applied, the match goes live.
  for (let t = 0; t < 12; t += dt) tick();
  const result: DuelResult = { a: 0, b: 0, draws: 0, kills, lifeSec: [] };
  for (let r = 0; r < o.rounds; r++) {
    const d = o.dist ?? 10 + rng() * 30, ang = rng() * Math.PI * 2;
    const cx = (rng() - 0.5) * 6, cz = (rng() - 0.5) * 6;
    const pos = [[cx - Math.sin(ang) * d / 2, cz - Math.cos(ang) * d / 2], [cx + Math.sin(ang) * d / 2, cz + Math.cos(ang) * d / 2]];
    for (let i = 0; i < 2; i++) {
      const id = i + 1;
      const p = match.players.get(id)!;
      match.respawn(p, now);
      const [x, z] = pos[i], [ox, oz] = pos[1 - i];
      const facing = Math.atan2(-(ox - x), -(oz - z)) + (rng() - 0.5) * (Math.PI / 1.5);
      p.x = x; p.y = ARENA_FLOOR_Y + 1; p.z = z; p.protectedUntil = 0;
      bots.get(id)!.onMessage({ t: 'spawn', x, y: p.y, z, yaw: facing, team: '', primary: p.primary, health: 100 }, now);
    }
    const k0 = [match.players.get(1)!.kills, match.players.get(2)!.kills];
    let winner = -1;
    taken.clear();
    let t = 0;
    for (; t < 12 && winner < 0; t += dt) {
      tick();
      if (match.players.get(1)!.kills > k0[0]) winner = 0;
      else if (match.players.get(2)!.kills > k0[1]) winner = 1;
    }
    if (winner >= 0) result.lifeSec.push(t);
    if (winner === 0) result.a++; else if (winner === 1) result.b++; else result.draws++;
  }
  return result;
}
