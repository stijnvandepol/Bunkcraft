import { describe, expect, it } from 'vitest';
import { GAME_TYPES, GUN_GAME_LADDER, gameTypeDef } from '../src/modes/GameTypes';
import { WEAPONS, weaponDef } from '../src/modes/Weapons';
import { ENDED_SECONDS, WARMUP_SECONDS } from '../server/Match';
import { createLogic } from '../server/modes';
import { live, place, setup, shootDead, started } from './helpers/matchHost';

describe('mode registry', () => {
  it('every arcade type has a logic class, options, respawn and loadout rules', () => {
    for (const def of GAME_TYPES.filter((d) => d.arcade)) {
      expect(def.logic, def.id).toBeDefined();
      expect(createLogic(def), def.id).toBeDefined();
      expect(def.options?.time.length, def.id).toBeGreaterThan(0);
      expect(def.options!.time).toContain(def.timeLimitSec);
      if (def.options!.score.length) expect(def.options!.score).toContain(def.scoreLimit);
      expect(def.respawn, def.id).toBeDefined();
      expect(def.hud?.length, def.id).toBeGreaterThan(0);
    }
  });

  it('round modes have a round structure, objective modes say what map data they need', () => {
    expect(gameTypeDef('elimination').rounds).toBeDefined();
    expect(gameTypeDef('hardpoint').requires).toEqual(['zones']);
    expect(gameTypeDef('domination').requires).toEqual(['zones']);
    expect(gameTypeDef('ctf').requires).toEqual(['flags']);
  });
});

describe('gun game', () => {
  it('has a 14-20 step ladder from Weapons.ts that ends with the knife, no sniper/shotgun back to back', () => {
    expect(GUN_GAME_LADDER.length).toBeGreaterThanOrEqual(14);
    expect(GUN_GAME_LADDER.length).toBeLessThanOrEqual(20);
    expect(GUN_GAME_LADDER[GUN_GAME_LADDER.length - 1]).toBe('knife');
    for (const id of GUN_GAME_LADDER) expect(weaponDef(id), id).toBeDefined();
    const chance = new Set(['sniper', 'shotgun']);
    for (let i = 1; i < GUN_GAME_LADDER.length; i++) {
      expect(chance.has(GUN_GAME_LADDER[i]) && chance.has(GUN_GAME_LADDER[i - 1])).toBe(false);
    }
    // Every gun of the arsenal shows up.
    for (const w of WEAPONS) expect(GUN_GAME_LADDER).toContain(w.id);
    expect(gameTypeDef('gungame').scoreLimit).toBe(GUN_GAME_LADDER.length);
  });

  it('starts everyone on the first weapon with only a knife besides it, and ignores loadout choices', () => {
    const s = started('gungame', 2);
    s.match.setLoadout(1, 'sniper');
    const p = s.match.players.get(1)!;
    expect(p.slots.map((x) => x.def.id)).toEqual([GUN_GAME_LADDER[0], 'knife', 'knife']);
    expect(s.host.of('spawn', 1).at(-1)).toMatchObject({ primary: GUN_GAME_LADDER[0], secondary: 'knife' });
  });

  it('a kill moves the killer up at once (gear message), the roster shows the level', () => {
    const s = live('gungame', 2);
    s.host.clear();
    shootDead(s, 1, 2);
    const p1 = s.match.players.get(1)!;
    expect(p1.pts).toBe(1);
    expect(p1.slots[0].def.id).toBe(GUN_GAME_LADDER[1]);
    expect(s.host.of('gear', 1).at(-1)).toMatchObject({ primary: GUN_GAME_LADDER[1] });
    expect(s.host.events('level-up')).toHaveLength(1);
    expect(s.host.of('roster').at(-1)!.players.find((r) => r.id === 1)!.pts).toBe(1);
  });

  it('a knife kill sets the victim back a level, never below the first', () => {
    const s = live('gungame', 2);
    const p2 = s.match.players.get(2)!;
    p2.pts = 3;
    shootDead(s, 1, 2, 2);
    expect(p2.pts).toBe(2);
    expect(s.host.events('level-down')).toHaveLength(1);
    s.advance(2); // respawn 1.5 s
    expect(p2.alive).toBe(true);
    expect(p2.slots[0].def.id).toBe(GUN_GAME_LADDER[2]);
    // At level 0 nothing is lost.
    const p1 = s.match.players.get(1)!;
    p1.pts = 0;
    s.match.players.get(2)!.protectedUntil = 0;
    shootDead(s, 2, 1, 2);
    expect(p1.pts).toBe(0);
  });

  it('a kill with the last weapon (the knife) finishes the ladder and wins', () => {
    const s = live('gungame', 2);
    const p1 = s.match.players.get(1)!;
    p1.pts = GUN_GAME_LADDER.length - 1;
    s.match.giveGear(p1, 'knife', 'knife', 'knife');
    s.advance(0.3);
    shootDead(s, 1, 2, 0);
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerId: 1, winnerTeam: '' });
  });

  it('on time the highest level wins', () => {
    const s = live('gungame', 3, undefined, 120);
    s.match.players.get(3)!.pts = 5;
    s.match.players.get(2)!.pts = 2;
    s.advance(125);
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerId: 3 });
  });

  it('respawns after 1.5 s with 1 s of spawn protection', () => {
    const s = live('gungame', 2);
    shootDead(s, 1, 2);
    const p2 = s.match.players.get(2)!;
    expect(p2.respawnAt - s.host.t).toBeLessThanOrEqual(1.5);
    s.advance(1.6);
    expect(p2.alive).toBe(true);
    expect(p2.protectedUntil - s.host.t).toBeLessThanOrEqual(1);
  });
});

describe('team elimination', () => {
  const ROUND = gameTypeDef('elimination').rounds!;
  const toLive = (s: ReturnType<typeof started>) => s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);

  it('waits for both teams, then runs intermission → countdown → live, without damage before live', () => {
    const s = started('elimination', 2);
    expect(s.match.phase).toBe('intermission');
    expect(s.host.events('round-start')).toHaveLength(1);
    s.advance(ROUND.intermissionSec + 0.1);
    expect(s.match.phase).toBe('countdown');
    s.advance(ROUND.countdownSec + 0.1);
    expect(s.match.phase).toBe('live');
    expect(s.host.of('mode').at(-1)!.state).toMatchObject({ kind: 'rounds', round: 1, need: 4 });
  });

  it('one life per round: the dead stay dead, wiping the other team wins the round', () => {
    const s = started('elimination', 4);
    toLive(s);
    const blue = [...s.match.players.values()].filter((p) => p.team === 'blue');
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    shootDead(s, red.id, blue[0].id);
    s.advance(5);
    expect(blue[0].alive).toBe(false); // no respawn in a round
    expect(s.match.phase).toBe('live');
    shootDead(s, red.id, blue[1].id);
    expect(s.match.phase).toBe('roundend');
    expect(s.match.scores).toEqual({ red: 1, blue: 0 });
    expect(s.host.events('round-win').at(-1)).toMatchObject({ team: 'red' });
    // Next round: everybody alive again.
    s.advance(ROUND.postSec + 0.1);
    expect(s.match.phase).toBe('intermission');
    expect(blue.every((p) => p.alive)).toBe(true);
  });

  it('on the round timer the team with more survivors wins, equal is a draw', () => {
    const s = started('elimination', 4, 4, 60);
    toLive(s);
    const blue = [...s.match.players.values()].filter((p) => p.team === 'blue');
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    shootDead(s, red.id, blue[0].id);
    s.advance(61);
    expect(s.match.scores.red).toBe(1);
    s.advance(ROUND.postSec + ROUND.intermissionSec + ROUND.countdownSec + 0.3);
    expect(s.match.phase).toBe('live');
    s.advance(61);
    expect(s.match.scores).toEqual({ red: 1, blue: 0 }); // draw
  });

  it('first team to the round limit wins the match; then a fresh match', () => {
    const s = started('elimination', 2, 2);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    for (let r = 0; r < 2; r++) {
      toLive(s);
      shootDead(s, red.id, blue.id);
      if (r === 0) s.advance(ROUND.postSec + 0.1);
    }
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: 'red' });
    s.advance(ENDED_SECONDS + 0.2);
    expect(s.match.phase).toBe('warmup');
    s.advance(WARMUP_SECONDS + 0.2);
    expect(s.match.phase).toBe('intermission');
    expect(s.match.scores).toEqual({ red: 0, blue: 0 });
  });

  it('a late joiner spectates until the next round; a team leaving entirely goes back to warm-up', () => {
    const s = started('elimination', 2);
    toLive(s);
    const late = s.match.join(9, 'late');
    s.match.ready(9);
    expect(late.alive).toBe(false);
    expect(s.host.of('hp', 9).at(-1)).toMatchObject({ health: 0 });
    const blue = [...s.match.players.values()].filter((p) => p.team === 'blue');
    for (const p of blue) s.match.leave(p.id);
    expect(s.match.phase).toBe('warmup');
  });
});

describe('hardpoint', () => {
  it('scores a point per second for the team alone in the hill, contested scores nothing', () => {
    const s = live('hardpoint', 2);
    const z = s.match.map.zones[0];
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    place(s, red.id, z.x, z.y, z.z);
    place(s, blue.id, 40, 65, -40);
    s.advance(10);
    expect(s.match.scores.red).toBeGreaterThanOrEqual(9);
    expect(s.match.scores.red).toBeLessThanOrEqual(11);
    const zs = s.host.of('mode').at(-1)!.state;
    expect(zs).toMatchObject({ kind: 'zones', variant: 'hardpoint' });
    if (zs.kind === 'zones') expect(zs.zones[0]).toMatchObject({ active: true, owner: 'red', red: 1, blue: 0 });
    const before = s.match.scores.red;
    place(s, blue.id, z.x + 1, z.y, z.z);
    s.advance(5);
    expect(s.match.scores.red).toBe(before);
    expect(s.match.scores.blue).toBe(0);
    const c = s.host.of('mode').at(-1)!.state;
    if (c.kind === 'zones') expect(c.zones[0].contested).toBe(true);
  });

  it('moves the hill every 60 s with a 5 s pause, in map order', () => {
    const s = live('hardpoint', 2);
    s.host.clear();
    s.advance(61);
    let st = s.host.of('mode').at(-1)!.state;
    expect(st.kind === 'zones' && st.gap).toBe(true);
    s.advance(5);
    expect(s.host.events('zone-moved').at(-1)!.text).toBe(s.match.map.zones[1].name);
    st = s.host.of('mode').at(-1)!.state;
    if (st.kind === 'zones') {
      expect(st.zones[1].active).toBe(true);
      expect(st.zones[0].active).toBe(false);
    }
    // Standing in the old hill scores nothing now.
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const z0 = s.match.map.zones[0];
    place(s, red.id, z0.x, z0.y, z0.z);
    s.advance(5);
    expect(s.match.scores.red).toBe(0);
  });

  it('the first team to the score limit wins', () => {
    const s = live('hardpoint', 2, 20);
    const z = s.match.map.zones[0];
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    place(s, blue.id, z.x, z.y, z.z);
    s.advance(25);
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: 'blue' });
  });
});

describe('domination', () => {
  it('captures a point in captureSec, neutralises before taking an owned point, owned points score', () => {
    const s = live('domination', 2);
    const z = s.match.map.zones[1];
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    place(s, blue.id, 40, 65, -40);
    place(s, red.id, z.x, z.y, z.z);
    s.advance(5);
    expect(s.host.events('zone-captured')).toHaveLength(0);
    s.advance(1.2);
    expect(s.host.events('zone-captured').at(-1)).toMatchObject({ team: 'red', text: z.name });
    // Owned point scores 1 per 2 s even when nobody stands there.
    place(s, red.id, 40, 65, 40);
    const before = s.match.scores.red;
    s.advance(10);
    expect(s.match.scores.red - before).toBeGreaterThanOrEqual(4);
    // Blue takes it: 6 s to neutralise, 6 s to capture.
    place(s, blue.id, z.x, z.y, z.z);
    s.advance(6.2);
    expect(s.host.events('zone-lost').at(-1)).toMatchObject({ team: 'red' });
    s.advance(6.2);
    expect(s.host.events('zone-captured').at(-1)).toMatchObject({ team: 'blue' });
  });
});

describe('capture the flag', () => {
  const flags = (s: ReturnType<typeof live>) => {
    const st = s.host.of('mode').at(-1)!.state;
    if (st.kind !== 'ctf') throw new Error('no ctf state');
    return st.flags;
  };

  it('picks the enemy flag up on touch, captures at the own flag while it is home', () => {
    const s = live('ctf', 2);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const [rf, bf] = [s.match.map.flags.find((f) => f.team === 'red')!, s.match.map.flags.find((f) => f.team === 'blue')!];
    place(s, blue.id, 0.5, 65, -40);
    place(s, red.id, bf.x, bf.y, bf.z);
    s.advance(0.3);
    expect(s.host.events('flag-taken').at(-1)).toMatchObject({ team: 'blue', id: red.id });
    expect(flags(s).find((f) => f.team === 'blue')).toMatchObject({ status: 'carried', carrier: red.id });
    // The flag follows the carrier.
    place(s, red.id, 0.5, 65, 0.5);
    s.advance(0.3);
    expect(flags(s).find((f) => f.team === 'blue')!.x).toBeCloseTo(0.5, 1);
    place(s, red.id, rf.x, rf.y, rf.z);
    s.advance(0.3);
    expect(s.host.events('flag-captured').at(-1)).toMatchObject({ team: 'red', id: red.id });
    expect(s.match.scores.red).toBe(1);
    expect(red.pts).toBe(1);
    expect(flags(s).every((f) => f.status === 'home')).toBe(true);
  });

  it('no capture while the own flag is away', () => {
    const s = live('ctf', 2);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const [rf, bf] = [s.match.map.flags.find((f) => f.team === 'red')!, s.match.map.flags.find((f) => f.team === 'blue')!];
    place(s, red.id, bf.x, bf.y, bf.z);
    place(s, blue.id, rf.x, rf.y, rf.z);
    s.advance(0.3);
    place(s, blue.id, 0.5, 65, 30);
    place(s, red.id, rf.x, rf.y, rf.z);
    s.advance(1);
    expect(s.match.scores.red).toBe(0);
  });

  it('a dead carrier drops the flag; the owner team returns it on touch, otherwise it returns by itself', () => {
    const s = live('ctf', 2);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const bf = s.match.map.flags.find((f) => f.team === 'blue')!;
    place(s, red.id, bf.x, bf.y, bf.z);
    s.advance(0.2);
    shootDead(s, blue.id, red.id);
    expect(s.host.events('flag-dropped').at(-1)).toMatchObject({ team: 'blue', id: red.id });
    const dropped = flags(s).find((f) => f.team === 'blue')!;
    expect(dropped.status).toBe('dropped');
    expect(dropped.returnIn).toBeGreaterThan(10);
    // Blue touches it: back home at once.
    place(s, blue.id, dropped.x, dropped.y, dropped.z);
    s.advance(0.2);
    expect(s.host.events('flag-returned').at(-1)).toMatchObject({ team: 'blue', id: blue.id });
    expect(flags(s).find((f) => f.team === 'blue')!.status).toBe('home');
    // Dropped again and left alone: returns after 12 s.
    s.advance(5);
    place(s, red.id, bf.x, bf.y, bf.z);
    s.advance(0.2);
    shootDead(s, blue.id, red.id);
    place(s, blue.id, 40, 65, -40);
    s.advance(12.5);
    expect(s.host.events('flag-returned').at(-1)).toMatchObject({ team: 'blue', text: 'timeout' });
  });

  it('three captures win', () => {
    const s = live('ctf', 2);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const [rf, bf] = [s.match.map.flags.find((f) => f.team === 'red')!, s.match.map.flags.find((f) => f.team === 'blue')!];
    place(s, blue.id, 0.5, 65, -40);
    for (let i = 0; i < 3; i++) {
      place(s, red.id, bf.x, bf.y, bf.z);
      s.advance(0.3);
      place(s, red.id, rf.x, rf.y, rf.z);
      s.advance(0.3);
    }
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: 'red' });
  });

  it('only maps with flags host it (the match falls back to one)', () => {
    const s = setup('ctf', undefined, undefined, false);
    expect(s.match.map.supports(['flags'])).toBe(true);
  });
});
