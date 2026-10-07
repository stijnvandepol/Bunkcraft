import { BOT_SKILLS, type BotSkill } from '../../server/bots/BotSkill';

/**
 * Reference players for the balance duels, in the bots' own aim model. Rough numbers for mouse-and-keyboard
 * players: an average player reacts in about 0.35-0.4 s to a target that appears (visual reaction plus the
 * flick), holds a mid-range target within ~1.5-2°, and hits the head now and then; a skilled one reacts in
 * ~0.22 s, flicks fast (beyond the 600°/s the bots are capped at), tracks within ~0.7° and goes for heads.
 */
export const HUMAN_AVERAGE: BotSkill = {
  ...BOT_SKILLS.normal, reaction: 0.38, aimError: 1.7, acquireError: 9, turnSpeed: 400, aimRate: 7, headChance: 0.15, fireCone: 2,
};

export const HUMAN_SKILLED: BotSkill = {
  ...BOT_SKILLS.veteran, reaction: 0.22, aimError: 0.7, acquireError: 5, turnSpeed: 700, aimRate: 12, headChance: 0.35, fireCone: 1.2, strafe: 0.9,
};
