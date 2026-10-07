import { describe, expect, it } from 'vitest';
import { gameTypeDef } from '../src/modes/GameTypes';
import { modeSpeedMul } from '../src/modes/ModeView';
import { ENDED_SECONDS } from '../server/Match';
import { INFECTED, type InfectedLogic, SURVIVORS } from '../server/modes/infected';
import { live, place, shootDead, started } from './helpers/matchHost';

const DEF = gameTypeDef('infected');
const P = DEF.params!;
type S = ReturnType<typeof started>;
const logic = (s: S) => s.match.logic as InfectedLogic;
const team = (s: S, t: 'red' | 'blue') => [...s.match.players.values()].filter((p) => p.team === t);
/** Started and past the outbreak. */
function outbreak(n: number, time?: number): S {
  const s = live('infected', n, undefined, time);
  s.advance(P.outbreakSec);
  expect(logic(s).started).toBe(true);
  return s;
}

describe('infected', () => {
  it('everybody starts as a survivor with their own class, nobody can be hurt before the outbreak', () => {
    const s = live('infected', 3);
    expect(team(s, SURVIVORS)).toHaveLength(3);
    s.match.setLoadout(1, 'sniper');
    expect(s.match.players.get(1)!.slots[0].def.id).toBe('sniper'); // own choice applies (calm phase)
    const st = s.host.of('mode').at(-1)!.state;
    expect(st.kind === 'infected' && st.outbreakIn).toBeGreaterThan(0);
  });

  it('after outbreakSec one random survivor turns: knife only, faster, one stab kills', () => {
    const s = outbreak(3);
    const inf = team(s, INFECTED);
    expect(inf).toHaveLength(1);
    expect(inf[0].slots.map((x) => x.def.id)).toEqual(['knife', 'knife', 'knife']);
    expect(s.host.events('outbreak').at(-1)).toMatchObject({ id: inf[0].id });
    expect(s.match.logic.speedMul!(s.match, inf[0])).toBeCloseTo(P.infectedSpeed);
    expect(s.match.logic.speedMul!(s.match, team(s, SURVIVORS)[0])).toBe(1);
    // One stab: shootDead fires until dead; a single knife hit must be enough.
    const victim = team(s, SURVIVORS)[0];
    shootDead(s, inf[0].id, victim.id, 0);
    expect(victim.deaths).toBe(1);
    expect(s.host.of('hit', inf[0].id).filter((h) => h.victim === victim.id)).toHaveLength(1);
  });

  it('a killed survivor comes back infected; late joiners join the infected', () => {
    const s = outbreak(3);
    const [inf] = team(s, INFECTED);
    const victim = team(s, SURVIVORS)[0];
    shootDead(s, inf.id, victim.id, 0);
    expect(victim.team).toBe(INFECTED);
    expect(s.host.events('infected').at(-1)).toMatchObject({ id: victim.id });
    s.advance(DEF.respawn!.seconds + 0.2);
    expect(victim.alive).toBe(true);
    expect(victim.slots[0].def.id).toBe('knife');
    const late = s.match.join(9, 'late');
    expect(late.team).toBe(INFECTED);
    s.advance(0.1);
    expect(s.match.scores).toEqual({ red: 3, blue: 1 });
  });

  it('teams never get rebalanced: infected stay infected however lopsided it gets', () => {
    const s = outbreak(4);
    const [inf] = team(s, INFECTED);
    for (const v of team(s, SURVIVORS).slice(0, 2)) shootDead(s, inf.id, v.id, 0);
    s.advance(5);
    expect(team(s, INFECTED)).toHaveLength(3);
    expect(team(s, SURVIVORS)).toHaveLength(1);
  });

  it('the last survivor is announced, gets the bonus and the speed of the infected', () => {
    const s = outbreak(3);
    const [inf] = team(s, INFECTED);
    const [a, b] = team(s, SURVIVORS);
    const before = b.pts;
    shootDead(s, inf.id, a.id, 0);
    expect(logic(s).lastSurvivor).toBe(b.id);
    expect(s.host.events('last-survivor').at(-1)).toMatchObject({ id: b.id });
    expect(b.pts).toBe(before + P.lastBonus);
    expect(s.match.logic.speedMul!(s.match, b)).toBeCloseTo(P.infectedSpeed);
    const st = s.host.of('mode').at(-1)!.state;
    expect(modeSpeedMul(DEF, st, 'blue', b.id)).toBeCloseTo(P.infectedSpeed);
    expect(modeSpeedMul(DEF, st, 'blue', a.id === b.id ? 0 : 999)).toBe(1);
  });

  it('the infected win at once when nobody survives', () => {
    const s = outbreak(2);
    const [inf] = team(s, INFECTED), [sur] = team(s, SURVIVORS);
    shootDead(s, inf.id, sur.id, 0);
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: INFECTED });
  });

  it('the survivors win on time; survivors earn a point per 10 s alive', () => {
    const s = outbreak(3, 180);
    const sur = team(s, SURVIVORS);
    for (const p of s.match.players.values()) place(s, p.id, -40 + p.id * 10, 65, 40);
    s.advance(25);
    for (const p of sur) expect(p.pts).toBeGreaterThanOrEqual(2);
    s.advance(180);
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: SURVIVORS });
  });

  it('if every infected leaves, another survivor turns; a fresh match starts with everybody a survivor', () => {
    const s = outbreak(3);
    const [inf] = team(s, INFECTED);
    s.match.leave(inf.id);
    s.advance(0.2);
    expect(team(s, INFECTED)).toHaveLength(1);
    s.match.endMatch();
    s.advance(ENDED_SECONDS + 0.5);
    expect(s.match.phase).toBe('warmup');
    expect(team(s, INFECTED)).toHaveLength(0);
    for (const p of s.match.players.values()) expect(p.slots[0].def.id).not.toBe('knife');
  });

  it('bot objectives: the infected hunt the nearest survivor, survivors keep away', () => {
    const s = outbreak(3);
    const [inf] = team(s, INFECTED);
    const [a, b] = team(s, SURVIVORS);
    place(s, inf.id, 0, 65, 0);
    place(s, a.id, 5, 65, 0);
    place(s, b.id, 30, 65, 0);
    const hunt = logic(s).objectives(s.match, inf)[0];
    expect(hunt).toMatchObject({ kind: 'hunt', target: a.id });
    expect(logic(s).objectives(s.match, b)[0]).toMatchObject({ kind: 'flee', target: inf.id });
  });
});
