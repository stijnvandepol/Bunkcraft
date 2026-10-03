/**
 * Melee combat of Minecraft 1.9+ (DOM-free: client, server and tests share it). Minecraft Wiki, Damage and Attack cooldown:
 *   - every item has an attack speed; a full swing takes T = 20 / speed ticks
 *   - damage is scaled by 0.2 + ((t + 0.5) / T)² × 0.8, with t the ticks since the last swing (clipped to 0.2..1)
 *   - above 84.8 % charge a falling, non-sprinting hit is a critical (× 1.5) and a sword on the ground sweeps
 *   - a sprinting hit with a charged swing knocks back further (and is never a critical)
 */
export const BARE_HAND_SPEED = 4;
/** Entity interaction range (attribute entity_interaction_range): 3 in survival, 5 in creative. */
export function entityReach(creative: boolean): number {
  return creative ? 5 : 3;
}

/** Cooldown share from which crits, sweeps and sprint knockback are allowed. */
export const FULL_CHARGE = 0.848;
export const CRIT_MULTIPLIER = 1.5;

const AXE_SPEED: Record<string, number> = { wooden: 0.8, stone: 0.8, iron: 0.9, diamond: 1.0, golden: 1.0, netherite: 1.0 };
const HOE_SPEED: Record<string, number> = { wooden: 1, stone: 2, iron: 3, diamond: 4, golden: 1, netherite: 4 };

/** Attack speed (swings per second) of an item by its registry name ("iron_axe"); bare hand and other items 4. */
export function attackSpeedOf(name: string | undefined): number {
  if (!name) return BARE_HAND_SPEED;
  const [material, ...rest] = name.split('_');
  const kind = rest.join('_');
  switch (kind) {
    case 'sword': return 1.6;
    case 'axe': return AXE_SPEED[material] ?? 1;
    case 'pickaxe': return 1.2;
    case 'shovel': return 1;
    case 'hoe': return HOE_SPEED[material] ?? 1;
    default: return BARE_HAND_SPEED;
  }
}

export function isSword(name: string | undefined): boolean {
  return !!name && name.endsWith('_sword');
}

export function isAxe(name: string | undefined): boolean {
  return !!name && name.endsWith('_axe');
}

/** Ticks a full swing takes. */
export function fullSwingTicks(speed: number): number {
  return 20 / speed;
}

/** Charge of the swing, 0..1: (t + 0.5) / T clipped. */
export function attackCharge(ticks: number, speed: number): number {
  return Math.min(1, Math.max(0, (ticks + 0.5) / fullSwingTicks(speed)));
}

/** Damage factor of the swing: 0.2 + charge² × 0.8, so a spammed click does 20 % at least and a full swing 100 %. */
export function attackScale(ticks: number, speed: number): number {
  const c = attackCharge(ticks, speed);
  return 0.2 + c * c * 0.8;
}

/** Tracks the cooldown of one player: ticks since the last swing, reset by a swing or by changing the held item. */
export class AttackCooldown {
  /** Ticks since the last swing; starts charged. */
  ticks = 1000;
  speed = BARE_HAND_SPEED;
  private held = -1;

  /** Advances by `ticks` (1 per game tick, or dt × 20 per frame) with the held item (id and attack speed). */
  advance(held: number, speed: number, ticks = 1): void {
    if (held !== this.held) {
      this.held = held;
      this.ticks = 0;
    }
    this.speed = speed;
    this.ticks = Math.min(1000, this.ticks + ticks);
  }

  get charge(): number {
    return attackCharge(this.ticks, this.speed);
  }

  get scale(): number {
    return attackScale(this.ticks, this.speed);
  }

  get charged(): boolean {
    return this.charge >= FULL_CHARGE;
  }

  /** A swing (attack or air swing) restarts the cooldown. */
  swing(): void {
    this.ticks = 0;
  }

  reset(): void {
    this.ticks = 0;
  }
}

export interface AttackState {
  /** Swing charge 0..1. */
  charge: number;
  onGround: boolean;
  /** Blocks fallen so far (> 0 while falling). */
  fallDistance: number;
  inWater: boolean;
  onLadder?: boolean;
  sprinting: boolean;
  /** Holding a sword. */
  sword: boolean;
  /** Blindness-like effects that forbid a crit (Weakness does not). */
  blind?: boolean;
}

export interface AttackPlan {
  crit: boolean;
  /** Sprint hit with a charged swing: extra knockback. */
  sprintKnock: boolean;
  /** A sword sweep hits nearby mobs. */
  sweep: boolean;
}

/** Decides crit, sprint knockback and sweep for one hit (the wiki rules above). */
export function planAttack(s: AttackState): AttackPlan {
  const charged = s.charge >= FULL_CHARGE;
  const sprintKnock = charged && s.sprinting;
  const crit = charged && !s.onGround && s.fallDistance > 0 && !s.inWater && !s.onLadder && !s.blind && !s.sprinting;
  const sweep = charged && s.sword && s.onGround && !crit && !sprintKnock;
  return { crit, sprintKnock, sweep };
}

export interface DamageParts {
  /** Item damage (sword 7, axe 9 ...), already including the base 1 of the hand. */
  base: number;
  /** Effects: Strength +3 per level, Weakness −4 per level. */
  effectBonus?: number;
  /** Enchantment damage (Sharpness 0.5 × level + 0.5, Smite ...), scaled by the swing like the weapon. */
  enchantBonus?: number;
  scale: number;
  crit: boolean;
}

/** Final damage of a melee hit: (base + effects) × scale, plus enchantment damage × scale, crit × 1.5 on the whole. */
export function meleeDamage(p: DamageParts): number {
  const weapon = Math.max(0, p.base + (p.effectBonus ?? 0));
  let dmg = weapon * p.scale + (p.enchantBonus ?? 0) * p.scale;
  if (p.crit) dmg *= CRIT_MULTIPLIER;
  return dmg;
}

/** Damage of a sweep hit on the bystanders: 1 (plus Sweeping Edge's share of the weapon, given as `edge` 0..1). */
export function sweepDamage(weaponDamage: number, edge = 0): number {
  return 1 + weaponDamage * edge;
}

export interface Positioned { x: number; y: number; z: number; width?: number }

/** Bystanders a sword sweep reaches: within 1 block (edge to edge) horizontally and 1 block vertically of the target. */
export function sweepVictims<T extends Positioned>(target: T, candidates: Iterable<T>): T[] {
  const out: T[] = [];
  for (const c of candidates) {
    if (c === target) continue;
    const reach = 1 + ((c.width ?? 0.6) + (target.width ?? 0.6)) / 2;
    if (Math.hypot(c.x - target.x, c.z - target.z) <= reach && Math.abs(c.y - target.y) <= 1) out.push(c);
  }
  return out;
}

/** Shield: blocks hits from a 100 degree arc in front of the player. `yawToAttacker` is the world direction to the attacker. */
export const SHIELD_ARC = (100 * Math.PI) / 180;

export function blocksFromDirection(playerYaw: number, attackerX: number, attackerZ: number, playerX: number, playerZ: number): boolean {
  // Player forward is (-sin yaw, -cos yaw); compare with the direction to the attacker.
  const fx = -Math.sin(playerYaw), fz = -Math.cos(playerYaw);
  const dx = attackerX - playerX, dz = attackerZ - playerZ;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  const cos = (fx * dx + fz * dz) / len;
  return cos >= Math.cos(SHIELD_ARC / 2);
}
