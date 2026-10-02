import type { GameTypeDef } from '../../src/modes/GameTypes';
import { DeathmatchLogic } from './deathmatch';
import type { ModeLogic } from './ModeLogic';

export type { Kit, MatchResult, ModeLogic } from './ModeLogic';

/** The rules class for a game type (each is a small class in server/modes/<id>.ts). */
export function createLogic(def: GameTypeDef): ModeLogic {
  switch (def.logic) {
    default: return new DeathmatchLogic();
  }
}
