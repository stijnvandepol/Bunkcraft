import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, nextDifficulty, parseDifficulty, scaleMobDamage, starvationFloor } from '../src/world/Difficulty';
import { GameRules, RULE_NAMES, findRule, runGameRuleCommand } from '../src/world/GameRules';

describe('GameRules', () => {
  it('has Minecraft defaults', () => {
    const r = new GameRules();
    expect(r.get('keepInventory')).toBe(false);
    expect(r.get('doMobSpawning')).toBe(true);
    expect(r.get('randomTickSpeed')).toBe(3);
    expect(r.get('playersSleepingPercentage')).toBe(100);
    expect(r.serialize()).toBeUndefined();
  });

  it('parses booleans and integers and rejects the rest', () => {
    const r = new GameRules();
    expect(r.set('keepInventory', 'true')).toBe(true);
    expect(r.get('keepInventory')).toBe(true);
    expect(r.set('keepInventory', 'yes')).toBe(false);
    expect(r.set('randomTickSpeed', '10')).toBe(true);
    expect(r.get('randomTickSpeed')).toBe(10);
    expect(r.set('randomTickSpeed', '-1')).toBe(false);
    expect(r.set('randomTickSpeed', '1.5')).toBe(false);
    expect(r.set('playersSleepingPercentage', '101')).toBe(false);
    expect(r.get('randomTickSpeed')).toBe(10);
  });

  it('saves only non-defaults and loads defensively', () => {
    const r = new GameRules();
    r.set('fallDamage', false);
    r.set('randomTickSpeed', 0);
    expect(r.serialize()).toEqual({ fallDamage: false, randomTickSpeed: 0 });
    const back = new GameRules();
    back.load({ fallDamage: false, randomTickSpeed: 0, bogus: true, keepInventory: 'x', mobGriefing: 7 });
    expect(back.get('fallDamage')).toBe(false);
    expect(back.get('randomTickSpeed')).toBe(0);
    expect(back.get('keepInventory')).toBe(false);
    expect(back.get('mobGriefing')).toBe(true);
    back.load(null);
    expect(back.get('fallDamage')).toBe(true);
  });

  it('finds rules case-insensitively and runs /gamerule', () => {
    expect(findRule('KEEPINVENTORY')).toBe('keepInventory');
    expect(findRule('nope')).toBeNull();
    const r = new GameRules();
    expect(runGameRuleCommand(r, ['keepinventory']).reply).toBe('keepInventory is false');
    const set = runGameRuleCommand(r, ['keepInventory', 'true']);
    expect(set.changed).toBe(true);
    expect(r.get('keepInventory')).toBe(true);
    expect(runGameRuleCommand(r, ['keepInventory', 'maybe']).changed).toBe(false);
    expect(runGameRuleCommand(r, ['zzz']).reply).toContain('Unknown game rule');
    expect(runGameRuleCommand(r, []).reply).toContain('Usage');
    expect(RULE_NAMES.length).toBeGreaterThanOrEqual(12);
  });
});

describe('Difficulty', () => {
  it('parses names, digits and letters', () => {
    expect(parseDifficulty('Hard')).toBe('hard');
    expect(parseDifficulty('0')).toBe('peaceful');
    expect(parseDifficulty('e')).toBe('easy');
    expect(parseDifficulty('x')).toBeNull();
    expect(parseDifficulty(undefined)).toBeNull();
  });

  it('cycles through all four', () => {
    let d = DIFFICULTIES[0];
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) { seen.push(d); d = nextDifficulty(d); }
    expect(seen).toEqual(['peaceful', 'easy', 'normal', 'hard']);
    expect(d).toBe('peaceful');
  });

  it('scales mob damage per the wiki table', () => {
    expect(scaleMobDamage('peaceful', 5)).toBe(0);
    expect(scaleMobDamage('easy', 5)).toBe(3.5);
    expect(scaleMobDamage('easy', 1)).toBe(1);
    expect(scaleMobDamage('easy', 2)).toBe(2);
    expect(scaleMobDamage('normal', 5)).toBe(5);
    expect(scaleMobDamage('hard', 4)).toBe(6);
  });

  it('starves to 10 (easy), half a heart (normal) or death (hard, hardcore)', () => {
    expect(starvationFloor('easy', false)).toBe(10);
    expect(starvationFloor('normal', false)).toBe(1);
    expect(starvationFloor('hard', false)).toBe(0);
    expect(starvationFloor('normal', true)).toBe(0);
  });
});
