import { describe, expect, it } from 'vitest';
import { BOT_DIFFICULTIES, BOT_SKILLS } from '../server/bots/BotSkill';
import { duel } from './helpers/botDuel';
import { HUMAN_AVERAGE, HUMAN_SKILLED } from './helpers/humanProfiles';

/**
 * Balance of the difficulty levels in simulated duels (tests/helpers/botDuel.ts) against two reference
 * players (tests/helpers/humanProfiles.ts). Share = rounds won / rounds decided.
 */
const ROUNDS = 160;
const share = (r: { a: number; b: number }) => r.a / Math.max(1, r.a + r.b);

describe('bot difficulty balance (simulated duels)', () => {
  const vsAverage = BOT_DIFFICULTIES.map((d) => share(duel(BOT_SKILLS[d], HUMAN_AVERAGE, { rounds: ROUNDS, seed: 11 })));
  const vsSkilled = BOT_DIFFICULTIES.map((d) => share(duel(BOT_SKILLS[d], HUMAN_SKILLED, { rounds: ROUNDS, seed: 23 })));

  it('easy bots are clearly beatable by an average player', () => {
    expect(vsAverage[0]).toBeLessThan(0.3);
  });

  it('normal bots are a fair fight for an average player', () => {
    expect(vsAverage[1]).toBeGreaterThan(0.2);
    expect(vsAverage[1]).toBeLessThan(0.6);
  });

  it('each level is stronger than the one below', () => {
    for (let i = 1; i < vsAverage.length; i++) expect(vsAverage[i]).toBeGreaterThan(vsAverage[i - 1]);
  });

  it('hard bots do not beat everyone: a skilled player wins most duels; veteran is a challenge, not a wall', () => {
    expect(vsSkilled[2]).toBeLessThan(0.4);
    expect(vsSkilled[3]).toBeLessThan(0.5);
    expect(vsAverage[3]).toBeGreaterThan(0.55);
  });

  it('the duels hold with close-range weapons too (SMG)', () => {
    const easy = share(duel(BOT_SKILLS.easy, HUMAN_AVERAGE, { rounds: 80, seed: 5, primary: 'smg', optic: 'iron' }));
    const hard = share(duel(BOT_SKILLS.hard, HUMAN_SKILLED, { rounds: 80, seed: 6, primary: 'smg', optic: 'iron' }));
    expect(easy).toBeLessThan(0.35);
    expect(hard).toBeLessThan(0.5);
  });
});
