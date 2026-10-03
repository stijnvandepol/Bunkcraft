import { describe, expect, it } from 'vitest';
import {
  Experience, ORB_VALUES, deathXp, levelFromTotal, mobXp, oreXp, orbTier, splitXp, totalXpForLevel, wholeXp, xpToNextLevel,
} from '../src/player/Experience';

describe('experience formulas (Minecraft wiki table)', () => {
  it('points per level in the three ranges', () => {
    expect([0, 1, 2, 5, 10, 14, 15].map(xpToNextLevel)).toEqual([7, 9, 11, 17, 27, 35, 37]);
    expect([16, 17, 20, 30].map(xpToNextLevel)).toEqual([42, 47, 62, 112]);
    expect([31, 32, 40].map(xpToNextLevel)).toEqual([121, 130, 202]);
  });

  it('total points at the start of a level', () => {
    const table: [number, number][] = [[0, 0], [1, 7], [5, 55], [10, 160], [15, 315], [16, 352], [17, 394], [20, 550], [30, 1395], [31, 1507], [32, 1628], [40, 2920], [50, 5345]];
    for (const [level, total] of table) expect(totalXpForLevel(level), `level ${level}`).toBe(total);
  });

  it('the total of a level is the sum of the steps below it', () => {
    let sum = 0;
    for (let l = 0; l < 120; l++) {
      expect(totalXpForLevel(l), `level ${l}`).toBe(sum);
      sum += xpToNextLevel(l);
    }
  });

  it('levelFromTotal inverts totalXpForLevel for every point count', () => {
    for (let t = 0; t < 8000; t += 1) {
      const s = levelFromTotal(t);
      expect(totalXpForLevel(s.level)).toBeLessThanOrEqual(t);
      expect(totalXpForLevel(s.level + 1)).toBeGreaterThan(t);
      expect(s.into).toBe(t - totalXpForLevel(s.level));
    }
    expect(levelFromTotal(1395).level).toBe(30);
    expect(levelFromTotal(1394).level).toBe(29);
    expect(levelFromTotal(6).progress).toBeCloseTo(6 / 7);
  });

  it('death drops 7 points per level, at most 100', () => {
    expect(deathXp(0)).toBe(0);
    expect(deathXp(5)).toBe(35);
    expect(deathXp(14)).toBe(98);
    expect(deathXp(15)).toBe(100);
    expect(deathXp(60)).toBe(100);
  });

  it('orb sizes follow the wiki tiers', () => {
    const cases: [number, number][] = [[1, 0], [2, 0], [3, 1], [6, 1], [7, 2], [16, 2], [17, 3], [36, 3], [37, 4], [72, 4], [73, 5], [148, 5], [149, 6],
      [306, 6], [307, 7], [616, 7], [617, 8], [1236, 8], [1237, 9], [2476, 9], [2477, 10], [99999, 10]];
    for (const [value, tier] of cases) expect(orbTier(value), `value ${value}`).toBe(tier);
  });

  it('splits an amount into orb values that add up', () => {
    for (const amount of [1, 2, 5, 6, 7, 11, 100, 1000, 5000]) {
      const orbs = splitXp(amount);
      expect(orbs.reduce((a, b) => a + b, 0)).toBe(amount);
      for (const o of orbs) expect(ORB_VALUES as readonly number[]).toContain(o);
    }
    expect(splitXp(5)).toEqual([3, 1, 1]);
    expect(splitXp(0)).toEqual([]);
  });

  it('fractional experience rounds by chance', () => {
    expect(wholeXp(0.35, () => 0.1)).toBe(1);
    expect(wholeXp(0.35, () => 0.9)).toBe(0);
    expect(wholeXp(2, () => 0.99)).toBe(2);
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += wholeXp(0.7, () => (i + 0.5) / 4000);
    expect(sum / 4000).toBeCloseTo(0.7, 1);
  });

  it('sources: mob and ore ranges', () => {
    expect(mobXp('zombie', true, () => 0.99)).toBe(5);
    expect(mobXp('creeper', true, () => 0)).toBe(5);
    expect(mobXp('pig', false, () => 0)).toBe(1);
    expect(mobXp('pig', false, () => 0.99)).toBe(3);
    expect(mobXp('some_new_monster', true, () => 0.5)).toBe(5);
    expect(oreXp('coal_ore', () => 0)).toBe(0);
    expect(oreXp('coal_ore', () => 0.99)).toBe(2);
    expect(oreXp('diamond_ore', () => 0)).toBe(3);
    expect(oreXp('diamond_ore', () => 0.99)).toBe(7);
    expect(oreXp('redstone_ore', () => 0.99)).toBe(5);
    expect(oreXp('iron_ore')).toBe(0);
  });
});

describe('Experience', () => {
  it('fills the bar, levels up and reports it', () => {
    const xp = new Experience();
    const levels: number[] = [];
    xp.onLevelUp = (l) => levels.push(l);
    xp.add(6);
    expect(xp.level).toBe(0);
    expect(xp.progress).toBeCloseTo(6 / 7);
    xp.add(1);
    expect(xp.level).toBe(1);
    expect(xp.progress).toBe(0);
    xp.add(1000);
    expect(levels[levels.length - 1]).toBe(xp.level);
    expect(xp.total).toBe(1007);
  });

  it('spending levels keeps the fraction of the bar', () => {
    const xp = new Experience();
    xp.set(totalXpForLevel(10) + 13); // level 10, 13 of 27
    expect(xp.spendLevels(3)).toBe(true);
    expect(xp.level).toBe(7);
    expect(xp.progress).toBeCloseTo(13 / 27, 1);
    expect(xp.spendLevels(8)).toBe(false);
    expect(xp.level).toBe(7);
    expect(xp.spendLevels(100, true)).toBe(true);
    expect(xp.level).toBe(7);
  });

  it('survives save and load as a plain number', () => {
    const xp = new Experience();
    xp.add(777);
    const loaded = new Experience();
    loaded.set(xp.serialize());
    expect(loaded.level).toBe(xp.level);
    loaded.set(NaN);
    expect(loaded.total).toBe(0);
  });
});
