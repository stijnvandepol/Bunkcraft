import { describe, expect, it } from 'vitest';
import { gameTypeDef } from '../src/modes/GameTypes';
import { MAPS } from '../src/modes/maps';
import type { SndLogic } from '../server/modes/snd';
import { place, shootDead, started } from './helpers/matchHost';

const DEF = gameTypeDef('snd');
const ROUND = DEF.rounds!;
const P = DEF.params!;
type S = ReturnType<typeof started>;
const toLive = (s: S) => s.advance(ROUND.intermissionSec + ROUND.countdownSec + 0.2);
const logic = (s: S) => s.match.logic as SndLogic;
const att = (s: S) => [...s.match.players.values()].filter((p) => p.team === logic(s).attackers);
const def = (s: S) => [...s.match.players.values()].filter((p) => p.team && p.team !== logic(s).attackers);
const site = (s: S, i: number) => s.match.map.sites[i];
/** Somewhere quiet, away from both sites. */
const park = (s: S, id: number, n = 0) => place(s, id, -40 + n * 3, 65, -40);

function plant(s: S, id: number, i = 0): void {
  const st = site(s, i);
  place(s, id, st.x, st.y, st.z);
  s.advance(P.plantSec + 0.2);
}

describe('search and destroy', () => {
  it('needs bomb sites; rounds with one life; first to 4 round wins', () => {
    expect(DEF.requires).toEqual(['sites']);
    expect(DEF.respawn?.rule).toBe('never');
    expect(DEF.scoreLimit).toBe(4);
    const s = started('snd', 2);
    expect(s.match.phase).toBe('intermission');
    expect(logic(s).attackers).toBe('red');
  });

  it('attackers start in the red half, defenders in the blue half next to the sites, whatever their colour', () => {
    const s = started('snd', 4);
    for (const p of att(s)) expect(p.x).toBeLessThan(0);
    for (const p of def(s)) expect(p.x).toBeGreaterThan(0);
  });

  it('an attacker on a site plants in plantSec; the round clock becomes the fuse', () => {
    const s = started('snd', 2);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    park(s, d.id);
    const st = site(s, 0);
    place(s, a.id, st.x, st.y, st.z);
    s.advance(P.plantSec - 0.5);
    expect(logic(s).planted).toBeUndefined();
    expect(logic(s).siteRuns[0].progress).toBeGreaterThan(0.5);
    s.advance(0.7);
    expect(logic(s).planted?.site.name).toBe(st.name);
    expect(s.host.events('bomb-planted').at(-1)).toMatchObject({ team: a.team, id: a.id, text: st.name });
    expect(a.pts).toBe(1);
    expect(s.match.phase).toBe('live');
    expect(s.match.timeLeft()).toBeLessThanOrEqual(P.fuseSec);
    expect(s.match.timeLeft()).toBeGreaterThan(P.fuseSec - 2);
  });

  it('leaving the site resets the plant', () => {
    const s = started('snd', 2);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    park(s, d.id);
    const st = site(s, 1);
    place(s, a.id, st.x, st.y, st.z);
    s.advance(P.plantSec - 1);
    park(s, a.id, 2);
    s.advance(0.1);
    expect(logic(s).siteRuns[1].progress).toBe(0);
    place(s, a.id, st.x, st.y, st.z);
    s.advance(1.2);
    expect(logic(s).planted).toBeUndefined();
  });

  it('the bomb goes off when the fuse runs out: the attackers take the round', () => {
    const s = started('snd', 2);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    park(s, d.id);
    plant(s, a.id);
    park(s, a.id, 2);
    s.advance(P.fuseSec + 0.5);
    expect(s.host.events('bomb-exploded')).toHaveLength(1);
    expect(s.match.scores[a.team as 'red']).toBe(1);
    expect(s.match.phase).toBe('roundend');
  });

  it('a defender on the planted site defuses in defuseSec: the defenders take the round', () => {
    const s = started('snd', 2);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    park(s, d.id);
    plant(s, a.id);
    park(s, a.id, 2);
    const st = site(s, 0);
    place(s, d.id, st.x + 1, st.y, st.z);
    s.advance(P.defuseSec - 1);
    expect(s.match.phase).toBe('live');
    s.advance(1.3);
    expect(s.host.events('bomb-defused').at(-1)).toMatchObject({ team: d.team, id: d.id });
    expect(s.match.scores[d.team as 'blue']).toBe(1);
    expect(d.pts).toBe(1);
  });

  it('killing every attacker before the plant wins the round for the defenders; after the plant it does not', () => {
    const s = started('snd', 2);
    toLive(s);
    let [a] = att(s), [d] = def(s);
    shootDead(s, d.id, a.id);
    expect(s.match.phase).toBe('roundend');
    expect(s.match.scores[d.team as 'blue']).toBe(1);

    s.advance(ROUND.postSec + 0.1);
    toLive(s);
    [a] = att(s); [d] = def(s);
    park(s, d.id);
    plant(s, a.id);
    shootDead(s, d.id, a.id);
    expect(s.match.phase).toBe('live'); // the bomb still has to be defused
    const st = site(s, 0);
    place(s, d.id, st.x, st.y, st.z);
    s.advance(P.defuseSec + 0.3);
    expect(s.match.scores[d.team as 'blue']).toBe(2);
  });

  it('killing every defender wins the round for the attackers', () => {
    const s = started('snd', 2);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    shootDead(s, a.id, d.id);
    expect(s.match.scores[a.team as 'red']).toBe(1);
  });

  it('the defenders hold when the round clock runs out with no bomb down', () => {
    const s = started('snd', 2, 4, 90);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    park(s, a.id);
    park(s, d.id, 2);
    s.advance(91);
    expect(s.match.scores[d.team as 'blue']).toBe(1);
    expect(s.host.events('bomb-exploded')).toHaveLength(0);
  });

  it('sides swap at half time (round limit - 1 rounds) and the mode state says who attacks', () => {
    const s = started('snd', 2, 3);
    const red = [...s.match.players.values()].find((p) => p.team === 'red')!;
    const blue = [...s.match.players.values()].find((p) => p.team === 'blue')!;
    const winRound = () => {
      toLive(s);
      // Red wins every round by killing blue.
      shootDead(s, red.id, blue.id);
      s.advance(ROUND.postSec + 0.1);
    };
    winRound();
    expect(logic(s).attackers).toBe('red');
    const st = s.host.of('mode').at(-1)!.state;
    expect(st.kind === 'bomb' && st.swapIn).toBe(1);
    winRound();
    expect(logic(s).attackers).toBe('blue');
    expect(s.host.events('side-swap').at(-1)).toMatchObject({ team: 'blue' });
    // Blue attacks from the red half now.
    expect(blue.x).toBeLessThan(0);
    expect(red.x).toBeGreaterThan(0);
    winRound();
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: 'red' });
  });

  it('bot objectives: attackers go plant, then guard; defenders guard, then defuse', () => {
    const s = started('snd', 2);
    toLive(s);
    const [a] = att(s), [d] = def(s);
    expect(logic(s).objectives(s.match, a)[0].kind).toBe('capture');
    expect(logic(s).objectives(s.match, d)[0].kind).toBe('defend');
    park(s, d.id);
    plant(s, a.id);
    expect(logic(s).objectives(s.match, a)[0].kind).toBe('defend');
    const goal = logic(s).objectives(s.match, d)[0];
    expect(goal.kind).toBe('defuse');
    expect(goal.x).toBe(site(s, 0).x);
  });

  it('shipped maps with sites: two of them, in the blue half', () => {
    const withSites = MAPS.filter((m) => m.sites.length > 0);
    expect(withSites.length).toBeGreaterThanOrEqual(3);
    for (const m of withSites) {
      expect(m.supports(['sites']), m.id).toBe(true);
      expect(m.sites.map((x) => x.name)).toEqual(['A', 'B']);
      for (const x of m.sites) expect(x.x, `${m.id} ${x.name}`).toBeGreaterThan(0);
    }
  });
});
