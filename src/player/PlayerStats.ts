import { BLOCK, OPAQUE, SOLID } from '../world/BlockRegistry';
import { type Difficulty, DEFAULT_DIFFICULTY, hostilesAllowed, starvationFloor } from '../world/Difficulty';
import type { GameRules } from '../world/GameRules';
import type { BlockGetter } from './Collision';
import { type DamageResult, type DamageSource, type DamageTarget, dealDamage, deathMessage } from './Damage';
import { EffectSet, type EffectHost } from './Effects';
import { type GameMode, hasSurvivalRules } from './GameMode';
import { PHYSICS } from './Physics';
import type { Player } from './Player';
import { Experience } from './Experience';
import { respirationKeepsAir } from '../items/EnchantRules';

/** Why something hurt the player; the `kind` of a DamageSource (see Damage.ts). */
export type DamageCause = DamageSource['kind'];

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_AIR = 300;

/**
 * Health, hunger and air, ticked at Minecraft's 20 ticks per second so the vanilla
 * numbers apply directly (Minecraft Wiki: Health, Hunger, Damage).
 */
export class PlayerStats implements DamageTarget, EffectHost {
  health = MAX_HEALTH;
  hunger = MAX_HUNGER;
  saturation = 5;
  exhaustion = 0;
  air = MAX_AIR;
  /** Ticks of invulnerability left after a hit (vanilla: 10). */
  invulnerableTicks = 0;
  lastDamage = 0;
  /** Extra health from the Absorption effect. */
  absorption = 0;
  readonly maxHealth = MAX_HEALTH;
  /** Active status effects (Effects.ts); ticked here, saved by the game. */
  readonly effects = new EffectSet();
  /** World difficulty and rules, set by the game (the server never needs them: it does not hurt players itself). */
  difficulty: Difficulty = DEFAULT_DIFFICULTY;
  rules: GameRules | null = null;
  /** Name in death messages. */
  playerName = 'Player';
  /** Shield hook: true when the hit is blocked. */
  blocker: ((source: DamageSource, amount: number) => boolean) | null = null;
  /** Enchantment levels worn or held (Protection etc.): filled in by the enchanting system. */
  enchantLookup: ((name: string) => number) | null = null;
  /** Counts down from 10 after taking damage (hurt camera + red flash). */
  hurtTime = 0;
  /** Direction the last hit came from, in radians around Y (for the hurt cam tilt). */
  hurtDirection = 0;
  burnTicks = 0;
  dead = false;
  deathMessage = '';
  /** The loaded save was made while dead (on the death screen). */
  wasDead = false;
  private regenTimer = 0;
  private peacefulTimer = 0;
  private currentMode: GameMode = 'survival';
  private hazardTimer = 0;
  /** Fired on every successful hit (sound). */
  onHurt: ((cause: DamageCause) => void) | null = null;
  /** Worn armor points and toughness (set by the game from the armor slots). */
  armorPoints = 0;
  armorToughness = 0;
  /** Fired when armor took a hit: every worn piece loses this much durability. */
  onArmorHit: ((wear: number) => void) | null = null;
  /** Experience points and level (saved with the stats). */
  readonly xp = new Experience();
  /** Seed of the enchanting table's offers; changes after every enchant (saved with the stats). */
  enchantSeed = (Math.random() * 0x7fffffff) | 0;
  /** Respiration level of the worn helmet (air lasts longer). */
  respiration = 0;

  reset(): void {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.invulnerableTicks = 0;
    this.lastDamage = 0;
    this.hurtTime = 0;
    this.burnTicks = 0;
    this.absorption = 0;
    this.effects.clear();
    this.dead = false;
    this.deathMessage = '';
  }

  resistance(): number { return this.effects.level('resistance'); }
  fireImmune(): boolean { return this.effects.fireImmune; }
  enchantLevel(name: string): number { return this.enchantLookup?.(name) ?? 0; }

  /** Legacy shape of `hurt`: a cause, an optional killer's name and the direction of the hit. */
  damage(amount: number, cause: DamageCause, mode: GameMode, killer = '', fromYaw?: number): boolean {
    return this.hurt(amount, { kind: cause, attacker: killer || undefined, yaw: fromYaw }, mode).hurt;
  }

  /**
   * The player takes damage through the central pipeline (Damage.ts): difficulty, invulnerability frames, shield,
   * armor, Resistance, enchantments, absorption. Creative and spectator ignore everything but the void.
   */
  hurt(amount: number, source: DamageSource, mode: GameMode): DamageResult {
    const none = { hurt: false, dealt: 0, absorbed: 0, blocked: false, scaled: 0, final: 0, died: this.dead };
    if (this.dead || amount <= 0) return none;
    if (!hasSurvivalRules(mode) && source.kind !== 'void') return none;
    if (mode === 'spectator') return none;
    const r = dealDamage(this, source, amount, {
      difficulty: this.difficulty,
      rules: this.rules ?? undefined,
      blocked: this.blocker ?? undefined,
      onArmorWear: this.onArmorHit ?? undefined,
    });
    if (!r.hurt) return r;
    this.health = Math.max(0, this.health);
    this.hurtTime = 10;
    if (source.yaw !== undefined) this.hurtDirection = source.yaw;
    this.exhaustion += 0.1;
    this.onHurt?.(source.kind);
    if (this.health <= 0) {
      this.dead = true;
      this.deathMessage = deathMessage(this.playerName, source);
    }
    return r;
  }

  /** Damage over time and Instant Damage from effects (Poison cannot kill). */
  effectDamage(amount: number, kind: 'poison' | 'wither' | 'magic', canKill: boolean): void {
    if (!canKill && this.health <= 1) return;
    this.hurt(canKill ? amount : Math.min(amount, this.health - 1), { kind }, this.currentMode);
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
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.hurtTime > 0) this.hurtTime--;

    this.currentMode = mode;
    if (p.y < -64) this.damage(4, 'void', mode);
    this.effects.tick(this);
    if (this.dead) return;
    if (!hasSurvivalRules(mode)) {
      this.air = MAX_AIR;
      return;
    }

    // Drowning: 300 ticks of air, then 2 damage per second.
    if (p.headInWater && !this.effects.waterBreathing) {
      if (!respirationKeepsAir(this.respiration)) this.air--;
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
    const eye = getBlock(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z));
    // Unloaded chunks count as solid for collision, but must not suffocate the player.
    if (eye !== BLOCK.UNLOADED && SOLID[eye] && OPAQUE[eye] && this.hazardTimer % 10 === 0) this.damage(1, 'suffocate', mode);

    // Hunger: every 4 exhaustion removes saturation first, then hunger.
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
    // Peaceful: hunger refills and health comes back by itself, about 1 per second.
    if (!hostilesAllowed(this.difficulty)) {
      if (this.hunger < MAX_HUNGER) this.hunger = Math.min(MAX_HUNGER, this.hunger + 1);
      if (this.health < MAX_HEALTH && ++this.peacefulTimer >= 20) {
        this.peacefulTimer = 0;
        this.heal(1);
      }
    }
    // Natural regeneration and starvation share one timer, like Minecraft's FoodData: it only runs while one of
    // them applies, so a hit at full health does not heal at once. The naturalRegeneration rule switches healing off.
    const natural = this.rules ? this.rules.get('naturalRegeneration') : true;
    const hurt = natural && this.health < MAX_HEALTH;
    if (hurt && this.hunger >= MAX_HUNGER && this.saturation > 0) {
      // Saturation boost: every 10 ticks heal min(saturation, 6) / 6 for min(saturation, 6) exhaustion.
      if (++this.regenTimer >= 10) {
        const f = Math.min(this.saturation, 6);
        this.heal(f / 6);
        this.addExhaustion(f);
        this.regenTimer = 0;
      }
    } else if (hurt && this.hunger >= 18) {
      if (++this.regenTimer >= 80) {
        this.heal(1);
        this.addExhaustion(6);
        this.regenTimer = 0;
      }
    } else if (this.hunger <= 0) {
      // Easy stops at 10 health, Normal at half a heart; Hard and Hardcore can starve to death.
      if (++this.regenTimer >= 80) {
        if (this.health > starvationFloor(this.difficulty, mode === 'hardcore')) this.damage(1, 'starve', mode);
        this.regenTimer = 0;
      }
    } else {
      this.regenTimer = 0;
    }
  }

  serialize(): number[] {
    return [this.health, this.hunger, this.saturation, this.exhaustion, this.air, this.xp.total, this.enchantSeed];
  }

  load(d: number[] | undefined): void {
    this.reset();
    this.wasDead = false;
    this.xp.set(0);
    if (!d) return;
    [this.health, this.hunger, this.saturation, this.exhaustion, this.air] = d;
    // Experience and the enchanting seed were added later (absent in old saves).
    this.xp.set(Number.isFinite(d[5]) ? d[5] : 0);
    if (Number.isFinite(d[6])) this.enchantSeed = d[6] | 0;
    if (this.health <= 0) {
      this.wasDead = true;
      this.reset();
    }
  }
}
