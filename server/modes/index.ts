import type { GameTypeDef } from '../../src/modes/GameTypes';
import { CtfLogic } from './ctf';
import { DeathmatchLogic } from './deathmatch';
import { GunGameLogic } from './gungame';
import type { ModeLogic } from './ModeLogic';
import { RoundsLogic } from './rounds';
import { ZonesLogic } from './zones';

export type { Kit, MatchResult, ModeLogic } from './ModeLogic';

/** The rules class for a game type (each is a small class in server/modes/<id>.ts). */
export function createLogic(def: GameTypeDef): ModeLogic {
  switch (def.logic) {
    case 'gungame': return new GunGameLogic();
    case 'rounds': return new RoundsLogic();
    case 'zones': return new ZonesLogic(def.id === 'domination' ? 'domination' : 'hardpoint');
    case 'ctf': return new CtfLogic();
    default: return new DeathmatchLogic();
  }
}
