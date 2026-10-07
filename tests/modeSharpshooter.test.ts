import { describe, expect, it } from 'vitest';
import { SHARPSHOOTER_POOL, gameTypeDef } from '../src/modes/GameTypes';
import { weaponDef } from '../src/modes/Weapons';
import { SHARPSHOOTER_SECONDARY, type SharpshooterLogic } from '../server/modes/sharpshooter';
import { live, shootDead, started } from './helpers/matchHost';

const DEF = gameTypeDef('sharpshooter');
const ROTATE = DEF.params!.rotateSec;
const logic = (s: ReturnType<typeof started>) => s.match.logic as SharpshooterLogic;

describe('sharpshooter', () => {
  it('the pool holds real primaries only, no knife', () => {
    expect(SHARPSHOOTER_POOL.length).toBeGreaterThanOrEqual(6);
    for (const id of SHARPSHOOTER_POOL) expect(weaponDef(id)?.slot, id).not.toBe('melee');
    expect(DEF.loadout).toBe('ladder');
  });

  it('everybody holds the same weapon (and a pistol), whatever they choose', () => {
    const s = live('sharpshooter', 3);
    s.match.setLoadout(1, 'sniper', 'revolver');
    const w = logic(s).current;
    for (const p of s.match.players.values()) expect(p.slots.map((x) => x.def.id)).toEqual([w, SHARPSHOOTER_SECONDARY, 'knife']);
    const st = s.host.of('mode').at(-1)!.state;
    expect(st).toMatchObject({ kind: 'roulette', weapon: w });
  });

  it('every rotateSec the weapon changes for everybody at once, never the same twice in a row', () => {
    const s = live('sharpshooter', 2);
    let rng = 0;
    s.host.rng = () => { rng = (rng + 0.37) % 1; return rng; };
    const seen: string[] = [logic(s).current];
    for (let i = 0; i < 6; i++) {
      s.advance(ROTATE);
      const w = logic(s).current;
      expect(w).not.toBe(seen.at(-1));
      seen.push(w);
      for (const p of s.match.players.values()) expect(p.slots[0].def.id).toBe(w);
      expect(s.host.of('gear', 1).at(-1)).toMatchObject({ primary: w });
    }
    expect(s.host.events('weapon-rotate').length).toBeGreaterThanOrEqual(6);
    expect(new Set(seen).size).toBeGreaterThan(2);
  });

  it('a respawn hands out the weapon of the moment', () => {
    const s = live('sharpshooter', 2);
    shootDead(s, 1, 2, 1);
    s.advance(ROTATE);
    const p2 = s.match.players.get(2)!;
    expect(p2.alive).toBe(true);
    expect(p2.slots[0].def.id).toBe(logic(s).current);
  });

  it('kills score, first to the limit wins', () => {
    const s = live('sharpshooter', 2, 2);
    shootDead(s, 1, 2, 1);
    s.advance(DEF.respawn!.seconds + 0.3);
    shootDead(s, 1, 2, 1);
    expect(s.match.phase).toBe('ended');
    expect(s.host.of('matchend').at(-1)).toMatchObject({ winnerId: 1 });
  });
});
