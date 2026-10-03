import type { EntityManager } from '../entities/EntityManager';
import type { Mob } from '../entities/Mob';
import type { XpOrb } from '../entities/XpOrb';
import { XpOrbRenderer } from '../entities/XpOrbRenderer';
import { ENCHANTS, ENCHANT_BY_KEY, conflicts, depthStriderFactor, enchantLabel, enchantsOf, levelOf, reduceByEpf, thornsReflect, totalEpf } from '../items/EnchantRules';
import { applyMending, canCarry, countBookshelves, enchanted, nextEnchantSeed } from '../items/Enchanting';
import type { PlayerInventory } from '../items/Inventory';
import { type ItemStack, cloneStack, maxDurability } from '../items/ItemRegistry';
import { deathXp, totalXpForLevel } from '../player/Experience';
import { type GameMode, hasSurvivalRules } from '../player/GameMode';
import type { Player } from '../player/Player';
import type { DamageCause, PlayerStats } from '../player/PlayerStats';
import { registerDamageModifier } from '../player/Damage';
import type { WorldUniforms } from '../rendering/Materials';
import type { Hotbar } from '../ui/Hotbar';
import { type StationContext, anvilView, enchantingView, grindstoneView } from '../ui/StationScreens';
import type { ContainerView } from '../ui/SurvivalInventory';
import { XpBar } from '../ui/XpBar';
import { BLOCK, OPAQUE, SOLID } from '../world/BlockRegistry';
import type { World } from '../world/World';
import type { AudioEngine } from './Audio';
import type { StationKind } from './Interaction';

export interface ProgressionDeps {
  stats: PlayerStats;
  inventory: PlayerInventory;
  hotbar: Hotbar;
  player: Player;
  audio: AudioEngine;
  uniforms: WorldUniforms;
  world(): World | null;
  entities(): EntityManager | null;
  mode(): GameMode;
  /** Shows a station screen above the inventory (like a chest). */
  openView(view: ContainerView): void;
  /** Multiplayer: whether the game is connected to a server. */
  multiplayer(): boolean;
  /** Game rules of the world (another module owns them); `keepInventory` keeps the experience on death. */
  rules?(): { keepInventory?: boolean } | undefined;
}

/**
 * Experience and enchanting in the running game: collects orbs (Mending first), draws the XP bar and the orbs, applies the
 * armor enchantments (Protection, Respiration, Depth Strider, Thorns), drops experience on death and opens the enchanting
 * table, anvil and grindstone. Game.ts calls in at a handful of places; the rules live in items/ and player/.
 */
export class Progression {
  readonly xpBar = new XpBar();
  readonly orbRenderer: XpOrbRenderer;
  private lastXpSound = 0;
  private soundClock = 0;

  constructor(private readonly d: ProgressionDeps) {
    this.orbRenderer = new XpOrbRenderer(d.uniforms);
    // The bar sits between the hearts and the hotbar.
    const wrap = d.hotbar.el;
    wrap.insertBefore(this.xpBar.el, wrap.lastElementChild);
    d.stats.xp.onLevelUp = (level) => {
      // Minecraft plays the level-up chime on every fifth level and a softer one otherwise.
      if (level % 5 === 0) d.audio.playUi('levelup');
      else this.playXp();
    };
    // Protection enchantments run in the shared damage pipeline (Damage.ts, stage 'post': after armor and Resistance).
    registerDamageModifier({
      id: 'enchant-protection',
      stage: 'post',
      apply: (amount, ctx) => (ctx.target === d.stats ? this.protection(amount, ctx.source.kind) : amount),
    });
    // The pipeline can ask for worn levels too ("protection" = all four pieces).
    d.stats.enchantLookup = (name) => d.inventory.armor.reduce((sum, s) => sum + levelOf(s.data, name), 0);
  }

  // ---------------------------------------------------------------- experience

  /** Local orb touched by the player: Mending repairs first, the rest fills the bar. */
  readonly pickupXp = (value: number): void => {
    const inv = this.d.inventory;
    const items: ItemStack[] = [this.d.hotbar.selectedStack, ...inv.armor];
    const before = items.map((s) => s.damage ?? 0);
    const rest = applyMending(items, value);
    if (items.some((s, i) => (s.damage ?? 0) !== before[i])) inv.onChange?.();
    this.d.stats.xp.add(rest);
    this.playXp();
  };

  private playXp(): void {
    // Many orbs at once: one pling per 50 ms is enough.
    if (this.soundClock - this.lastXpSound < 0.05) return;
    this.lastXpSound = this.soundClock;
    this.d.audio.playUi('xp');
  }

  /** Once per frame: orbs and the bar. */
  update(alpha: number, time: number, survivalHud: boolean): void {
    this.soundClock = time;
    const e = this.d.entities();
    this.orbRenderer.update(e ? e.orbs : NO_ORBS, alpha, time);
    this.xpBar.setVisible(survivalHud);
    const xp = this.d.stats.xp;
    this.xpBar.update(xp.level, xp.progress);
  }

  /** The player died: 7 points per level (at most 100) fall as orbs; the rest is gone. `keepInventory` keeps it all. */
  onDeath(): void {
    if (this.d.rules?.()?.keepInventory) return;
    const xp = this.d.stats.xp;
    const p = this.d.player;
    const drop = hasSurvivalRules(this.d.mode()) ? deathXp(xp.level) : 0;
    if (drop > 0) this.d.entities()?.spawnXp(p.x, p.y + 0.5, p.z, drop);
    xp.set(0);
  }

  // ---------------------------------------------------------------- armor enchantments

  /** Protection, Fire/Blast/Projectile Protection and Feather Falling of the worn armor (a damage modifier). */
  private readonly protection = (amount: number, cause: DamageCause): number => {
    const armor = this.d.inventory.armor;
    const epf = totalEpf([armor[0].data, armor[1].data, armor[2].data, armor[3].data], cause);
    return epf > 0 ? reduceByEpf(amount, epf) : amount;
  };

  /** The worn armor changed: Respiration and Depth Strider follow it. */
  onArmorChanged(): void {
    const armor = this.d.inventory.armor;
    this.d.stats.respiration = levelOf(armor[0].data, 'respiration');
    this.d.player.depthStrider = depthStriderFactor(levelOf(armor[3].data, 'depth_strider'));
  }

  /** A mob hit the player in melee: Thorns may hurt it back (and wears the armor that did it). */
  thorns(mob: Mob): void {
    const armor = this.d.inventory.armor;
    const r = thornsReflect(armor.map((s) => s.data));
    if (r.damage <= 0) return;
    if (!mob.remote) mob.hurt(r.damage, this.d.player.x, this.d.player.z, 0.5, true);
    r.wear.forEach((w, slot) => {
      const s = armor[slot];
      const max = s.id ? maxDurability(s.id) : 0;
      if (!w || !max) return;
      s.damage = (s.damage ?? 0) + w;
      if (s.damage >= max) this.d.inventory.setArmor(slot, { id: 0, count: 0 });
    });
    this.d.inventory.onChange?.();
  }

  // ---------------------------------------------------------------- stations

  open(kind: StationKind, x: number, y: number, z: number): void {
    const world = this.d.world();
    if (!world) return;
    const stats = this.d.stats;
    const creative = (): boolean => !hasSurvivalRules(this.d.mode());
    const ctx: StationContext = {
      level: () => stats.xp.level,
      creative,
      spendLevels: (n) => stats.xp.spendLevels(n, creative()),
      enchantSeed: () => stats.enchantSeed,
      nextSeed: () => { stats.enchantSeed = nextEnchantSeed(stats.enchantSeed); },
      bookshelves: kind === 'enchant' ? countBookshelves(
        (dx, dy, dz) => world.getBlock(x + dx, y + dy, z + dz) === BLOCK.BOOKSHELF,
        (dx, dy, dz) => { const b = world.getBlock(x + dx, y + dy, z + dz); return b !== BLOCK.UNLOADED && !SOLID[b] && !OPAQUE[b]; },
      ) : 0,
      giveXp: (n) => this.d.entities()?.spawnXp(x + 0.5, y + 1, z + 0.5, n),
      give: (s) => {
        const left = this.d.inventory.add(s);
        if (left > 0) this.d.entities()?.dropItem({ ...cloneStack(s), count: left }, this.d.player.x, this.d.player.y + 1, this.d.player.z, 20);
      },
      sound: (k) => this.d.audio.playUi(k),
      anvilUsed: () => this.damageAnvil(x, y, z),
    };
    const view = kind === 'enchant' ? enchantingView(ctx) : kind === 'anvil' ? anvilView(ctx) : grindstoneView(ctx);
    this.d.openView(view);
  }

  /** Every anvil use has a 12% chance to wear it: anvil -> chipped -> damaged -> gone (survival). */
  private damageAnvil(x: number, y: number, z: number): void {
    const world = this.d.world();
    if (!world || !hasSurvivalRules(this.d.mode()) || Math.random() >= 0.12) return;
    if (world.getBlock(x, y, z) !== BLOCK.ANVIL) return;
    const meta = world.getMeta(x, y, z);
    const stage = (meta >> 2) & 3;
    if (stage >= 2) {
      world.setBlock(x, y, z, BLOCK.AIR);
      this.d.audio.play('break', 'metal');
    } else world.setBlock(x, y, z, BLOCK.ANVIL, (meta & 3) | ((stage + 1) << 2));
  }

  // ---------------------------------------------------------------- commands

  /**
   * `/enchant <enchantment> [level]` on the held item and `/xp <amount>[L]` (levels with an L). Creative only (operators
   * use creative); returns the chat lines, or null when the text is not one of these commands.
   */
  command(text: string): string[] | null {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    if (cmd !== '/enchant' && cmd !== '/xp' && cmd !== '/experience') return null;
    if (hasSurvivalRules(this.d.mode())) return ['That command needs creative mode.'];
    if (cmd === '/enchant') {
      const key = (parts[1] ?? '').toLowerCase().replace(/^minecraft:/, '');
      const def = ENCHANT_BY_KEY.get(key);
      if (!def) return [`Usage: /enchant <name> [level]. Names: ${ENCHANTS.map((e) => e.key).join(', ')}`];
      const level = Math.max(1, Math.min(def.max, Number(parts[2] ?? 1) | 0 || 1));
      const slot = this.d.hotbar.selected;
      const held = this.d.inventory.get(slot);
      if (!held.id) return ['Hold the item to enchant.'];
      const target = held;
      if (!canCarry(target.id, key)) return [`${enchantLabel(key, level)} cannot be applied to this item.`];
      const current = enchantsOf(target.data);
      for (const other of Object.keys(current)) if (conflicts(key, other)) return [`${enchantLabel(key, level)} conflicts with ${enchantLabel(other, current[other])}.`];
      this.d.inventory.set(slot, enchanted(target, { ...current, [key]: level }));
      this.d.audio.playUi('enchant');
      return [`Applied ${enchantLabel(key, level)}.`];
    }
    const raw = parts[1] ?? '';
    const m = /^(-?\d+)(l?)$/i.exec(raw);
    if (!m) return ['Usage: /xp <amount> or /xp <levels>L'];
    const n = Number(m[1]);
    const xp = this.d.stats.xp;
    if (m[2]) xp.set(totalXpForLevel(Math.max(0, xp.level + n)));
    else if (n >= 0) xp.add(n);
    else xp.take(-n);
    return [`Experience: level ${xp.level} (${xp.total} points)`];
  }
}

const NO_ORBS: XpOrb[] = [];
