import { describe, expect, it } from 'vitest';
import { gameTypeDef } from '../src/modes/GameTypes';
import type { SndLogic } from '../server/modes/snd';
import type { ConfirmLogic } from '../server/modes/confirm';
import { live, place, shootDead, started } from './helpers/matchHost';

/** Regression tests for edge cases of the game modes (found by reading the mode logic against the rules). */
describe('search and destroy edge cases', () => {
  const DEF = gameTypeDef('snd');
  const ROUND = DEF.rounds!;
  const P = DEF.params!;

  it('two attackers finishing a plant on both sites in the same tick plant one bomb only', () => {
    const s = started('snd', 4);
    s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
    const logic = s.match.logic as SndLogic;
    const att = [...s.match.players.values()].filter((p) => p.team === logic.attackers);
    const def = [...s.match.players.values()].filter((p) => p.team !== logic.attackers);
    def.forEach((d, i) => place(s, d.id, -40 + i * 3, 65, -40));
    const [a, b] = s.match.map.sites;
    place(s, att[0].id, a.x, a.y, a.z);
    place(s, att[1].id, b.x, b.y, b.z);
    s.advance(P.plantSec + 0.2);
    expect(logic.siteRuns.filter((r) => r.planted)).toHaveLength(1);
    expect(s.host.events('bomb-planted')).toHaveLength(1);
    expect(att[0].pts + att[1].pts).toBe(1);
  });
});

/**
 * A match whose players all dropped (kept seats only) stands still (Match.tick): the mode's own clocks must stand
 * still with it, or the hill moves on, flags return and the outbreak happens while nobody is there.
 */
describe('mode clocks stand still while only kept seats are left', () => {
  const keep = (token: string) => ({ proof: { token }, graceSec: 600, limit: 6 });
  const dropAllAndReturn = (s: ReturnType<typeof live>, ids: number[], away: number) => {
    const seats = ids.map((id) => s.match.leave(id, keep(`t${id}`))!);
    s.advance(away, 0.25);
    for (const seat of seats) { s.match.join(seat.id, seat.name, false, { restore: s.match.parked.get(seat.id) }); s.match.ready(seat.id); }
    s.advance(0.1);
  };
  const modeState = (s: ReturnType<typeof live>) => s.host.of('mode').at(-1)!.state;

  it('ctf: a dropped flag does not return while the match stands still', () => {
    const s = live('ctf', 2);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const bf = s.match.map.flags.find((f) => f.team === 'blue')!;
    place(s, blue.id, 0.5, 65, -40);
    place(s, red.id, bf.x, bf.y, bf.z);
    s.advance(0.3);
    place(s, red.id, 0.5, 65, 30);
    s.advance(0.3);
    s.match.leave(red.id, keep('r'));
    s.advance(0.05);
    const before = modeState(s);
    if (before.kind !== 'ctf') throw new Error('ctf');
    expect(before.flags.find((f) => f.team === 'blue')!.status).toBe('dropped');
    dropAllAndReturn(s, [blue.id], 60);
    s.match.join(red.id, red.name, false, { restore: s.match.parked.get(red.id) });
    s.advance(0.1);
    const after = modeState(s);
    if (after.kind !== 'ctf') throw new Error('ctf');
    expect(after.flags.find((f) => f.team === 'blue')!.status).toBe('dropped');
  });

  it('hardpoint: the hill timer does not run out while the match stands still', () => {
    const s = live('hardpoint', 2);
    s.advance(5);
    const st = modeState(s);
    if (st.kind !== 'zones') throw new Error('zones');
    const left = st.rotateIn;
    dropAllAndReturn(s, [1, 2], 200);
    const st2 = modeState(s);
    if (st2.kind !== 'zones') throw new Error('zones');
    expect(st2.gap).toBe(false);
    expect(st2.rotateIn).toBeGreaterThan(left - 1);
  });

  it('koth: the hill timer does not run out while the match stands still', () => {
    const s = live('koth', 2);
    s.advance(5);
    const st = modeState(s);
    if (st.kind !== 'zones') throw new Error('zones');
    dropAllAndReturn(s, [1, 2], 200);
    const st2 = modeState(s);
    if (st2.kind !== 'zones') throw new Error('zones');
    expect(st2.rotateIn).toBeGreaterThan(st.rotateIn - 1);
  });

  it('kill confirmed: a dog tag does not expire while the match stands still', () => {
    const s = live('killconfirmed', 2);
    shootDead(s, 1, 2);
    const logic = s.match.logic as ConfirmLogic;
    expect(logic.dropped).toHaveLength(1);
    place(s, 1, -40, 65, 40);
    dropAllAndReturn(s, [1, 2], (gameTypeDef('killconfirmed').params?.tagSec ?? 30) + 30);
    expect(logic.dropped).toHaveLength(1);
  });

  it('sharpshooter: the weapon rotation does not run while the match stands still', () => {
    const s = live('sharpshooter', 2);
    const st = modeState(s);
    if (st.kind !== 'roulette') throw new Error('roulette');
    const rotations = s.host.events('weapon-rotate').length;
    dropAllAndReturn(s, [1, 2], 300);
    const st2 = modeState(s);
    if (st2.kind !== 'roulette') throw new Error('roulette');
    expect(s.host.events('weapon-rotate')).toHaveLength(rotations);
    expect(st2.switchIn).toBeGreaterThan(st.switchIn - 1);
    expect(st2.switchIn).toBeLessThanOrEqual(st.switchIn + 0.1);
  });
});

describe('hardpoint edge cases', () => {
  it('a hill that moved on is nobody\'s: its old owner does not show on the next-hill marker', () => {
    const s = live('hardpoint', 2);
    const P = gameTypeDef('hardpoint').params!;
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const z0 = s.match.map.zones[0];
    place(s, blue.id, -40, 65, -40);
    place(s, red.id, z0.x, z0.y, z0.z);
    s.advance(1);
    const st = s.host.of('mode').at(-1)!.state;
    if (st.kind !== 'zones') throw new Error('zones');
    expect(st.zones[0].owner).toBe('red');
    s.advance((P.rotateSec ?? 60) + 0.5);
    const gap = s.host.of('mode').at(-1)!.state;
    if (gap.kind !== 'zones') throw new Error('zones');
    expect(gap.gap).toBe(true);
    expect(gap.zones.every((z) => z.owner === '')).toBe(true);
  });
});

/**
 * A dropped connection keeps the seat, the team and the score (Match.parked). The round modes used to go straight back
 * to the warm-up when a side had nobody connected, which wiped every round won so far before the player could come back.
 */
describe('round modes keep the match for a player whose connection dropped', () => {
  const ROUND = gameTypeDef('elimination').rounds!;
  const keep = (token: string, graceSec = 120) => ({ proof: { token }, graceSec, limit: 6 });

  it('elimination 1v1: a drop holds the next round until the player is back, the round wins stay', () => {
    const s = started('elimination', 2, 4);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
    shootDead(s, red.id, blue.id);
    expect(s.match.scores.red).toBe(1);
    s.advance(ROUND.postSec + 0.2);
    s.match.leave(blue.id, keep('b'));
    s.advance(30);
    expect(s.match.phase).toBe('intermission');
    expect(s.match.scores.red).toBe(1);
    const back = s.match.join(blue.id, blue.name, false, { restore: s.match.parked.get(blue.id) });
    s.match.ready(blue.id);
    expect(back.team).toBe('blue');
    s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
    expect(s.match.phase).toBe('live');
    expect(s.match.scores.red).toBe(1);
  });

  it('elimination: a drop in the middle of a round loses that round, not the match', () => {
    const s = started('elimination', 2, 4);
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
    s.match.leave(blue.id, keep('b'));
    s.advance(0.1);
    expect(s.match.phase).toBe('roundend');
    expect(s.match.scores.red).toBe(1);
    s.advance(ROUND.postSec + 10);
    expect(s.match.phase).toBe('intermission');
    expect(s.match.scores.red).toBe(1);
  });

  it('elimination: when the kept seat runs out, the match goes back to the warm-up', () => {
    const s = started('elimination', 2, 4);
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    s.match.leave(blue.id, keep('b', 20));
    s.advance(10);
    expect(s.match.phase).toBe('intermission');
    s.advance(11);
    expect(s.match.parked.size).toBe(0);
    expect(s.match.phase).toBe('warmup');
  });

  it('a player who leaves on purpose still sends a one-sided match back to the warm-up', () => {
    const s = started('elimination', 2, 4);
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    s.match.leave(blue.id);
    expect(s.match.phase).toBe('warmup');
  });

  it('elimination: a player who died, dropped and comes back between rounds plays the next round', () => {
    const s = started('elimination', 4, 4);
    const red = [...s.match.players.values()].filter((p) => p.team === 'red');
    const blue = [...s.match.players.values()].filter((p) => p.team === 'blue');
    s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
    shootDead(s, red[0].id, blue[0].id);
    s.match.leave(blue[0].id, keep('b'));
    shootDead(s, red[0].id, blue[1].id);
    expect(s.match.phase).toBe('roundend');
    s.advance(ROUND.postSec + 0.2);
    expect(s.match.phase).toBe('intermission');
    const back = s.match.join(blue[0].id, blue[0].name, false, { restore: s.match.parked.get(blue[0].id) });
    s.match.ready(blue[0].id);
    s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
    expect(s.match.phase).toBe('live');
    expect(back.alive).toBe(true);
  });

  it('infected with two players: a drop does not end the match, the seat holds the survivor', () => {
    const s = live('infected', 2);
    s.match.leave(2, keep('b'));
    s.advance(0.1);
    expect(s.match.phase).toBe('live');
    const back = s.match.join(2, 'p2', false, { restore: s.match.parked.get(2) });
    s.match.ready(2);
    expect(back.team).toBeTruthy();
    expect(s.match.phase).toBe('live');
  });
});
