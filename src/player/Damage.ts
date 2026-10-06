/**
 * The one damage pipeline (DOM-free: client, server and tests share it). Everything that hurts the player or a mob
 * goes through `dealDamage`, which applies Minecraft's order:
 *
 *   1. game rules (fall, fire and drowning damage), Fire Resistance
 *   2. difficulty (mob damage × 0 / Easy min(D/2+1, D) / × 1 / × 1.5), only when the target is the player
 *   3. invulnerability frames (10 ticks: only a bigger hit does the extra difference)
 *   4. shield blocking hook
 *   5. enchantment hooks, stage `pre` (registerDamageModifier)
 *   6. armor reduction (defense points and toughness) and armor durability
 *   7. Resistance effect (−20 % per level)
 *   8. enchantment hooks, stage `post` (Protection types, Feather Falling: registerDamageModifier)
 *   9. absorption, then health
 */
import { armorWear, reduceDamage } from './Armor';
import { type Difficulty, scaleMobDamage } from '../world/Difficulty';
import type { RuleReader } from '../world/GameRules';

export type DamageKind =
  | 'fall' | 'drown' | 'lava' | 'fire' | 'cactus' | 'void' | 'suffocate' | 'starve' | 'mob' | 'player' | 'explosion' | 'arrow'
  | 'poison' | 'wither' | 'magic' | 'lightning' | 'anvil' | 'generic';

export interface DamageSource {
  kind: DamageKind;
  /** Display name of whoever did it ("Zombie", "Steve"); empty for the environment. */
  attacker?: string;
  /** Direction of the hit in radians (hurt camera tilt). */
  yaw?: number;
  /** The attacker is a player: mob difficulty scaling does not apply. */
  byPlayer?: boolean;
}

interface KindProps {
  /** Armor and toughness reduce it (and wear down). */
  armor: boolean;
  /** Scaled by the difficulty when a mob did it to the player. */
  difficulty: boolean;
  /** A shield may block it. */
  blockable: boolean;
  /** Ignores invulnerability frames. */
  bypassFrames: boolean;
  /** Ignores the Resistance effect (starvation, void). */
  bypassResistance: boolean;
}

const P = (armor: boolean, difficulty: boolean, blockable: boolean, bypassFrames = false, bypassResistance = false): KindProps => (
  { armor, difficulty, blockable, bypassFrames, bypassResistance }
);

export const DAMAGE_PROPS: Record<DamageKind, KindProps> = {
  fall: P(false, false, false),
  drown: P(false, false, false),
  lava: P(true, false, false),
  fire: P(false, false, false), // burning (on_fire) bypasses armor
  cactus: P(true, false, false),
  void: P(false, false, false, false, true),
  suffocate: P(false, false, false),
  starve: P(false, false, false, false, true),
  mob: P(true, true, true),
  player: P(true, false, true),
  explosion: P(true, true, true),
  arrow: P(true, true, true),
  poison: P(false, false, false),
  wither: P(false, false, false),
  magic: P(false, false, false),
  lightning: P(true, false, false),
  anvil: P(true, false, false),
  generic: P(false, false, false),
};

/** Anything that can be hurt: the player's stats or a mob. Mutated by `dealDamage`. */
export interface DamageTarget {
  health: number;
  /** Extra health from the Absorption effect, lost first. */
  absorption: number;
  /** Ticks of invulnerability left after a hit (the owner counts it down). */
  invulnerableTicks: number;
  /** Raw amount of the last hit that got through. */
  lastDamage: number;
  armorPoints: number;
  armorToughness: number;
  /** Resistance level and fire immunity; absent for mobs. */
  resistance?(): number;
  fireImmune?(): boolean;
  /** Total enchantment level of a kind worn or held by the target ("protection": all armor pieces). */
  enchantLevel?(name: string): number;
}

export interface DamageContext {
  /** Set only for the player: mob damage scales with it. */
  difficulty?: Difficulty;
  rules?: RuleReader;
  /** Shield hook: true when the hit is blocked (nothing is dealt). */
  blocked?(source: DamageSource, amount: number): boolean;
  /** Armor took a hit: every worn piece loses this much durability. */
  onArmorWear?(wear: number): void;
}

export interface DamageResult {
  /** The target was hurt (health or absorption dropped). */
  hurt: boolean;
  /** Health actually lost. */
  dealt: number;
  /** Absorbed by the Absorption effect. */
  absorbed: number;
  blocked: boolean;
  /** The amount after the difficulty, before invulnerability and armor. */
  scaled: number;
  /** The amount that reached health and absorption after every reduction. */
  final: number;
  /** The target's health is 0 or less. */
  died: boolean;
}

export const INVULNERABLE_TICKS = 10;

export interface DamageModifierContext {
  source: DamageSource;
  target: DamageTarget;
  /** Raw amount the hit started with. */
  raw: number;
}

export interface DamageModifier {
  id: string;
  /** `pre` runs before armor, `post` (default) after armor and Resistance, like Protection enchantments. */
  stage?: 'pre' | 'post';
  /** Lower runs first; equal orders keep registration order. */
  order?: number;
  apply(amount: number, ctx: DamageModifierContext): number;
}

const modifiers: DamageModifier[] = [];

/** Registers an enchantment-style modifier; returns a function that removes it again. Same id replaces. */
export function registerDamageModifier(mod: DamageModifier): () => void {
  const at = modifiers.findIndex((m) => m.id === mod.id);
  if (at >= 0) modifiers.splice(at, 1);
  modifiers.push(mod);
  return () => {
    const i = modifiers.indexOf(mod);
    if (i >= 0) modifiers.splice(i, 1);
  };
}

function modifiersFor(stage: 'pre' | 'post'): DamageModifier[] {
  return modifiers.filter((m) => (m.stage ?? 'post') === stage).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Protection enchantments: damage × (1 − min(20, EPF) / 25). EPF per level: Protection 1, Fire/Blast/Projectile 2, Feather Falling 3. */
export function protectionFactor(epf: number): number {
  return 1 - Math.min(20, Math.max(0, epf)) / 25;
}

export function dealDamage(t: DamageTarget, source: DamageSource, amount: number, ctx: DamageContext = {}): DamageResult {
  const none: DamageResult = { hurt: false, dealt: 0, absorbed: 0, blocked: false, scaled: 0, final: 0, died: t.health <= 0 };
  if (t.health <= 0 || !(amount > 0)) return none;
  const props = DAMAGE_PROPS[source.kind];

  // 1. game rules and immunities
  const rules = ctx.rules;
  if (rules) {
    if (source.kind === 'fall' && !rules.get('fallDamage')) return none;
    if ((source.kind === 'fire' || source.kind === 'lava') && !rules.get('fireDamage')) return none;
    if (source.kind === 'drown' && !rules.get('drowningDamage')) return none;
  }
  if ((source.kind === 'fire' || source.kind === 'lava') && t.fireImmune?.()) return none;

  // 2. difficulty
  const raw = amount;
  if (props.difficulty && ctx.difficulty && !source.byPlayer) amount = scaleMobDamage(ctx.difficulty, amount);
  if (!(amount > 0)) return { ...none, scaled: 0 };
  const scaled = amount;

  // 3. invulnerability frames: inside them only the extra of a bigger hit counts
  let frames = false;
  if (t.invulnerableTicks > 0 && !props.bypassFrames) {
    if (amount <= t.lastDamage) return { ...none, scaled };
    frames = true;
  }
  const previous = frames ? t.lastDamage : 0;

  // 4. shield
  if (props.blockable && ctx.blocked?.(source, amount)) return { ...none, blocked: true, scaled };

  // The part of the hit that is new (everything outside the frames, the difference inside them).
  amount -= previous;
  const mctx: DamageModifierContext = { source, target: t, raw };

  // 5. enchantments before armor
  for (const m of modifiersFor('pre')) amount = Math.max(0, m.apply(amount, mctx));

  // 6. armor
  if (props.armor && t.armorPoints > 0) {
    amount = reduceDamage(amount, t.armorPoints, t.armorToughness);
    ctx.onArmorWear?.(armorWear(raw));
  }

  // 7. Resistance
  if (!props.bypassResistance && t.resistance) amount *= Math.max(0, 1 - 0.2 * t.resistance());

  // 8. enchantments after armor
  for (const m of modifiersFor('post')) amount = Math.max(0, m.apply(amount, mctx));

  // 9. absorption, then health
  const absorbed = Math.min(t.absorption, amount);
  t.absorption -= absorbed;
  const dealt = amount - absorbed;
  t.health -= dealt; // may go below 0: mobs keep the overkill, PlayerStats clamps
  t.lastDamage = scaled;
  if (!frames && !props.bypassFrames) t.invulnerableTicks = INVULNERABLE_TICKS;
  return { hurt: true, dealt, absorbed, blocked: false, scaled, final: amount, died: t.health <= 0 };
}

// ---------------------------------------------------------------- death messages

/** Minecraft's death messages, without the player's name: "was slain by Zombie", "fell from a high place". */
export function deathText(source: DamageSource): string {
  const by = source.attacker ? ` ${source.attacker}` : '';
  switch (source.kind) {
    case 'mob':
    case 'player': return source.attacker ? `was slain by${by}` : 'was slain';
    case 'arrow': return source.attacker ? `was shot by${by}` : 'was shot by an arrow';
    case 'explosion': return source.attacker ? `was blown up by${by}` : 'blew up';
    case 'fall': return 'fell from a high place';
    case 'drown': return 'drowned';
    case 'lava': return 'tried to swim in lava';
    case 'fire': return 'burned to death';
    case 'cactus': return 'was pricked to death';
    case 'void': return 'fell out of the world';
    case 'suffocate': return 'suffocated in a wall';
    case 'starve': return 'starved to death';
    case 'poison':
    case 'magic': return source.attacker ? `was killed by${by} using magic` : 'was killed by magic';
    case 'wither': return 'withered away';
    case 'lightning': return 'was struck by lightning';
    case 'anvil': return 'was squashed by a falling anvil';
    default: return 'died';
  }
}

export function deathMessage(victim: string, source: DamageSource): string {
  return `${victim} ${deathText(source)}`;
}
