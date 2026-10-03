import { describe, expect, it } from 'vitest';
import { Player } from '../src/player/Player';
import { PlayerStats } from '../src/player/PlayerStats';
import { GameRules } from '../src/world/GameRules';

const air = (): number => 0;

function run(stats: PlayerStats, n: number): void {
  const p = new Player();
  p.setPosition(0.5, 64, 0.5);
  for (let i = 0; i < n; i++) stats.tick(p, air, 'survival');
}

describe('difficulty and rules in PlayerStats', () => {
  it('Peaceful refills hunger and heals about 1 per second', () => {
    const s = new PlayerStats();
    s.difficulty = 'peaceful';
    s.health = 10;
    s.hunger = 4;
    run(s, 20);
    expect(s.hunger).toBe(20);
    expect(s.health).toBeGreaterThanOrEqual(11);
  });

  it('starves to 10 on Easy and to death on Hard', () => {
    const easy = new PlayerStats();
    easy.difficulty = 'easy';
    easy.hunger = 0; easy.saturation = 0; easy.health = 12;
    run(easy, 80 * 5);
    expect(easy.health).toBe(10);
    const hard = new PlayerStats();
    hard.difficulty = 'hard';
    hard.hunger = 0; hard.saturation = 0; hard.health = 2;
    run(hard, 80 * 3);
    expect(hard.dead).toBe(true);
    expect(hard.deathMessage).toContain('starved to death');
  });

  it('naturalRegeneration off stops the hunger healing', () => {
    const s = new PlayerStats();
    s.rules = new GameRules();
    s.rules.set('naturalRegeneration', false);
    s.health = 10;
    run(s, 200);
    expect(s.health).toBe(10);
  });

  it('fallDamage off: falls do not hurt', () => {
    const s = new PlayerStats();
    s.rules = new GameRules();
    s.rules.set('fallDamage', false);
    expect(s.hurt(10, { kind: 'fall' }, 'survival').hurt).toBe(false);
    expect(s.health).toBe(20);
  });
});
