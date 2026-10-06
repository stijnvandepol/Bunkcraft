import { ITEM } from '../items/ItemRegistry';
import { BLOCK } from '../world/BlockRegistry';

export type AdvancementTab = 'story' | 'adventure';
export type AdvancementFrame = 'task' | 'goal' | 'challenge';

/** What awards an advancement. */
export type Trigger =
  | { type: 'enter' }
  | { type: 'item'; ids: number[] }
  | { type: 'kill_hostile' }
  | { type: 'arrow_hit' };

export interface AdvancementDef {
  id: string;
  tab: AdvancementTab;
  title: string;
  description: string;
  /** Parent id; null for a tab root. */
  parent: string | null;
  /** Item or block id shown as the icon. */
  icon: number;
  frame: AdvancementFrame;
  trigger: Trigger;
}

export const TAB_NAMES: Record<AdvancementTab, string> = { story: 'Minecraft', adventure: 'Adventure' };

/**
 * Titles and descriptions follow Minecraft Java 1.21. Only advancements the game can award
 * are listed (no bucket, bed, armor, enchanting, breeding or crossbow yet).
 */
export const ADVANCEMENTS: readonly AdvancementDef[] = [
  { id: 'story/root', tab: 'story', title: 'Minecraft', description: 'The heart and story of the game', parent: null,
    icon: BLOCK.CRAFTING_TABLE, frame: 'task', trigger: { type: 'enter' } },
  { id: 'story/mine_stone', tab: 'story', title: 'Stone Age', description: 'Mine stone with your new pickaxe', parent: 'story/root',
    icon: ITEM.WOODEN_PICKAXE, frame: 'task', trigger: { type: 'item', ids: [BLOCK.COBBLESTONE] } },
  { id: 'story/upgrade_tools', tab: 'story', title: 'Getting an Upgrade', description: 'Construct a better Pickaxe', parent: 'story/mine_stone',
    icon: ITEM.STONE_PICKAXE, frame: 'task', trigger: { type: 'item', ids: [ITEM.STONE_PICKAXE] } },
  { id: 'story/smelt_iron', tab: 'story', title: 'Acquire Hardware', description: 'Smelt an iron ingot', parent: 'story/upgrade_tools',
    icon: ITEM.IRON_INGOT, frame: 'task', trigger: { type: 'item', ids: [ITEM.IRON_INGOT] } },
  { id: 'story/iron_tools', tab: 'story', title: "Isn't It Iron Pick", description: 'Upgrade your Pickaxe', parent: 'story/smelt_iron',
    icon: ITEM.IRON_PICKAXE, frame: 'task', trigger: { type: 'item', ids: [ITEM.IRON_PICKAXE] } },
  { id: 'story/mine_diamond', tab: 'story', title: 'Diamonds!', description: 'Acquire diamonds', parent: 'story/iron_tools',
    icon: ITEM.DIAMOND, frame: 'task', trigger: { type: 'item', ids: [ITEM.DIAMOND] } },
  // Vanilla hangs this under "Hot Stuff" (lava bucket), which needs buckets; parented to smelt_iron instead.
  { id: 'story/form_obsidian', tab: 'story', title: 'Ice Bucket Challenge', description: 'Obtain a block of Obsidian', parent: 'story/smelt_iron',
    icon: BLOCK.OBSIDIAN, frame: 'task', trigger: { type: 'item', ids: [BLOCK.OBSIDIAN] } },

  // The vanilla root icon is a map, which does not exist yet.
  { id: 'adventure/root', tab: 'adventure', title: 'Adventure', description: 'Adventure, exploration, and combat', parent: null,
    icon: BLOCK.GRASS, frame: 'task', trigger: { type: 'enter' } },
  { id: 'adventure/kill_a_mob', tab: 'adventure', title: 'Monster Hunter', description: 'Kill any hostile monster', parent: 'adventure/root',
    icon: ITEM.IRON_SWORD, frame: 'task', trigger: { type: 'kill_hostile' } },
  { id: 'adventure/shoot_arrow', tab: 'adventure', title: 'Take Aim', description: 'Shoot something with an Arrow', parent: 'adventure/root',
    icon: ITEM.BOW, frame: 'task', trigger: { type: 'arrow_hit' } },
];

const BY_ID = new Map(ADVANCEMENTS.map((a) => [a.id, a]));

/**
 * Whether earning it pops a toast. Minecraft's tab roots ("Minecraft", "Adventure") have show_toast false, so
 * entering a world does not cover the corner with two toasts before anything happened.
 */
export function showsToast(def: AdvancementDef): boolean {
  return def.parent !== null;
}

export function getAdvancement(id: string): AdvancementDef | undefined {
  return BY_ID.get(id);
}

/** Saved form: advancement id → time earned (ms since epoch). */
export type AdvancementSave = Record<string, number>;

/**
 * Tracks which advancements a player earned. DOM-free: the game forwards events
 * (`onItemGained`, `onMobKilled`, ...) and listens to `onAward` for the toast.
 * Nothing is awarded while `enabled` is false (creative / spectator / multiplayer).
 */
export class AdvancementTracker {
  enabled = true;
  /** Called once per newly earned advancement (not when loading a save). */
  onAward: ((def: AdvancementDef) => void) | null = null;
  private readonly done = new Map<string, number>();

  has(id: string): boolean {
    return this.done.has(id);
  }

  /** A child is shown once its parent is earned (roots always). */
  isUnlocked(id: string): boolean {
    const p = BY_ID.get(id)?.parent;
    return !p || this.done.has(p);
  }

  /** Earned vs total, like the "5/20" in Minecraft's title. */
  progress(tab?: AdvancementTab): { done: number; total: number } {
    let done = 0, total = 0;
    for (const a of ADVANCEMENTS) {
      if (tab && a.tab !== tab) continue;
      total++;
      if (this.done.has(a.id)) done++;
    }
    return { done, total };
  }

  award(id: string, now = Date.now()): boolean {
    const def = BY_ID.get(id);
    if (!this.enabled || !def || this.done.has(id)) return false;
    this.done.set(id, now);
    this.onAward?.(def);
    return true;
  }

  private fire(match: (t: Trigger) => boolean): void {
    if (!this.enabled) return;
    for (const a of ADVANCEMENTS) if (!this.done.has(a.id) && match(a.trigger)) this.award(a.id);
  }

  onEnterWorld(): void {
    this.fire((t) => t.type === 'enter');
  }

  /** Item or block id entered the inventory (pickup, crafting, smelting). */
  onItemGained(id: number): void {
    this.fire((t) => t.type === 'item' && t.ids.includes(id));
  }

  /** The player killed a mob. */
  onMobKilled(hostile: boolean): void {
    if (hostile) this.fire((t) => t.type === 'kill_hostile');
  }

  /** The player's arrow hit a mob. */
  onArrowHitMob(): void {
    this.fire((t) => t.type === 'arrow_hit');
  }

  serialize(): AdvancementSave {
    return Object.fromEntries(this.done);
  }

  /** Replaces the state from a save; unknown ids are dropped, no toasts. */
  load(save: AdvancementSave | undefined): void {
    this.done.clear();
    if (!save) return;
    for (const [id, t] of Object.entries(save)) if (BY_ID.has(id) && typeof t === 'number') this.done.set(id, t);
  }
}
