import { describe, expect, it } from 'vitest';
import { gameTypeDef } from '../src/modes/GameTypes';
import { ConfirmLogic, MAX_TAGS } from '../server/modes/confirm';
import { live, place, shootDead } from './helpers/matchHost';

const logic = (s: ReturnType<typeof live>) => s.match.logic as ConfirmLogic;
const teamOf = (s: ReturnType<typeof live>, team: 'red' | 'blue') => [...s.match.players.values()].filter((p) => p.team === team);

describe('kill confirmed', () => {
  it('is team deathmatch where kills alone score nothing', () => {
    const def = gameTypeDef('killconfirmed');
    expect(def.teams).toBe(true);
    expect(def.scoring).toEqual({ kill: 0, objective: 1 });
    expect(def.hud).toContain('tags');
    const s = live('killconfirmed', 2);
    const [red] = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    shootDead(s, red.id, blue.id);
    expect(s.match.scores).toEqual({ red: 0, blue: 0 });
    expect(red.kills).toBe(1);
  });

  it('a death drops a tag where the victim fell; the mode state lists it', () => {
    const s = live('killconfirmed', 2);
    const [red] = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    shootDead(s, red.id, blue.id);
    const tags = logic(s).dropped;
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ team: 'blue', x: blue.x, z: blue.z });
    s.advance(0.3);
    const st = s.host.of('mode').at(-1)!.state;
    expect(st.kind).toBe('tags');
    if (st.kind === 'tags') expect(st.tags).toHaveLength(1);
  });

  it('an enemy picking the tag up confirms the kill: a point for the team and a tag for the player', () => {
    const s = live('killconfirmed', 2);
    const [red] = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    shootDead(s, red.id, blue.id);
    const tag = logic(s).dropped[0];
    place(s, red.id, tag.x + 0.5, tag.y, tag.z);
    s.advance(0.1);
    expect(s.match.scores.red).toBe(1);
    expect(red.pts).toBe(1);
    expect(logic(s).dropped).toHaveLength(0);
    expect(s.host.events('tag-confirmed').at(-1)).toMatchObject({ team: 'red', id: red.id });
    // Tags taken show up on the scoreboard.
    expect(s.host.of('roster').at(-1)!.players.find((r) => r.id === red.id)!.pts).toBe(1);
  });

  it('a teammate of the fallen player denies it: no point for anybody', () => {
    const s = live('killconfirmed', 3);
    const reds = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    expect(reds).toHaveLength(2);
    shootDead(s, blue.id, reds[0].id);
    const tag = logic(s).dropped[0];
    place(s, reds[1].id, tag.x, tag.y, tag.z);
    s.advance(0.1);
    expect(s.match.scores).toEqual({ red: 0, blue: 0 });
    expect(reds[1].pts).toBe(1);
    expect(s.host.events('tag-denied').at(-1)).toMatchObject({ team: 'red', id: reds[1].id });
    expect(logic(s).dropped).toHaveLength(0);
  });

  it('dead players and players far above or below do not pick tags up', () => {
    const s = live('killconfirmed', 2);
    const [red] = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    shootDead(s, red.id, blue.id);
    const tag = logic(s).dropped[0];
    place(s, red.id, tag.x, tag.y + 5, tag.z);
    s.advance(0.2);
    expect(logic(s).dropped).toHaveLength(1);
  });

  it('a tag nobody takes is gone after tagSec', () => {
    const s = live('killconfirmed', 2);
    const [red] = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    shootDead(s, red.id, blue.id);
    // Both live far away from it.
    place(s, red.id, -40, 65, 40);
    s.advance(gameTypeDef('killconfirmed').params!.tagSec - 2);
    expect(logic(s).dropped).toHaveLength(1);
    place(s, blue.id, 40, 65, 40);
    s.advance(3);
    expect(logic(s).dropped).toHaveLength(0);
    expect(s.match.scores).toEqual({ red: 0, blue: 0 });
  });

  it('the first team to the confirm limit wins', () => {
    const s = live('killconfirmed', 2, 2);
    const [red] = teamOf(s, 'red'), [blue] = teamOf(s, 'blue');
    for (let i = 0; i < 2; i++) {
      shootDead(s, red.id, blue.id);
      const tag = logic(s).dropped.at(-1)!;
      place(s, red.id, tag.x, tag.y, tag.z);
      s.advance(0.1);
      if (i === 0) s.advance(3.5);
    }
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerTeam: 'red' });
  });

  it('keeps at most MAX_TAGS on the ground and offers bots the nearest ones', () => {
    const s = live('killconfirmed', 2);
    const [red, blue] = [teamOf(s, 'red')[0], teamOf(s, 'blue')[0]];
    const l = logic(s);
    for (let i = 0; i < MAX_TAGS + 5; i++) {
      place(s, blue.id, -40 + (i % 20) * 4, 65, 40 - Math.floor(i / 20) * 4);
      l.onKill(s.match, red, blue, undefined as never, false, s.host.t);
    }
    expect(l.dropped).toHaveLength(MAX_TAGS);
    place(s, red.id, -40, 65, 40);
    const goals = l.objectives(s.match, red);
    expect(goals.length).toBe(3);
    expect(goals[0].kind).toBe('pickup');
    expect(Math.hypot(goals[0].x - red.x, goals[0].z - red.z)).toBeLessThanOrEqual(Math.hypot(goals[2].x - red.x, goals[2].z - red.z));
  });
});
