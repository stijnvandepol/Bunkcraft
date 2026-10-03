/**
 * Enchantment rules (Minecraft Java 1.21, Minecraft Wiki: Enchanting mechanics): what each enchantment does, how
 * strong it can be, what it excludes and what it costs. A leaf module: no registry imports, so the item registry,
 * the server and the tests can all use it. Enchantments live on `ItemStack.data` under the key names of
 * `ITEM_DATA_KEYS`; a stack with an enchantment is a different item for stacking and saving.
 */

/** What an enchantment can go on (one item matches several of these, see Enchanting.targetsOf). */
export type EnchantTarget = 'armor' | 'helmet' | 'boots' | 'sword' | 'axe' | 'pickaxe' | 'shovel' | 'hoe' | 'shears' | 'bow' | 'durable' | 'weapon' | 'digger';

export interface EnchantDef {
  /** Key in ItemStack.data. */
  key: string;
  name: string;
  max: number;
  /** Chance weight in the enchanting table (common 10, uncommon 5, rare 2, very rare 1). */
  weight: number;
  /** Item groups it can be applied to (any match is enough). */
  targets: EnchantTarget[];
  /** Keys that cannot be on the same item. */
  conflicts: string[];
  /** Level cost curve: the enchantment is offered when `min(l) <= power <= max(l)`. */
  minPower(level: number): number;
  maxPower(level: number): number;
  /** Anvil cost multiplier when combining with an item / with a book. */
  anvilItem: number;
  anvilBook: number;
  /** Only found by other means (books, anvil, commands): never offered by the table. */
  treasure?: boolean;
  curse?: boolean;
}

const PROT = ['protection', 'fire_protection', 'blast_protection', 'projectile_protection'];
const without = (list: string[], key: string): string[] => list.filter((k) => k !== key);
const DAMAGE = ['sharpness', 'smite', 'bane_of_arthropods'];

function def(key: string, name: string, max: number, weight: number, targets: EnchantTarget[], conflicts: string[],
  min: (l: number) => number, span: number, anvilItem: number, anvilBook: number, extra: Partial<EnchantDef> = {}): EnchantDef {
  return { key, name, max, weight, targets, conflicts, minPower: min, maxPower: (l) => min(l) + span, anvilItem, anvilBook, ...extra };
}

/** In the order shown in tooltips of items that carry several. */
export const ENCHANTS: EnchantDef[] = [
  def('protection', 'Protection', 4, 10, ['armor'], without(PROT, 'protection'), (l) => 1 + (l - 1) * 11, 11, 1, 1),
  def('fire_protection', 'Fire Protection', 4, 5, ['armor'], without(PROT, 'fire_protection'), (l) => 10 + (l - 1) * 8, 8, 2, 1),
  def('blast_protection', 'Blast Protection', 4, 2, ['armor'], without(PROT, 'blast_protection'), (l) => 5 + (l - 1) * 8, 8, 4, 2),
  def('projectile_protection', 'Projectile Protection', 4, 5, ['armor'], without(PROT, 'projectile_protection'), (l) => 3 + (l - 1) * 6, 6, 2, 1),
  def('feather_falling', 'Feather Falling', 4, 5, ['boots'], [], (l) => 5 + (l - 1) * 6, 6, 2, 1),
  def('respiration', 'Respiration', 3, 2, ['helmet'], [], (l) => 10 * l, 30, 4, 2),
  def('aqua_affinity', 'Aqua Affinity', 1, 2, ['helmet'], [], () => 1, 40, 4, 2),
  def('thorns', 'Thorns', 3, 1, ['armor'], [], (l) => 10 + (l - 1) * 20, 50, 8, 4),
  def('depth_strider', 'Depth Strider', 3, 2, ['boots'], [], (l) => 10 * l, 15, 4, 2),
  def('sharpness', 'Sharpness', 5, 10, ['sword', 'axe'], without(DAMAGE, 'sharpness'), (l) => 1 + (l - 1) * 11, 20, 1, 1),
  def('smite', 'Smite', 5, 5, ['sword', 'axe'], without(DAMAGE, 'smite'), (l) => 5 + (l - 1) * 8, 20, 2, 1),
  def('bane_of_arthropods', 'Bane of Arthropods', 5, 5, ['sword', 'axe'], without(DAMAGE, 'bane_of_arthropods'), (l) => 5 + (l - 1) * 8, 20, 2, 1),
  def('knockback', 'Knockback', 2, 5, ['sword'], [], (l) => 5 + (l - 1) * 20, 50, 2, 1),
  def('fire_aspect', 'Fire Aspect', 2, 2, ['sword'], [], (l) => 10 + (l - 1) * 20, 50, 4, 2),
  def('looting', 'Looting', 3, 2, ['sword'], [], (l) => 15 + (l - 1) * 9, 50, 4, 2),
  // Swords have no sweep attack here yet; the enchantment can be applied and `sweepDamage` is ready for it.
  def('sweeping_edge', 'Sweeping Edge', 3, 2, ['sword'], [], (l) => 5 + (l - 1) * 9, 15, 4, 2),
  def('efficiency', 'Efficiency', 5, 10, ['digger', 'shears'], [], (l) => 1 + (l - 1) * 10, 50, 1, 1),
  def('silk_touch', 'Silk Touch', 1, 1, ['digger'], ['fortune'], () => 15, 50, 8, 4),
  def('fortune', 'Fortune', 3, 2, ['digger'], ['silk_touch'], (l) => 15 + (l - 1) * 9, 50, 4, 2),
  def('unbreaking', 'Unbreaking', 3, 5, ['durable'], [], (l) => 5 + (l - 1) * 8, 50, 2, 1),
  def('power', 'Power', 5, 10, ['bow'], [], (l) => 1 + (l - 1) * 10, 15, 1, 1),
  def('punch', 'Punch', 2, 2, ['bow'], [], (l) => 12 + (l - 1) * 20, 25, 4, 2),
  def('flame', 'Flame', 1, 2, ['bow'], [], () => 20, 30, 4, 2),
  def('infinity', 'Infinity', 1, 1, ['bow'], ['mending'], () => 20, 30, 8, 4),
  def('mending', 'Mending', 1, 2, ['durable'], ['infinity'], (l) => l * 25, 50, 4, 2, { treasure: true }),
];

export const ENCHANT_BY_KEY: ReadonlyMap<string, EnchantDef> = new Map(ENCHANTS.map((e) => [e.key, e]));

export function isEnchantKey(key: string): boolean {
  return ENCHANT_BY_KEY.has(key);
}

// ---------------------------------------------------------------- reading and writing enchantments on a stack's data

export type EnchantMap = Record<string, number>;

/** Valid enchantments (known key, level 1..max) of a stack's data; empty when there are none. */
export function enchantsOf(data: Record<string, number> | undefined): EnchantMap {
  const out: EnchantMap = {};
  if (!data) return out;
  for (const [k, v] of Object.entries(data)) {
    const d = ENCHANT_BY_KEY.get(k);
    if (d && Number.isFinite(v) && v >= 1) out[k] = Math.min(Math.floor(v), d.max);
  }
  return out;
}

export function hasEnchants(data: Record<string, number> | undefined): boolean {
  if (!data) return false;
  for (const k in data) if (ENCHANT_BY_KEY.has(k) && data[k] >= 1) return true;
  return false;
}

export function levelOf(data: Record<string, number> | undefined, key: string): number {
  const v = data?.[key];
  return v && v > 0 ? Math.min(Math.floor(v), ENCHANT_BY_KEY.get(key)?.max ?? 0) : 0;
}

export function conflicts(a: string, b: string): boolean {
  return a !== b && (ENCHANT_BY_KEY.get(a)?.conflicts.includes(b) ?? false);
}

/** Data with the enchantments replaced by `ench` (other entries such as repair cost and name are kept). Undefined when nothing is left. */
export function withEnchants(data: Record<string, number> | undefined, ench: EnchantMap): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (data) for (const [k, v] of Object.entries(data)) if (!ENCHANT_BY_KEY.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(ench)) if (ENCHANT_BY_KEY.has(k) && v >= 1) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** "I", "II", "III", "IV", "V": the level in a tooltip. */
export function roman(n: number): string {
  const table: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/** "Sharpness V", or just the name for enchantments that only have one level. */
export function enchantLabel(key: string, level: number): string {
  const d = ENCHANT_BY_KEY.get(key);
  if (!d) return key;
  return d.max === 1 ? d.name : `${d.name} ${roman(level)}`;
}

/** Tooltip lines of an item's enchantments, in table order. */
export function enchantLines(data: Record<string, number> | undefined): string[] {
  const ench = enchantsOf(data);
  return ENCHANTS.filter((e) => ench[e.key]).map((e) => enchantLabel(e.key, ench[e.key]));
}

// ---------------------------------------------------------------- custom name and repair cost (data keys are numbers)

/** Longest custom name an anvil accepts. */
export const MAX_NAME_LENGTH = 24;
const NAME_KEYS = ['custom_name', 'custom_name_1', 'custom_name_2', 'custom_name_3', 'custom_name_4', 'custom_name_5', 'custom_name_6', 'custom_name_7'];

/** Custom name of a stack: up to three UTF-16 units are packed in each number (48 bits, exact in a double). */
export function customName(data: Record<string, number> | undefined): string {
  if (!data) return '';
  let out = '';
  for (const k of NAME_KEYS) {
    let v = data[k];
    if (!v || v < 0) break;
    for (let i = 0; i < 3; i++) {
      const unit = v % 65536;
      v = Math.floor(v / 65536);
      if (unit) out += String.fromCharCode(unit);
    }
  }
  return out;
}

/** Cleans a typed name: no control characters, trimmed, at most MAX_NAME_LENGTH. */
export function cleanName(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

/** Data with the custom name set (empty text removes it). Undefined when the data would be empty. */
export function withCustomName(data: Record<string, number> | undefined, text: string): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (data) for (const [k, v] of Object.entries(data)) if (!NAME_KEYS.includes(k)) out[k] = v;
  const name = cleanName(text);
  for (let k = 0; k * 3 < name.length; k++) {
    let v = 0;
    for (let i = 2; i >= 0; i--) v = v * 65536 + (name.charCodeAt(k * 3 + i) || 0);
    out[NAME_KEYS[k]] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The anvil's "prior work" penalty (repair_cost): 0, 1, 3, 7, 15 ... */
export function repairCostOf(data: Record<string, number> | undefined): number {
  const v = data?.repair_cost;
  return v && v > 0 ? Math.floor(v) : 0;
}

export function withRepairCost(data: Record<string, number> | undefined, cost: number): Record<string, number> | undefined {
  const out: Record<string, number> = { ...(data ?? {}) };
  if (cost > 0) out.repair_cost = cost; else delete out.repair_cost;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- effects (pure numbers)

/** Extra melee damage: Sharpness 0.5 per level + 0.5, Smite and Bane of Arthropods 2.5 per level against their mobs. */
export function meleeBonus(data: Record<string, number> | undefined, undead: boolean, arthropod: boolean): number {
  const sharp = levelOf(data, 'sharpness');
  let bonus = sharp ? 0.5 * sharp + 0.5 : 0;
  if (undead) bonus += 2.5 * levelOf(data, 'smite');
  if (arthropod) bonus += 2.5 * levelOf(data, 'bane_of_arthropods');
  return bonus;
}

/** Sweeping Edge: the sweep deals `1 + damage × level/(level+1)` (Java Edition). */
export function sweepDamage(damage: number, level: number): number {
  return level > 0 ? 1 + damage * (level / (level + 1)) : 1;
}

/** Fire Aspect burns 4 seconds per level (ticks). */
export function fireAspectTicks(level: number): number {
  return level * 80;
}

/** Looting: up to `level` extra items on every drop (the roll is uniform 0..level). */
export function lootingExtra(level: number, rand: () => number = Math.random): number {
  return level > 0 ? Math.floor(rand() * (level + 1)) : 0;
}

/** Mining speed bonus of Efficiency: level² + 1 added to the tool speed. */
export function efficiencyBonus(level: number): number {
  return level > 0 ? level * level + 1 : 0;
}

/** Chance that a use costs durability: tools and weapons 1/(level+1), armor 60% + 40%/(level+1). */
export function wearChance(level: number, armor: boolean): number {
  if (level <= 0) return 1;
  return armor ? 0.6 + 0.4 / (level + 1) : 1 / (level + 1);
}

/** Does this use cost durability? */
export function takesWear(level: number, armor: boolean, rand: () => number = Math.random): boolean {
  return level <= 0 || rand() < wearChance(level, armor);
}

/** Respiration: the chance that a tick under water takes no air is level/(level+1). */
export function respirationKeepsAir(level: number, rand: () => number = Math.random): boolean {
  return level > 0 && rand() < level / (level + 1);
}

/**
 * Fortune on ores that drop a stack (coal, diamond, emerald, raw metals): the count is multiplied by
 * `1 + max(0, rand(0..level+1) - 1)`: 2 + level choices, so level III gives x1 (40%), x2, x3, x4 (20% each).
 */
export function fortuneMultiplier(level: number, rand: () => number = Math.random): number {
  if (level <= 0) return 1;
  return 1 + Math.max(0, Math.floor(rand() * (level + 2)) - 1);
}

/** Fortune on lapis, redstone, glowstone, melon: up to `level` extra items, capped by the block's own maximum. */
export function fortuneExtra(level: number, rand: () => number = Math.random): number {
  return level > 0 ? Math.floor(rand() * (level + 1)) : 0;
}

/** Fortune on leaves: the sapling chance 1/20 becomes 1/16, 1/12, 1/10 (levels I-III): x1.25, x1.67, x2. */
export function fortuneSaplingChance(base: number, level: number): number {
  return base * [1, 1.25, 5 / 3, 2][Math.min(3, Math.max(0, level))];
}

/** Fortune on gravel: the chance of flint is 10%, 14%, 25% and 100%. */
export function gravelFlintChance(level: number): number {
  return [0.1, 0.14, 0.25, 1][Math.min(3, Math.max(0, level))];
}

/** Power: arrows hit 25% harder per level, plus 25% (Java: +0.5 per level + 0.5). */
export function powerBonus(level: number): number {
  return level > 0 ? 0.5 * level + 0.5 : 0;
}

/** Punch adds knockback strength (the arrow's own knockback scale: 0.5 base). */
export function punchKnockback(level: number): number {
  return level * 0.6;
}

/** Armor enchantment points of one enchantment against a kind of damage (Protection Factor, 4% each). */
export function protectionFactor(key: string, level: number, cause: string): number {
  if (cause === 'void' || cause === 'starve') return 0;
  switch (key) {
    case 'protection': return level;
    case 'fire_protection': return cause === 'fire' || cause === 'lava' || cause === 'lightning' ? level * 2 : 0;
    case 'blast_protection': return cause === 'explosion' ? level * 2 : 0;
    case 'projectile_protection': return cause === 'arrow' ? level * 2 : 0;
    case 'feather_falling': return cause === 'fall' ? level * 3 : 0;
    default: return 0;
  }
}

/** Total Enchantment Protection Factor of a set of worn pieces for one kind of damage (capped at 20). */
export function totalEpf(pieces: readonly (Record<string, number> | undefined)[], cause: string): number {
  let epf = 0;
  for (const data of pieces) {
    if (!data) continue;
    for (const k of ['protection', 'fire_protection', 'blast_protection', 'projectile_protection', 'feather_falling']) {
      const l = levelOf(data, k);
      if (l) epf += protectionFactor(k, l, cause);
    }
  }
  return Math.min(20, epf);
}

/** Damage after Protection enchantments: each point of EPF removes 4%. */
export function reduceByEpf(damage: number, epf: number): number {
  return damage * (1 - Math.min(20, epf) / 25);
}

/** Thorns: each worn piece has a 15% chance per level to reflect 1-4 damage (level >= 4: level - 10 damage). */
export function thornsReflect(pieces: readonly (Record<string, number> | undefined)[], rand: () => number = Math.random): { damage: number; wear: number[] } {
  let damage = 0;
  const wear: number[] = [];
  pieces.forEach((data, slot) => {
    const l = levelOf(data, 'thorns');
    if (l > 0 && rand() < 0.15 * l) {
      damage += l > 10 ? l - 10 : 1 + Math.floor(rand() * 4);
      wear[slot] = 2;
    }
  });
  return { damage, wear };
}

/** Depth Strider: how much of the walking speed is kept under water (0..1): a third per level, level III is full speed. */
export function depthStriderFactor(level: number): number {
  return Math.min(3, Math.max(0, level)) / 3;
}

/** Experience orbs repair 2 durability per point with Mending. */
export const MENDING_PER_XP = 2;
