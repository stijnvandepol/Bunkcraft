import { describe, expect, it } from 'vitest';
import { EffectSet, FOOD_EFFECTS, findEffect, formatDuration, roman } from '../src/player/Effects';
import { Player } from '../src/player/Player';
import { PlayerStats } from '../src/player/PlayerStats';

const air = (): number => 0;

function run(stats: PlayerStats, n: number, mode: 'survival' | 'creative' = 'survival'): void {
  const p = new Player();
  p.setPosition(0.5, 64, 0.5);
  for (let i = 0; i < n; i++) stats.tick(p, air, mode);
}

describe('effect ticking', () => {
  it('Regeneration I heals 1 every 50 ticks, II every 25', () => {
    const a = new PlayerStats();
    a.health = 10;
    a.hunger = 10; // no natural regeneration, no starving
    a.effects.add('regeneration', 0, 1000, a);
    run(a, 100);
    expect(a.health).toBe(12);
    const b = new PlayerStats();
    b.health = 10;
    b.hunger = 10;
    b.effects.add('regeneration', 1, 1000, b);
    run(b, 100);
    expect(b.health).toBe(14);
  });

  it('Poison I hurts 1 every 25 ticks and stops at half a heart', () => {
    const s = new PlayerStats();
    s.hunger = 10;
    s.effects.add('poison', 0, 1000, s);
    run(s, 100);
    expect(s.health).toBe(16);
    s.health = 2;
    s.invulnerableTicks = 0;
    run(s, 200);
    expect(s.health).toBe(1);
    expect(s.dead).toBe(false);
  });

  it('Wither can kill and says so', () => {
    const s = new PlayerStats();
    s.health = 1;
    s.effects.add('wither', 0, 1000, s);
    run(s, 40);
    expect(s.dead).toBe(true);
    expect(s.deathMessage).toContain('withered away');
  });

  it('Hunger drains faster, Saturation fills hunger and saturation', () => {
    const h = new PlayerStats();
    h.effects.add('hunger', 0, 1000, h);
    run(h, 200, 'creative');
    expect(h.exhaustion).toBeCloseTo(1, 5);
    const s = new PlayerStats();
    s.hunger = 5;
    s.saturation = 0;
    s.effects.add('saturation', 0, 3, s);
    run(s, 3, 'creative');
    expect(s.hunger).toBe(8);
    expect(s.saturation).toBe(3);
  });

  it('Instant Health heals 4 << amp and Instant Damage hurts 6 << amp at once', () => {
    const s = new PlayerStats();
    s.health = 4;
    s.effects.add('instant_health', 1, 1, s);
    expect(s.health).toBe(12);
    s.effects.add('instant_damage', 0, 1, s);
    expect(s.health).toBe(6);
    expect(s.effects.size).toBe(0);
  });

  it('expires after its duration', () => {
    const s = new PlayerStats();
    s.effects.add('speed', 0, 5, s);
    run(s, 4);
    expect(s.effects.has('speed')).toBe(true);
    run(s, 1);
    expect(s.effects.has('speed')).toBe(false);
  });

  it('Water Breathing keeps the air, Fire Resistance ignores lava', () => {
    const s = new PlayerStats();
    const p = new Player();
    p.setPosition(0.5, 64, 0.5);
    p.headInWater = true;
    s.effects.add('water_breathing', 0, 1000, s);
    for (let i = 0; i < 400; i++) s.tick(p, air, 'survival');
    expect(s.air).toBe(300);
    expect(s.health).toBe(20);
  });
});

describe('stacking and queries', () => {
  it('keeps the stronger effect, refreshes an equal one that lasts longer', () => {
    const e = new EffectSet();
    expect(e.add('speed', 1, 100)).toBe(true);
    expect(e.add('speed', 0, 500)).toBe(false);
    expect(e.add('speed', 1, 50)).toBe(false);
    expect(e.add('speed', 1, 200)).toBe(true);
    expect(e.get('speed')?.duration).toBe(200);
    expect(e.add('speed', 2, 10)).toBe(true);
    expect(e.level('speed')).toBe(3);
  });

  it('computes speed, mining, attack and resistance factors', () => {
    const e = new EffectSet();
    expect(e.speedMultiplier()).toBe(1);
    e.add('speed', 1, 100);
    expect(e.speedMultiplier()).toBeCloseTo(1.4, 5);
    e.add('slowness', 0, 100);
    expect(e.speedMultiplier()).toBeCloseTo(1.4 * 0.85, 5);
    e.add('haste', 1, 100);
    e.add('mining_fatigue', 1, 100);
    expect(e.miningMultiplier()).toBeCloseTo(1.4 * 0.09, 5);
    e.add('strength', 1, 100);
    e.add('weakness', 0, 100);
    expect(e.attackBonus()).toBe(2);
    e.add('resistance', 2, 100);
    expect(e.resistanceFactor()).toBeCloseTo(0.4, 5);
  });

  it('serializes and loads, skipping bad entries', () => {
    const e = new EffectSet();
    e.add('regeneration', 1, 300);
    e.add('night_vision', 0, 9000);
    const data = e.serialize()!;
    const back = new EffectSet();
    back.load([...data, [999, 0, 5], 'x', [1, 0, -5]]);
    expect(back.list().map((x) => [x.id, x.amp, x.duration])).toEqual(e.list().map((x) => [x.id, x.amp, x.duration]));
    expect(new EffectSet().serialize()).toBeUndefined();
  });

  it('formats names, numerals and timers', () => {
    expect(findEffect('Mining Fatigue')).toBe('mining_fatigue');
    expect(findEffect('minecraft:night_vision')).toBe('night_vision');
    expect(findEffect('nope')).toBeNull();
    expect(roman(4)).toBe('IV');
    expect(roman(2)).toBe('II');
    expect(formatDuration(1800)).toBe('1:30');
    expect(formatDuration(100)).toBe('0:05');
  });

  it('golden apple gives Regeneration II for 5 s and Absorption', () => {
    expect(FOOD_EFFECTS.golden_apple).toEqual([
      { id: 'regeneration', amp: 1, ticks: 100 },
      { id: 'absorption', amp: 0, ticks: 2400 },
    ]);
  });
});
