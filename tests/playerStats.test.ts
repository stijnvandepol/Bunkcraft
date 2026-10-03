import { describe, expect, it } from 'vitest';
import type { GameMode } from '../src/player/GameMode';
import { Player } from '../src/player/Player';
import { MAX_HEALTH, PlayerStats } from '../src/player/PlayerStats';

const air = (): number => 0;

function setup(init: Partial<Pick<PlayerStats, 'health' | 'hunger' | 'saturation' | 'exhaustion'>>): { stats: PlayerStats; player: Player } {
  const stats = new PlayerStats();
  Object.assign(stats, init);
  const player = new Player();
  player.setPosition(0.5, 64, 0.5);
  return { stats, player };
}

function ticks(stats: PlayerStats, player: Player, n: number, mode: GameMode = 'survival'): void {
  for (let i = 0; i < n; i++) stats.tick(player, air, mode);
}

describe('PlayerStats: natural regeneration', () => {
  it('heals 1 every 80 ticks when hunger is at least 18', () => {
    const { stats, player } = setup({ health: 10, hunger: 18, saturation: 0 });
    ticks(stats, player, 79);
    expect(stats.health).toBe(10);
    ticks(stats, player, 1);
    expect(stats.health).toBe(11);
    // Each healed point costs 6 exhaustion.
    expect(stats.exhaustion).toBe(6);
  });

  it('does not regenerate with hunger below 18', () => {
    const { stats, player } = setup({ health: 10, hunger: 17, saturation: 0 });
    ticks(stats, player, 400);
    expect(stats.health).toBe(10);
  });

  it('heals fast (every 10 ticks) with full hunger and saturation left', () => {
    const { stats, player } = setup({ health: 10, hunger: 20, saturation: 10 });
    ticks(stats, player, 10);
    expect(stats.health).toBe(11);
    ticks(stats, player, 10);
    expect(stats.health).toBe(12);
  });

  it('heals saturation / 6 for that much exhaustion when saturation is below 6 (Java FoodData)', () => {
    const { stats, player } = setup({ health: 10, hunger: 20, saturation: 3 });
    ticks(stats, player, 10);
    expect(stats.health).toBeCloseTo(10.5, 6);
    expect(stats.exhaustion).toBeCloseTo(3, 6);
  });

  it('restarts the regeneration timer while at full health (no instant heal after a hit)', () => {
    const { stats, player } = setup({ health: MAX_HEALTH, hunger: 18, saturation: 0 });
    ticks(stats, player, 500);
    stats.damage(2, 'fall', 'survival');
    ticks(stats, player, 79);
    expect(stats.health).toBe(MAX_HEALTH - 2);
    ticks(stats, player, 1);
    expect(stats.health).toBe(MAX_HEALTH - 1);
  });

  it('does nothing at full health', () => {
    const { stats, player } = setup({ health: MAX_HEALTH, hunger: 20, saturation: 5 });
    ticks(stats, player, 200);
    expect(stats.health).toBe(MAX_HEALTH);
    expect(stats.exhaustion).toBe(0);
  });
});

describe('PlayerStats: starvation', () => {
  it('deals 1 damage every 80 ticks at zero hunger', () => {
    const { stats, player } = setup({ health: 10, hunger: 0, saturation: 0 });
    ticks(stats, player, 80);
    expect(stats.health).toBe(9);
  });

  it('stops at half a heart in survival', () => {
    const { stats, player } = setup({ health: 3, hunger: 0, saturation: 0 });
    ticks(stats, player, 80 * 10);
    expect(stats.health).toBe(1);
    expect(stats.dead).toBe(false);
  });

  it('can starve the player to death in hardcore', () => {
    const { stats, player } = setup({ health: 2, hunger: 0, saturation: 0 });
    ticks(stats, player, 80 * 3, 'hardcore');
    expect(stats.dead).toBe(true);
    expect(stats.deathMessage).toBe('Player starved to death');
  });

  it('never applies in creative', () => {
    const { stats, player } = setup({ health: 10, hunger: 0, saturation: 0 });
    ticks(stats, player, 800, 'creative');
    expect(stats.health).toBe(10);
  });
});

describe('PlayerStats: exhaustion, saturation and hunger', () => {
  it('drains saturation first for every 4 exhaustion', () => {
    const { stats, player } = setup({ hunger: 20, saturation: 2, exhaustion: 4.5 });
    ticks(stats, player, 1);
    expect(stats.saturation).toBe(1);
    expect(stats.hunger).toBe(20);
    expect(stats.exhaustion).toBeCloseTo(0.5, 6);
  });

  it('drains hunger once saturation is empty', () => {
    const { stats, player } = setup({ hunger: 20, saturation: 0, exhaustion: 8 });
    ticks(stats, player, 1);
    expect(stats.hunger).toBe(18);
    expect(stats.exhaustion).toBe(0);
  });

  it('caps exhaustion at 40', () => {
    const stats = new PlayerStats();
    stats.addExhaustion(100);
    expect(stats.exhaustion).toBe(40);
  });

  it('eating caps saturation at the hunger level', () => {
    const stats = new PlayerStats();
    Object.assign(stats, { hunger: 2, saturation: 0 });
    stats.eat(3, 12.8);
    expect(stats.hunger).toBe(5);
    expect(stats.saturation).toBe(5);
  });

  it('sprinting needs more than 6 hunger', () => {
    const stats = new PlayerStats();
    stats.hunger = 6;
    expect(stats.canSprint).toBe(false);
    stats.hunger = 7;
    expect(stats.canSprint).toBe(true);
  });
});

describe('PlayerStats: damage', () => {
  it('applies invulnerability frames: weaker hits are ignored, stronger ones deal the difference', () => {
    const stats = new PlayerStats();
    expect(stats.damage(5, 'mob', 'survival')).toBe(true);
    expect(stats.health).toBe(15);
    expect(stats.damage(3, 'mob', 'survival')).toBe(false);
    expect(stats.damage(8, 'mob', 'survival')).toBe(true);
    expect(stats.health).toBe(12);
  });

  it('ignores damage in creative except the void', () => {
    const stats = new PlayerStats();
    expect(stats.damage(5, 'fall', 'creative')).toBe(false);
    expect(stats.damage(4, 'void', 'creative')).toBe(true);
  });
});
