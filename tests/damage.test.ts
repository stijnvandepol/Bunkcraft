import { afterEach, describe, expect, it } from 'vitest';
import { type DamageTarget, INVULNERABLE_TICKS, dealDamage, deathMessage, protectionFactor, registerDamageModifier } from '../src/player/Damage';
import { PlayerStats } from '../src/player/PlayerStats';
import { Mob } from '../src/entities/Mob';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { GameRules } from '../src/world/GameRules';

function target(over: Partial<DamageTarget> = {}): DamageTarget {
  return { health: 20, absorption: 0, invulnerableTicks: 0, lastDamage: 0, armorPoints: 0, armorToughness: 0, ...over };
}

describe('armor formula (Minecraft Wiki, Armor)', () => {
  // [armor points, toughness, damage, expected damage taken]
  const table: [number, number, number, number][] = [
    [20, 8, 10, 3.0], // full diamond: min(20, max(4, 20 − 40/16)) = 17.5 → 70 %
    [15, 0, 5, 2.5], // full iron: 15 − 20/8 = 12.5 → 50 %
    [7, 0, 4, 3.2], // full leather: 7 − 16/8 = 5 → 20 %
    [20, 8, 4, 0.96], // diamond vs a zombie hit: 20 − 16/16 = 19 → 76 %
    [20, 12, 20, 7.2], // full netherite: 20 − 80/20 = 16 → 64 %
    [20, 0, 1, 0.22], // tiny hit: 20 − 4/8 = 19.5 → 78 %
    [2, 0, 40, 39.36], // huge hit with little armor: the armor/5 floor 0.4 → 1.6 %
  ];
  it.each(table)('armor %d toughness %d takes %d damage down to %d', (armor, tough, dmg, expected) => {
    const t = target({ armorPoints: armor, armorToughness: tough });
    const r = dealDamage(t, { kind: 'mob' }, dmg);
    expect(r.final).toBeCloseTo(expected, 5);
    expect(t.health).toBeCloseTo(20 - expected, 5);
  });

  it('reports armor wear max(1, floor(damage / 4)) of the raw damage', () => {
    const wears: number[] = [];
    dealDamage(target({ armorPoints: 10 }), { kind: 'mob' }, 9, { onArmorWear: (w) => wears.push(w) });
    dealDamage(target({ armorPoints: 10 }), { kind: 'mob' }, 2, { onArmorWear: (w) => wears.push(w) });
    expect(wears).toEqual([2, 1]);
  });

  it('ignores armor for fall, drowning and starvation', () => {
    for (const kind of ['fall', 'drown', 'starve', 'poison', 'void'] as const) {
      const t = target({ armorPoints: 20, armorToughness: 8 });
      expect(dealDamage(t, { kind }, 5).final).toBe(5);
    }
  });
});

describe('difficulty', () => {
  it('scales mob damage to the player only', () => {
    const dmg = (difficulty: 'peaceful' | 'easy' | 'normal' | 'hard', kind: 'mob' | 'fall' = 'mob'): number => {
      const t = target();
      dealDamage(t, { kind }, 5, { difficulty });
      return 20 - t.health;
    };
    expect(dmg('peaceful')).toBe(0);
    expect(dmg('easy')).toBe(3.5);
    expect(dmg('normal')).toBe(5);
    expect(dmg('hard')).toBe(7.5);
    expect(dmg('hard', 'fall')).toBe(5);
  });

  it('does not scale damage a player did', () => {
    const t = target();
    dealDamage(t, { kind: 'mob', byPlayer: true }, 5, { difficulty: 'hard' });
    expect(t.health).toBe(15);
  });

  it('Peaceful mob damage leaves no invulnerability frames behind', () => {
    const t = target();
    const r = dealDamage(t, { kind: 'mob' }, 5, { difficulty: 'peaceful' });
    expect(r.hurt).toBe(false);
    expect(t.invulnerableTicks).toBe(0);
  });
});

describe('invulnerability frames', () => {
  it('blocks equal and smaller hits for 10 ticks, and lets the extra of a bigger hit through', () => {
    const t = target();
    expect(dealDamage(t, { kind: 'mob' }, 4).hurt).toBe(true);
    expect(t.invulnerableTicks).toBe(INVULNERABLE_TICKS);
    expect(dealDamage(t, { kind: 'mob' }, 4).hurt).toBe(false);
    expect(dealDamage(t, { kind: 'mob' }, 3).hurt).toBe(false);
    expect(t.health).toBe(16);
    expect(dealDamage(t, { kind: 'mob' }, 7).dealt).toBe(3);
    expect(t.health).toBe(13);
    // The frames were not restarted by the bigger hit.
    expect(t.invulnerableTicks).toBe(INVULNERABLE_TICKS);
    expect(dealDamage(t, { kind: 'mob' }, 7).hurt).toBe(false);
  });

  it('accepts a new hit once the frames are over', () => {
    const t = target();
    dealDamage(t, { kind: 'mob' }, 4);
    t.invulnerableTicks = 0;
    expect(dealDamage(t, { kind: 'mob' }, 4).dealt).toBe(4);
  });

  it('applies to mobs through Mob.hurt', () => {
    const z = new Mob(MOB_TYPES.zombie);
    const hp = z.health;
    expect(z.hurt(4, 0, 0)).toBe(true);
    expect(z.hurt(4, 0, 0)).toBe(false);
    expect(z.health).toBe(hp - 4);
    expect(z.hurt(6, 0, 0)).toBe(true);
    expect(z.health).toBe(hp - 6);
  });
});

describe('absorption, resistance, shield, game rules', () => {
  it('absorption takes the hit before health', () => {
    const t = target({ absorption: 4 });
    const r = dealDamage(t, { kind: 'mob' }, 6);
    expect(r.absorbed).toBe(4);
    expect(r.dealt).toBe(2);
    expect(t.absorption).toBe(0);
    expect(t.health).toBe(18);
  });

  it('Resistance cuts 20 % per level, except for the void and starvation', () => {
    const t = target({ resistance: () => 2 });
    expect(dealDamage(t, { kind: 'mob' }, 10).final).toBeCloseTo(6, 5);
    const v = target({ resistance: () => 2 });
    expect(dealDamage(v, { kind: 'void' }, 4).final).toBe(4);
    const s = target({ resistance: () => 5 });
    expect(dealDamage(s, { kind: 'mob' }, 10).hurt).toBe(true);
    expect(s.health).toBe(20);
  });

  it('a shield hook blocks blockable hits only', () => {
    const blocked = (): boolean => true;
    const t = target();
    const r = dealDamage(t, { kind: 'mob' }, 5, { blocked });
    expect(r.blocked).toBe(true);
    expect(t.health).toBe(20);
    expect(t.invulnerableTicks).toBe(0);
    dealDamage(t, { kind: 'fall' }, 3, { blocked });
    expect(t.health).toBe(17);
  });

  it('game rules switch fall, fire and drowning damage off; Fire Resistance ignores fire and lava', () => {
    const rules = new GameRules();
    rules.set('fallDamage', false);
    rules.set('drowningDamage', false);
    expect(dealDamage(target(), { kind: 'fall' }, 5, { rules }).hurt).toBe(false);
    expect(dealDamage(target(), { kind: 'drown' }, 2, { rules }).hurt).toBe(false);
    expect(dealDamage(target(), { kind: 'fire' }, 1, { rules }).hurt).toBe(true);
    rules.set('fireDamage', false);
    expect(dealDamage(target(), { kind: 'lava' }, 4, { rules }).hurt).toBe(false);
    expect(dealDamage(target({ fireImmune: () => true }), { kind: 'lava' }, 4).hurt).toBe(false);
  });
});

describe('enchantment hooks', () => {
  const undo: (() => void)[] = [];
  afterEach(() => { while (undo.length) undo.pop()!(); });

  it('run in order: pre before armor, post after armor and Resistance, sorted by order', () => {
    const log: string[] = [];
    undo.push(registerDamageModifier({ id: 'b', stage: 'post', order: 2, apply: (a) => { log.push(`b:${a.toFixed(2)}`); return a; } }));
    undo.push(registerDamageModifier({ id: 'a', stage: 'post', order: 1, apply: (a) => { log.push(`a:${a.toFixed(2)}`); return a * 0.5; } }));
    undo.push(registerDamageModifier({ id: 'p', stage: 'pre', apply: (a) => { log.push(`p:${a.toFixed(2)}`); return a; } }));
    const t = target({ armorPoints: 20, armorToughness: 8, resistance: () => 1 });
    dealDamage(t, { kind: 'mob' }, 10);
    // 10 → armor 3.0 → Resistance I 2.4 → a halves it → b sees 1.2.
    expect(log).toEqual(['p:10.00', 'a:2.40', 'b:1.20']);
    expect(t.health).toBeCloseTo(18.8, 5);
  });

  it('Protection: damage × (1 − EPF / 25), EPF capped at 20', () => {
    expect(protectionFactor(4)).toBeCloseTo(0.84, 5);
    expect(protectionFactor(25)).toBeCloseTo(0.2, 5);
    undo.push(registerDamageModifier({ id: 'prot', apply: (a, ctx) => a * protectionFactor(ctx.target.enchantLevel?.('protection') ?? 0) }));
    const t = target({ enchantLevel: (n) => (n === 'protection' ? 16 : 0) });
    dealDamage(t, { kind: 'mob' }, 10);
    expect(t.health).toBeCloseTo(20 - 3.6, 5);
  });

  it('replaces a modifier with the same id and can be removed again', () => {
    const off = registerDamageModifier({ id: 'x', apply: () => 0 });
    registerDamageModifier({ id: 'x', apply: (a) => a });
    expect(dealDamage(target(), { kind: 'mob' }, 4).final).toBe(4);
    off();
    undo.push(registerDamageModifier({ id: 'x', apply: () => 0 }));
    expect(dealDamage(target(), { kind: 'mob' }, 4).final).toBe(0);
  });
});

describe('PlayerStats.hurt', () => {
  it('uses the pipeline, wears armor and writes the death message with the killer', () => {
    const stats = new PlayerStats();
    stats.armorPoints = 15;
    let wear = 0;
    stats.onArmorHit = (w) => { wear = w; };
    stats.difficulty = 'hard';
    stats.playerName = 'Stijn';
    // Zombie 3 × 1.5 = 4.5; iron: 15 − 4.5/2 → 12.75 ... reduction 0.51 → 2.205
    const r = stats.hurt(3, { kind: 'mob', attacker: 'Zombie' }, 'survival');
    expect(r.hurt).toBe(true);
    expect(wear).toBe(Math.max(1, Math.floor(3 / 4)));
    expect(stats.health).toBeLessThan(18);
    stats.health = 1;
    stats.invulnerableTicks = 0;
    stats.hurt(3, { kind: 'mob', attacker: 'Zombie' }, 'survival');
    expect(stats.dead).toBe(true);
    expect(stats.deathMessage).toBe('Stijn was slain by Zombie');
  });

  it('creative takes no damage except from the void', () => {
    const stats = new PlayerStats();
    expect(stats.hurt(5, { kind: 'mob' }, 'creative').hurt).toBe(false);
    expect(stats.hurt(4, { kind: 'void' }, 'creative').hurt).toBe(true);
  });

  it('Absorption soaks the damage and the effect end removes what is left', () => {
    const stats = new PlayerStats();
    stats.effects.add('absorption', 0, 20, stats);
    expect(stats.absorption).toBe(4);
    stats.hurt(3, { kind: 'mob' }, 'survival');
    expect(stats.health).toBe(20);
    expect(stats.absorption).toBe(1);
  });
});

describe('death messages', () => {
  it('translates the vanilla ones', () => {
    expect(deathMessage('Steve', { kind: 'mob', attacker: 'Zombie' })).toBe('Steve was slain by Zombie');
    expect(deathMessage('Steve', { kind: 'arrow', attacker: 'Skeleton' })).toBe('Steve was shot by Skeleton');
    expect(deathMessage('Steve', { kind: 'explosion', attacker: 'Creeper' })).toBe('Steve was blown up by Creeper');
    expect(deathMessage('Steve', { kind: 'explosion' })).toBe('Steve blew up');
    expect(deathMessage('Steve', { kind: 'fall' })).toBe('Steve fell from a high place');
    expect(deathMessage('Steve', { kind: 'drown' })).toBe('Steve drowned');
    expect(deathMessage('Steve', { kind: 'lava' })).toBe('Steve tried to swim in lava');
    expect(deathMessage('Steve', { kind: 'cactus' })).toBe('Steve was pricked to death');
    expect(deathMessage('Steve', { kind: 'void' })).toBe('Steve fell out of the world');
    expect(deathMessage('Steve', { kind: 'starve' })).toBe('Steve starved to death');
    expect(deathMessage('Steve', { kind: 'lightning' })).toBe('Steve was struck by lightning');
    expect(deathMessage('Steve', { kind: 'anvil' })).toBe('Steve was squashed by a falling anvil');
    expect(deathMessage('Steve', { kind: 'poison' })).toBe('Steve was killed by magic');
  });
});

describe('balance audit fixes', () => {
  it('burning ignores armor, lightning and lava are reduced by it', () => {
    expect(dealDamage(target({ armorPoints: 20 }), { kind: 'fire' }, 1).final).toBe(1);
    expect(dealDamage(target({ armorPoints: 20 }), { kind: 'lightning' }, 5).final).toBeLessThan(5);
    expect(dealDamage(target({ armorPoints: 20 }), { kind: 'lava' }, 4).final).toBeLessThan(4);
  });

  it('zombies have 2 natural armor', () => {
    const z = new Mob(MOB_TYPES.zombie);
    expect(z.armorPoints).toBe(2);
    expect(new Mob(MOB_TYPES.pig).armorPoints).toBe(0);
  });
});
