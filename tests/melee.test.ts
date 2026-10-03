import { describe, expect, it } from 'vitest';
import { ITEM } from '../src/items/ItemRegistry';
import type { ServerMessage } from '../src/net/protocol';
import {
  AttackCooldown, FULL_CHARGE, attackCharge, attackScale, attackSpeedOf, blocksFromDirection, meleeDamage, planAttack, sweepVictims,
} from '../src/player/Melee';
import { type EntityPlayer, ServerEntities } from '../server/ServerEntities';

describe('attack speed table', () => {
  it('follows the wiki per tool and material', () => {
    expect(attackSpeedOf(undefined)).toBe(4);
    expect(attackSpeedOf('iron_sword')).toBe(1.6);
    expect(attackSpeedOf('wooden_axe')).toBe(0.8);
    expect(attackSpeedOf('stone_axe')).toBe(0.8);
    expect(attackSpeedOf('iron_axe')).toBe(0.9);
    expect(attackSpeedOf('diamond_axe')).toBe(1);
    expect(attackSpeedOf('golden_axe')).toBe(1);
    expect(attackSpeedOf('diamond_pickaxe')).toBe(1.2);
    expect(attackSpeedOf('stone_shovel')).toBe(1);
    expect(attackSpeedOf('wooden_hoe')).toBe(1);
    expect(attackSpeedOf('stone_hoe')).toBe(2);
    expect(attackSpeedOf('iron_hoe')).toBe(3);
    expect(attackSpeedOf('diamond_hoe')).toBe(4);
    expect(attackSpeedOf('stick')).toBe(4);
  });
});

describe('cooldown math', () => {
  it('scales damage 0.2 + ((t + 0.5) / T)² × 0.8, clipped', () => {
    // Sword: T = 12.5 ticks.
    expect(attackScale(0, 1.6)).toBeCloseTo(0.2 + (0.5 / 12.5) ** 2 * 0.8, 6);
    expect(attackScale(6, 1.6)).toBeCloseTo(0.2 + (6.5 / 12.5) ** 2 * 0.8, 6);
    expect(attackScale(12, 1.6)).toBe(1);
    expect(attackScale(500, 1.6)).toBe(1);
    // Bare hand: T = 5 ticks.
    expect(attackScale(4.5, 4)).toBe(1);
    expect(attackScale(2, 4)).toBeCloseTo(0.2 + 0.25 * 0.8, 6);
  });

  it('charge reaches the 84.8 % mark about 10 ticks into a sword swing', () => {
    expect(attackCharge(9, 1.6)).toBeLessThan(FULL_CHARGE);
    expect(attackCharge(10.2, 1.6)).toBeGreaterThanOrEqual(FULL_CHARGE);
  });

  it('AttackCooldown restarts on a swing and on changing the held item', () => {
    const c = new AttackCooldown();
    c.advance(1, 1.6, 100);
    expect(c.scale).toBe(1);
    c.swing();
    expect(c.charged).toBe(false);
    expect(c.scale).toBeLessThan(0.21);
    c.advance(1, 1.6, 13);
    expect(c.charged).toBe(true);
    c.advance(2, 1.6, 1); // other item: back to zero
    expect(c.charged).toBe(false);
  });

  it('computes the damage of a hit', () => {
    expect(meleeDamage({ base: 7, scale: 1, crit: false })).toBe(7);
    expect(meleeDamage({ base: 7, scale: 1, crit: true })).toBe(10.5);
    expect(meleeDamage({ base: 7, scale: 0.5, crit: false })).toBe(3.5);
    // Strength II (+6) and Weakness (−4).
    expect(meleeDamage({ base: 7, effectBonus: 6, scale: 1, crit: false })).toBe(13);
    expect(meleeDamage({ base: 1, effectBonus: -4, scale: 1, crit: false })).toBe(0);
    // Enchantment damage is scaled by the swing too, the crit multiplies everything.
    expect(meleeDamage({ base: 4, enchantBonus: 2, scale: 0.5, crit: true })).toBe(4.5);
  });
});

describe('crit, sprint knockback and sweep', () => {
  const base = { charge: 1, onGround: true, fallDistance: 0, inWater: false, sprinting: false, sword: true };
  it('crits only when falling, charged, not sprinting, not in water', () => {
    expect(planAttack({ ...base, onGround: false, fallDistance: 1 }).crit).toBe(true);
    expect(planAttack({ ...base, onGround: false, fallDistance: 1, charge: 0.5 }).crit).toBe(false);
    expect(planAttack({ ...base, onGround: false, fallDistance: 1, sprinting: true }).crit).toBe(false);
    expect(planAttack({ ...base, onGround: false, fallDistance: 1, inWater: true }).crit).toBe(false);
    expect(planAttack({ ...base, onGround: true, fallDistance: 1 }).crit).toBe(false);
    expect(planAttack({ ...base, onGround: false, fallDistance: 0 }).crit).toBe(false);
  });

  it('sprint knockback needs a charged swing and rules out sweep and crit', () => {
    expect(planAttack({ ...base, sprinting: true }).sprintKnock).toBe(true);
    expect(planAttack({ ...base, sprinting: true, charge: 0.3 }).sprintKnock).toBe(false);
    expect(planAttack({ ...base, sprinting: true }).sweep).toBe(false);
  });

  it('sweeps with a charged sword on the ground only', () => {
    expect(planAttack(base).sweep).toBe(true);
    expect(planAttack({ ...base, sword: false }).sweep).toBe(false);
    expect(planAttack({ ...base, onGround: false, fallDistance: 0 }).sweep).toBe(false);
    expect(planAttack({ ...base, charge: 0.5 }).sweep).toBe(false);
  });

  it('sweeps mobs within one block of the target', () => {
    const t = { x: 0, y: 0, z: 0 };
    const near = { x: 1.5, y: 0, z: 0 }, far = { x: 4, y: 0, z: 0 }, high = { x: 0.5, y: 3, z: 0 };
    expect(sweepVictims(t, [t, near, far, high])).toEqual([near]);
  });
});

describe('shield arc', () => {
  it('blocks from the front 100 degrees and not from behind', () => {
    // Yaw 0 looks towards −Z.
    expect(blocksFromDirection(0, 0, -5, 0, 0)).toBe(true);
    expect(blocksFromDirection(0, 3, -3, 0, 0)).toBe(true);
    expect(blocksFromDirection(0, 5, 0, 0, 0)).toBe(false);
    expect(blocksFromDirection(0, 0, 5, 0, 0)).toBe(false);
  });
});

describe('server cooldown', () => {
  function setup() {
    const sent: ServerMessage[] = [];
    const host = {
      send: (_to: number, msg: ServerMessage) => sent.push(msg),
      broadcast: (msg: ServerMessage) => sent.push(msg),
      broadcastBlock: () => undefined,
      broadcastBlocks: () => undefined,
      recordEdit: () => undefined,
    };
    const ents = new ServerEntities(777, {}, 'survival', host, () => 0.25);
    let clock = 10_000;
    ents.attackClock = () => clock;
    const player: EntityPlayer = { id: 1, x: 0.5, y: 80, z: 0.5, flags: 4, held: ITEM.DIAMOND_SWORD, hasPos: true };
    for (let i = 0; i < 300; i++) ents.tick([player]);
    const mob = ents.manager.mobs.find((m) => !m.type.hostile)!;
    mob.health = 1000;
    mob.x = player.x + 1; mob.y = player.y; mob.z = player.z;
    return { ents, player, mob, advance: (ms: number) => { clock += ms; mob.hurtTime = 0; } };
  }

  it('gives full damage for a rested swing and scaled damage for spam clicks', () => {
    const { ents, player, mob, advance } = setup();
    ents.attack(player, mob.netId);
    expect(mob.health).toBe(1000 - 7);
    advance(50);
    ents.attack(player, mob.netId); // 1 tick later: charge (1 + 1.5) / 12.5 = 0.2 → scale 0.2 + 0.04 × 0.8
    expect(1000 - 7 - mob.health).toBeCloseTo(7 * (0.2 + 0.2 ** 2 * 0.8), 5);
    advance(1000);
    const before = mob.health;
    ents.attack(player, mob.netId);
    expect(before - mob.health).toBe(7);
  });

  it('switching the held item restarts the cooldown', () => {
    const { ents, player, mob, advance } = setup();
    ents.attack(player, mob.netId);
    advance(2000);
    player.held = ITEM.IRON_SWORD;
    ents.tick([player]);
    advance(50);
    const before = mob.health;
    ents.attack(player, mob.netId);
    expect(before - mob.health).toBeLessThan(6 * 0.4);
  });
});
