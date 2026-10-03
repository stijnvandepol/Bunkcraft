/**
 * Game rules (DOM-free: the browser, the Node server and the tests share it). A typed table of rules with a default,
 * a parser for `/gamerule <name> [value]`, and a plain-JSON form for WorldMeta and world.json. Only values that differ
 * from the default are saved, so adding a rule never changes an existing world.
 */
export type RuleKind = 'boolean' | 'integer';

interface RuleDef<T extends boolean | number> {
  kind: RuleKind;
  default: T;
  label: string;
  hint: string;
  min?: number;
  max?: number;
}

const bool = (def: boolean, label: string, hint: string): RuleDef<boolean> => ({ kind: 'boolean', default: def, label, hint });
const int = (def: number, min: number, max: number, label: string, hint: string): RuleDef<number> => ({ kind: 'integer', default: def, min, max, label, hint });

export const RULE_DEFS = {
  keepInventory: bool(false, 'Keep inventory', 'Keep your items when you die'),
  doMobSpawning: bool(true, 'Mob spawning', 'Mobs spawn naturally'),
  doDaylightCycle: bool(true, 'Daylight cycle', 'The time of day advances'),
  doWeatherCycle: bool(true, 'Weather cycle', 'The weather changes'),
  randomTickSpeed: int(3, 0, 4096, 'Random tick speed', 'Random ticks per chunk section per tick (plants, leaves)'),
  naturalRegeneration: bool(true, 'Natural regeneration', 'Health comes back when you are well fed'),
  fallDamage: bool(true, 'Fall damage', 'Falling hurts'),
  fireDamage: bool(true, 'Fire damage', 'Fire and lava hurt'),
  drowningDamage: bool(true, 'Drowning damage', 'Running out of air hurts'),
  mobGriefing: bool(true, 'Mob griefing', 'Creepers destroy blocks'),
  showDeathMessages: bool(true, 'Show death messages', 'Tell the chat how a player died'),
  playersSleepingPercentage: int(100, 0, 100, 'Sleeping percentage', 'Share of players that must sleep to skip the night'),
} as const;

export type RuleName = keyof typeof RULE_DEFS;
export type RuleValue = boolean | number;
export type RuleValues = { [K in RuleName]: typeof RULE_DEFS[K]['default'] };

export const RULE_NAMES = Object.keys(RULE_DEFS) as RuleName[];

export function isRuleName(s: string): s is RuleName {
  return Object.hasOwn(RULE_DEFS, s);
}

/** Case-insensitive rule lookup ("keepinventory" finds keepInventory). */
export function findRule(s: string): RuleName | null {
  const k = s.toLowerCase();
  return RULE_NAMES.find((n) => n.toLowerCase() === k) ?? null;
}

/** Parses a value for a rule; null when it does not fit (wrong type, out of range). */
export function parseRuleValue(name: RuleName, raw: string | number | boolean): RuleValue | null {
  const def: RuleDef<boolean | number> = RULE_DEFS[name];
  if (def.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    return s === 'true' ? true : s === 'false' ? false : null;
  }
  const s = String(raw).trim();
  if (!/^-?\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= (def.min ?? -Infinity) && n <= (def.max ?? Infinity) ? n : null;
}

/** Minimal read access for code that only needs to look at the rules (the damage pipeline). */
export interface RuleReader {
  get<K extends RuleName>(name: K): RuleValues[K];
}

export class GameRules implements RuleReader {
  private readonly values: Record<string, RuleValue> = {};

  constructor() {
    this.reset();
  }

  reset(): void {
    for (const n of RULE_NAMES) this.values[n] = RULE_DEFS[n].default;
  }

  get<K extends RuleName>(name: K): RuleValues[K] {
    return this.values[name] as RuleValues[K];
  }

  /** Sets a rule; false when the value does not fit the rule. */
  set(name: RuleName, value: string | number | boolean): boolean {
    const v = parseRuleValue(name, value);
    if (v === null) return false;
    this.values[name] = v;
    return true;
  }

  /** Only the rules that differ from their default; undefined when there are none. */
  serialize(): Record<string, RuleValue> | undefined {
    const out: Record<string, RuleValue> = {};
    for (const n of RULE_NAMES) if (this.values[n] !== RULE_DEFS[n].default) out[n] = this.values[n];
    return Object.keys(out).length ? out : undefined;
  }

  /** Loads saved rules; unknown names and bad values are ignored (a damaged file never breaks the world). */
  load(data: unknown): void {
    this.reset();
    if (!data || typeof data !== 'object') return;
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (isRuleName(k) && (typeof v === 'boolean' || typeof v === 'number')) this.set(k, v);
    }
  }
}

/** `/gamerule` usage line. */
export const GAMERULE_USAGE = `Usage: /gamerule <${RULE_NAMES.join('|')}> [value]`;

/** Runs `/gamerule <name> [value]` against a rule set. Returns the chat reply and whether anything changed. */
export function runGameRuleCommand(rules: GameRules, args: string[]): { reply: string; changed: boolean } {
  if (args.length === 0) return { reply: GAMERULE_USAGE, changed: false };
  const name = findRule(args[0]);
  if (!name) return { reply: `Unknown game rule "${args[0].slice(0, 24)}". ${GAMERULE_USAGE}`, changed: false };
  if (args.length === 1) return { reply: `${name} is ${rules.get(name)}`, changed: false };
  if (!rules.set(name, args[1])) {
    const def: RuleDef<boolean | number> = RULE_DEFS[name];
    const need = def.kind === 'boolean' ? 'true or false' : `a whole number from ${def.min} to ${def.max}`;
    return { reply: `${name} needs ${need}`, changed: false };
  }
  return { reply: `Game rule ${name} is now ${rules.get(name)}`, changed: true };
}
