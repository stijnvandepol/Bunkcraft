import { describe, expect, it } from 'vitest';
import { gameTypeDef } from '../src/modes/GameTypes';
import { zoneColor, zoneStatus, KING_SELF_COLOR, KING_OTHER_COLOR, CONTESTED_COLOR } from '../src/modes/ModeView';
import type { KothLogic } from '../server/modes/koth';
import { live, place, shootDead } from './helpers/matchHost';

const DEF = gameTypeDef('koth');
const P = DEF.params!;
type S = ReturnType<typeof live>;
const logic = (s: S) => s.match.logic as KothLogic;
const hill = (s: S) => s.match.map.zones[Math.max(0, logic(s).liveHill)];

describe('king of the hill', () => {
  it('is free for all on maps with zones', () => {
    expect(DEF.teams).toBe(false);
    expect(DEF.requires).toEqual(['zones']);
    const s = live('koth', 3);
    for (const p of s.match.players.values()) expect(p.team).toBe('');
  });

  it('the one player alone in the hill scores a point per second', () => {
    const s = live('koth', 2);
    const z = hill(s);
    place(s, 1, z.x, z.y, z.z);
    place(s, 2, -40, 65, -40);
    s.advance(10);
    const p1 = s.match.players.get(1)!;
    expect(p1.pts).toBeGreaterThanOrEqual(9);
    expect(p1.pts).toBeLessThanOrEqual(10);
    expect(logic(s).holder).toBe(1);
    const st = s.host.of('mode').at(-1)!.state;
    expect(st.kind === 'zones' && st.variant).toBe('koth');
    if (st.kind === 'zones') expect(st.zones[logic(s).liveHill].holder).toBe(1);
  });

  it('two players in the hill contest it: nobody scores', () => {
    const s = live('koth', 2);
    const z = hill(s);
    place(s, 1, z.x, z.y, z.z);
    place(s, 2, z.x + 1, z.y, z.z);
    s.advance(5);
    expect(s.match.players.get(1)!.pts + s.match.players.get(2)!.pts).toBe(0);
    const st = s.host.of('mode').at(-1)!.state;
    if (st.kind === 'zones') expect(st.zones[logic(s).liveHill].contested).toBe(true);
  });

  it('kills score nothing', () => {
    const s = live('koth', 2);
    shootDead(s, 1, 2);
    expect(s.match.players.get(1)!.pts).toBe(0);
  });

  it('the hill moves on after rotateSec with a pause in between', () => {
    const s = live('koth', 2);
    const first = logic(s).liveHill;
    s.advance(P.rotateSec);
    expect(logic(s).liveHill).toBe(-1);
    s.advance(P.gapSec + 0.2);
    expect(logic(s).liveHill).toBe((first + 1) % s.match.map.zones.length);
    expect(s.host.events('zone-moved').length).toBeGreaterThanOrEqual(1);
  });

  it('first to the score limit wins', () => {
    const s = live('koth', 2, 5);
    const z = hill(s);
    place(s, 2, z.x, z.y, z.z);
    place(s, 1, -40, 65, -40);
    s.advance(6);
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerId: 2, winnerTeam: '' });
  });

  it('bots are sent to the live hill', () => {
    const s = live('koth', 2);
    const goal = logic(s).objectives(s.match, s.match.players.get(1)!)[0];
    expect(goal).toMatchObject({ kind: 'capture', x: hill(s).x, z: hill(s).z });
  });

  it('the view: gold when you hold it, red when someone else does, orange when contested', () => {
    const z = { name: 'A', x: 0, y: 65, z: 0, r: 5, active: true, owner: '' as const, progress: 0, progressTeam: '' as const, contested: false, red: 1, blue: 0, holder: 4 };
    expect(zoneColor(z, 4)).toBe(KING_SELF_COLOR);
    expect(zoneColor(z, 5)).toBe(KING_OTHER_COLOR);
    expect(zoneColor({ ...z, contested: true }, 4)).toBe(CONTESTED_COLOR);
    expect(zoneStatus(z, '', 'koth', 4)).toBe('HOLDING');
    expect(zoneStatus(z, '', 'koth', 5)).toBe('TAKE IT');
    expect(zoneStatus({ ...z, holder: 0 }, '', 'koth', 5)).toBe('CAPTURE');
  });
});
