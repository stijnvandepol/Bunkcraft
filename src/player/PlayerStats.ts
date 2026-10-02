import { BLOCK, OPAQUE, SOLID } from '../world/BlockRegistry';
import type { BlockGetter } from './Collision';
import { type GameMode, hasSurvivalRules } from './GameMode';
import { PHYSICS } from './Physics';
import { ARMOR_CAUSES, armorWear, reduceDamage } from './Armor';
import type { Player } from './Player';

export type DamageCause =
  | 'fall' | 'drown' | 'lava' | 'fire' | 'cactus' | 'void' | 'suffocate' | 'starve' | 'mob' | 'explosion' | 'arrow' | 'poison' | 'lightning';

const DEATH_MESSAGES: Record<DamageCause, string> = {
  fall: 'fell from a high place',
  drown: 'drowned',
  lava: 'tried to swim in lava',
  fire: 'burned to death',
  cactus: 'was pricked to death',
  void: 'fell out of the world',
  suffocate: 'suffocated in a wall',
  starve: 'starved to death',
  mob: 'was slain',
  explosion: 'blew up',
  arrow: 'was shot',
  poison: 'was killed by magic',
  lightning: 'was struck by lightning',
};

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_AIR = 300;

/**
 * Health, hunger and air, ticked at Minecraft's 20 ticks per second so the vanilla
 * numbers apply directly (Minecraft Wiki: Health, Hunger, Damage).
 */
export class PlayerStats {
  health = MAX_HEALTH;
  hunger = MAX_HUNGER;
  saturation = 5;
  exhaustion = 0;
  air = MAX_AIR;
  /** Ticks of invulnerability left after a hit (vanilla: 10). */
  private invulnerable = 0;
  private lastDamage = 0;
  /** Counts down from 10 after taking damage (hurt camera + red flash). */
  hurtTime = 0;
  /** Direction the last hit came from, in radians around Y (for the hurt cam tilt). */
  hurtDirection = 0;
  burnTicks = 0;
  /** Ticks of Poison I left (1 damage every 25 ticks, never below half a heart). */
  poison = 0;
  dead = false;
  deathMessage = '';
  /** The loaded save was made while dead (on the death screen). */
  wasDead = false;
  private regenTimer = 0;
  private starveTimer = 0;
  private hazardTimer = 0;
  /** Fired on every successful hit (sound). */
  onHurt: ((cause: DamageCause) => void) | null = null;
  /** Worn armor points and toughness (set by the game from the armor slots). */
  armorPoints = 0;
  armorToughness = 0;
  /** Fired when armor took a hit: every worn piece loses this much durability. */
  onArmorHit: ((wear: number) => void) | null = null;

  reset(): void {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.invulnerable = 0;
    this.hurtTime = 0;
    this.burnTicks = 0;
    this.poison = 0;
    this.dead = false;
    this.deathMessage = '';
  }

  /** Applies damage with Minecraft's invulnerability-frame rule. Returns true if it hurt. */
  damage(amount: number, cause: DamageCause, mode: GameMode, killer = '', fromYaw?: number): boolean {
    if (this.dead || amount <= 0) return false;
    if (!hasSurvivalRules(mode) && cause !== 'void') return false;
    if (mode === 'spectator') return false;
    if (this.armorPoints > 0 && ARMOR_CAUSES.has(cause)) {
      const raw = amount;
      amount = reduceDamage(amount, this.armorPoints, this.armorToughness);
      this.onArmorHit?.(armorWear(raw));
    }
    let dealt = amount;
    if (this.invulnerable > 0) {
      if (amount <= this.lastDamage) return false;
      dealt = amount - this.lastDamage;
    } else {
      this.invulnerable = 10;
    }
    this.lastDamage = amount;
    this.health = Math.max(0, this.health - dealt);
    this.hurtTime = 10;
    if (fromYaw !== undefined) this.hurtDirection = fromYaw;
    this.exhaustion += 0.1;
    this.onHurt?.(cause);
    if (this.health <= 0) {
      this.dead = true;
      const verb = cause === 'explosion' ? 'was blown up by' : cause === 'arrow' ? 'was shot by' : 'was slain by';
      const by = killer ? ` ${verb} ${killer}` : ` ${DEATH_MESSAGES[cause]}`;
      this.deathMessage = `Player${by}`;
    }
    return true;
  }

  heal(amount: number): void {
    this.health = Math.min(MAX_HEALTH, this.health + amount);
  }

  eat(hunger: number, saturation: number): void {
    this.hunger = Math.min(MAX_HUNGER, this.hunger + hunger);
    this.saturation = Math.min(this.hunger, this.saturation + saturation);
  }

  addExhaustion(v: number): void {
    this.exhaustion = Math.min(40, this.exhaustion + v);
  }

  get canSprint(): boolean {
    return this.hunger > 6;
  }

  /** One game tick (1/20 s). */
  tick(p: Player, getBlock: BlockGetter, mode: GameMode): void {
    if (this.dead) return;
    if (this.invulnerable > 0) this.invulnerable--;
    if (this.hurtTime > 0) this.hurtTime--;

    if (p.y < -64) this.damage(4, 'void', mode);
    if (!hasSurvivalRules(mode)) {
      this.air = MAX_AIR;
      return;
    }

    // Drowning: 300 ticks of air, then 2 damage per second.
    if (p.headInWater) {
      this.air--;
      if (this.air <= -20) {
        this.air = 0;
        this.damage(2, 'drown', mode);
      }
    } else {
      this.air = Math.min(MAX_AIR, this.air + 4);
    }

    // Hazards touching the player box.
    this.hazardTimer++;
    const hw = PHYSICS.WIDTH / 2 + 0.05;
    let lava = false, cactus = false;
    for (let y = Math.floor(p.y); y <= Math.floor(p.y + PHYSICS.HEIGHT); y++) {
      for (let z = Math.floor(p.z - hw); z <= Math.floor(p.z + hw); z++) {
        for (let x = Math.floor(p.x - hw); x <= Math.floor(p.x + hw); x++) {
          const b = getBlock(x, y, z);
          if (b === BLOCK.LAVA) lava = true;
          else if (b === BLOCK.CACTUS) cactus = true;
        }
      }
    }
    if (lava) {
      this.damage(4, 'lava', mode);
      this.burnTicks = 300;
    } else if (this.burnTicks > 0) {
      if (p.inWater) this.burnTicks = 0;
      else if (--this.burnTicks % 20 === 0) this.damage(1, 'fire', mode);
    }
    if (cactus) this.damage(1, 'cactus', mode);
    if (this.poison > 0 && --this.poison % 25 === 0 && this.health > 1) this.damage(1, 'poison', mode);
    const eye = getBlock(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z));
    // Unloaded chunks count as solid for collision, but must not suffocate the player.
    if (eye !== BLOCK.UNLOADED && SOLID[eye] && OPAQUE[eye] && this.hazardTimer % 10 === 0) this.damage(1, 'suffocate', mode);

    // Hunger: every 4 exhaustion removes saturation first, then hunger.
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
    // Natural regeneration (fast with full hunger and saturation) and starvation.
    this.regenTimer++;
    const fast = this.hunger >= MAX_HUNGER && this.saturation > 0;
    if (this.health < MAX_HEALTH && (fast ? this.regenTimer >= 10 : this.hunger >= 18 && this.regenTimer >= 80)) {
      this.heal(1);
      this.addExhaustion(6);
      this.regenTimer = 0;
    }
    if (this.hunger === 0) {
      this.starveTimer++;
      // Normal difficulty stops at half a heart; Hardcore (hard) can starve to death.
      if (this.starveTimer >= 80 && (mode === 'hardcore' || this.health > 1)) {
        this.damage(1, 'starve', mode);
        this.starveTimer = 0;
      }
    }
  }

  serialize(): number[] {
    return [this.health, this.hunger, this.saturation, this.exhaustion, this.air];
  }

  load(d: number[] | undefined): void {
    this.reset();
    this.wasDead = false;
    if (!d) return;
    [this.health, this.hunger, this.saturation, this.exhaustion, this.air] = d;
    if (this.health <= 0) {
      this.wasDead = true;
      this.reset();
    }
  }
}
