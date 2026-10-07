import { expect } from 'vitest';
import type { GameType, MapFeature } from '../../src/modes/GameTypes';
import { type ArenaMapDef, ArenaMap } from '../../src/modes/maps/ArenaMap';
import { CLASSIC } from '../../src/modes/maps/classic';
import type { ClientMessage, MatchInfo, ServerMessage } from '../../src/net/protocol';
import { BLOCK } from '../../src/world/BlockRegistry';
import { Match, type MatchHost, SPAWN_PROTECTION, WARMUP_SECONDS } from '../../server/Match';

export type Fire = Extract<ClientMessage, { t: 'fire' }>;

/** A fake host: a controllable clock, recorded messages, no randomness (no bullet spread). */
export class StubHost implements MatchHost {
  t = 1000;
  /** Everything sent, in order: `id` 0 = broadcast. */
  log: { id: number; msg: ServerMessage }[] = [];
  blockMap = new Map<string, number>();
  blocks = { getBlock: (x: number, y: number, z: number) => this.blockMap.get(`${x},${y},${z}`) ?? BLOCK.AIR };
  moved: number[] = [];
  nextMap?: (current: string, requires?: readonly MapFeature[]) => string | null;
  rng = () => 0;

  now() { return this.t; }
  send(id: number, msg: ServerMessage) { this.log.push({ id, msg }); }
  broadcast(msg: ServerMessage) { this.log.push({ id: 0, msg }); }
  random() { return this.rng(); }
  ping() { return 0; }
  moveTo(id: number) { this.moved.push(id); }

  of<T extends ServerMessage['t']>(t: T, id?: number): Extract<ServerMessage, { t: T }>[] {
    return this.log.filter((s) => s.msg.t === t && (id === undefined || s.id === 0 || s.id === id)).map((s) => s.msg) as Extract<ServerMessage, { t: T }>[];
  }

  /** `event` messages of a kind. */
  events(kind: string) {
    return this.of('event').filter((e) => e.kind === kind);
  }

  clear() { this.log = []; }
}

/**
 * The classic arena with objectives for the tests: three zones (centre, one per flank) and a flag per
 * team, so the mode tests do not depend on what the shipped maps define.
 */
export function objectiveMap(): ArenaMap {
  const def: ArenaMapDef = {
    ...CLASSIC,
    id: 'classic',
    objectives: {
      zones: [
        { name: 'Centre', x: 0, z: 0, r: 5 },
        { name: 'Red flank', x: -30, z: 20, r: 5 },
        { name: 'Blue flank', x: 30, z: 20, r: 5 },
      ],
      flags: [{ team: 'red', x: -36, z: 12 }, { team: 'blue', x: 36, z: 12 }],
    },
  };
  return new ArenaMap(def);
}

export interface Setup {
  host: StubHost;
  match: Match;
  advance(sec: number, step?: number): void;
}

export function setup(type: GameType, scoreLimit?: number, timeLimitSec?: number, objectives = true): Setup {
  const host = new StubHost();
  const info: MatchInfo = { type, scoreLimit: scoreLimit ?? defaultScore(type), timeLimitSec: timeLimitSec ?? defaultTime(type) };
  const match = new Match(host, info);
  if (objectives) match.map = objectiveMap();
  const advance = (sec: number, step = 0.05) => {
    for (let t = 0; t < sec - 1e-9; t += step) { host.t += step; match.tick(); }
  };
  return { host, match, advance };
}

import { gameTypeDef } from '../../src/modes/GameTypes';
const defaultScore = (type: GameType) => gameTypeDef(type).scoreLimit;
const defaultTime = (type: GameType) => gameTypeDef(type).timeLimitSec;

/** Players 1..n joined and ready; the warm-up has run out. Returns the setup. */
export function started(type: GameType, n = 2, scoreLimit?: number, timeLimitSec?: number): Setup {
  const s = setup(type, scoreLimit, timeLimitSec);
  for (let id = 1; id <= n; id++) { s.match.join(id, `p${id}`); s.match.ready(id); }
  s.advance(WARMUP_SECONDS + 0.2);
  return s;
}

/** Like `started`, and the spawn protection is over too (a plain live match). */
export function live(type: GameType, n = 2, scoreLimit?: number, timeLimitSec?: number): Setup {
  const s = started(type, n, scoreLimit, timeLimitSec);
  s.advance(SPAWN_PROTECTION + 0.3);
  return s;
}

export function place(s: Setup, id: number, x: number, y: number, z: number): void {
  s.match.setPosition(id, x, y, z, 0, 0);
}

/** A fire message from the shooter's eye at a point. */
export function aim(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, slot: 0 | 1 | 2 = 0): Fire {
  const ox = from.x, oy = from.y + 1.62, oz = from.z;
  return { t: 'fire', slot, ox, oy, oz, dx: to.x - ox, dy: to.y - oy, dz: to.z - oz, ads: false };
}

/**
 * Kills `victimId` with real shots from `killerId` in `slot`, standing 2.5 blocks away (inside the
 * knife's reach and the shotgun's one-shot range). Both are put on open floor away from objectives.
 */
export function shootDead(s: Setup, killerId: number, victimId: number, slot: 0 | 1 | 2 = 0): void {
  const k = s.match.players.get(killerId)!, v = s.match.players.get(victimId)!;
  const base = { x: 0.5, y: 65, z: -40.5 };
  place(s, killerId, base.x, base.y, base.z);
  place(s, victimId, base.x, base.y, base.z + 2.5);
  v.protectedUntil = 0;
  s.advance(0.5);
  if (k.slot !== slot) { s.match.switchWeapon(killerId, slot); s.advance(0.3); }
  for (let i = 0; i < 30 && v.alive; i++) {
    place(s, victimId, base.x, base.y, base.z + 2.5);
    s.match.fire(killerId, aim(k, { x: base.x, y: 65.9, z: base.z + 2.5 }, slot));
    s.advance(0.7);
  }
  expect(v.alive, 'victim should be dead').toBe(false);
}
