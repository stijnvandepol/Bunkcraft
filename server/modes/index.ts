import type { GameTypeDef } from '../../src/modes/GameTypes';
import { ConfirmLogic } from './confirm';
import { CtfLogic } from './ctf';
import { DeathmatchLogic } from './deathmatch';
import { GunGameLogic } from './gungame';
import { InfectedLogic } from './infected';
import { KothLogic } from './koth';
import type { ModeLogic } from './ModeLogic';
import { RoundsLogic } from './rounds';
import { SharpshooterLogic } from './sharpshooter';
import { SndLogic } from './snd';
import { ZonesLogic } from './zones';

export type { BotGoal, Kit, MatchResult, ModeLogic } from './ModeLogic';

/** The rules class for a game type (each is a small class in server/modes/<id>.ts). */
export function createLogic(def: GameTypeDef): ModeLogic {
  switch (def.logic) {
    case 'gungame': return new GunGameLogic();
    case 'rounds': return new RoundsLogic();
    case 'zones': return new ZonesLogic(def.id === 'domination' ? 'domination' : 'hardpoint');
    case 'ctf': return new CtfLogic();
    case 'confirm': return new ConfirmLogic();
    case 'snd': return new SndLogic();
    case 'infected': return new InfectedLogic();
    case 'sharpshooter': return new SharpshooterLogic();
    case 'koth': return new KothLogic();
    default: return new DeathmatchLogic();
  }
}
