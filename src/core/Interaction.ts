import * as THREE from 'three';
import type { EntityManager } from '../entities/EntityManager';
import type { PlayerInventory } from '../items/Inventory';
import { ITEM, blockDrop, breakSeconds, getItemDef, isBlockItem, itemBlock, itemFromState, itemId, itemMeta, miningWear } from '../items/ItemRegistry';
import { toolUse } from '../items/ToolUse';
import { facingFromYaw } from '../world/BlockStates';
import { type GameMode, hasSurvivalRules } from '../player/GameMode';
import { blockReach } from '../player/Physics';
import type { Player } from '../player/Player';
import type { PlayerStats } from '../player/PlayerStats';
import type { HandRenderer } from '../rendering/HandRenderer';
import type { Hotbar } from '../ui/Hotbar';
import { BLOCK, BOX_KIND, PARTIAL, SHAPE, SHAPE_BOX, SHAPE_CROSS, SHAPE_DOOR, SHAPE_MODEL, SOLID, getBlockDef, stateSound } from '../world/BlockRegistry';
import { collisionBoxes } from '../world/BlockShapes';
import { BOX_BED, BOX_CARPET, BOX_GATE, BOX_TRAPDOOR } from '../world/BoxShapes';
import { isLiquid } from '../world/Liquids';
import { resolveBucketTarget, resolvePlacement } from '../world/Placement';
import { type RayHit, createRayHit, raycast } from '../world/Raycast';
import type { World } from '../world/World';
import type { AudioEngine } from './Audio';
import type { Input } from './Input';
import { KB } from './Keybinds';
import type { Renderer } from './Renderer';

const EAT_TIME = 1.6;

/** Blocks a right click does something to (instead of placing against them). */
function isUsable(id: number): boolean {
  if (SHAPE[id] === SHAPE_DOOR || id === BLOCK.CHEST) return true;
  const kind = SHAPE[id] === SHAPE_BOX ? BOX_KIND[id] : 0;
  return kind === BOX_TRAPDOOR || kind === BOX_GATE || kind === BOX_BED;
}

export interface InteractionDeps {
  world: World;
  player: Player;
  stats: PlayerStats;
  inventory: PlayerInventory;
  hotbar: Hotbar;
  entities: EntityManager;
  renderer: Renderer;
  hand: HandRenderer;
  audio: AudioEngine;
  camera: THREE.PerspectiveCamera;
  /** Multiplayer: asks the server to hit one of its mobs. */
  attackRemote(mobId: number): void;
  /** Lights the TNT block at a position; false when not allowed. */
  igniteTnt(x: number, y: number, z: number): boolean;
  /** Fires an arrow from the eye along the view direction (power 0..1). */
  shootArrow(power: number, pickup: boolean): void;
  /** Whether chests may be placed (singleplayer only: the server does not store containers). */
  chestsAllowed?(): boolean;
  /** Opens the chest at a position (its container screen). */
  openChest?(x: number, y: number, z: number): void;
  /** Right click on a bed: sets the spawn point and sleeps through the night. */
  useBed?(x: number, y: number, z: number): void;
}

/**
 * Player ↔ world interaction under the game-mode rules: breaking (instant in creative,
 * timed with tools and drops in survival), placing (consumes items in survival),
 * melee attacks on mobs, eating and pick block.
 */
export class Interaction {
  readonly ray: RayHit = createRayHit();
  private readonly dir = new THREE.Vector3();
  private breakProgress = 0;
  private breakKey = -1;
  private breakCooldown = 0;
  private hitSoundTimer = 0;
  private swingTimer = 0;
  private placeCooldown = 0;
  private eatTime = 0;
  private eatItem = 0;
  /** True while the eat animation is playing (hand renderer). */
  eating = false;
  /** Seconds the bow has been drawn (0 = not drawing). */
  private bowDraw = 0;
  /** Bow draw 0..1 for the FOV zoom. */
  bowPull = 0;
  /**
   * Arcade game types: the world is fixed and nothing is mined, built or hit by hand. Nothing here
   * may touch blocks or mobs while this is set, whatever the caller does.
   */
  arcade = false;

  constructor(private readonly d: InteractionDeps) {}

  private readonly getBlock = (x: number, y: number, z: number): number => this.d.world.getBlock(x, y, z);
  private readonly getMeta = (x: number, y: number, z: number): number => this.d.world.getMeta(x, y, z);
  private readonly shapeBoxes = new Float64Array(64);
  private readonly liquidRay: RayHit = createRayHit();
  /** Block reach of the current game mode. */
  private reach = 4.5;

  reset(): void {
    this.breakProgress = 0;
    this.breakKey = -1;
    this.eatTime = 0;
    this.eating = false;
    this.bowDraw = 0;
    this.bowPull = 0;
    this.d.renderer.highlight.hide();
    this.d.renderer.highlight.setProgress(0);
  }

  update(dt: number, active: boolean, input: Input, mode: GameMode): void {
    if (this.arcade) {
      this.reset();
      return;
    }
    const { player, renderer, camera } = this.d;
    const highlight = renderer.highlight;
    const pos = camera.position;
    camera.getWorldDirection(this.dir);
    this.reach = blockReach(!hasSurvivalRules(mode));
    const hit = raycast(this.getBlock, pos.x, pos.y, pos.z, this.dir.x, this.dir.y, this.dir.z, this.reach, this.ray, this.getMeta);
    const mobHit = active && mode !== 'spectator'
      ? this.d.entities.raycastMob(pos.x, pos.y, pos.z, this.dir.x, this.dir.y, this.dir.z, Math.min(3, hit.hit ? hit.distance + 0.01 : 3))
      : null;

    if (!active || mode === 'spectator' || player.noclip) {
      this.reset();
      return;
    }

    // ---- Attack a mob (click) ----
    if (mobHit) {
      highlight.hide();
      this.breakProgress = 0;
      if (input.leftClicked) this.attack(mobHit.mob, mode);
    } else if (hit.hit) {
      this.showHit(hit);
      this.updateBreaking(dt, input, mode, hit);
    } else {
      highlight.hide();
      this.breakProgress = 0;
      if (input.leftClicked) this.d.hand.swingHand();
    }
    highlight.setProgress(this.breakProgress);

    // ---- Use: eat or place (right mouse) ----
    const held = this.d.hotbar.selectedStack;
    const food = getItemDef(held.id)?.food;
    const canEat = food && hasSurvivalRules(mode) && this.d.stats.hunger < 20;
    if (held.id === ITEM.BOW) {
      this.eatTime = 0;
      this.eating = false;
      this.updateBow(dt, input, mode);
    } else if (canEat && input.rightDown) {
      this.bowDraw = this.bowPull = 0;
      if (held.id !== this.eatItem) {
        this.eatItem = held.id;
        this.eatTime = 0;
      }
      this.eatTime += dt;
      this.eating = true;
      if (Math.floor((this.eatTime - dt) / 0.2) !== Math.floor(this.eatTime / 0.2)) this.d.audio.playEat();
      if (this.eatTime >= EAT_TIME) {
        this.d.stats.eat(food.hunger, food.saturation);
        if (food.poison) this.d.stats.poison = Math.max(this.d.stats.poison, food.poison);
        this.d.inventory.consumeSlot(this.d.hotbar.selected);
        if (food.returns) this.d.inventory.add({ id: itemId(food.returns), count: 1 });
        this.d.audio.playBurp();
        this.eatTime = 0;
      }
    } else if (held.id === ITEM.BUCKET || held.id === ITEM.WATER_BUCKET || held.id === ITEM.LAVA_BUCKET) {
      this.eatTime = 0;
      this.eating = false;
      this.bowDraw = this.bowPull = 0;
      if (input.rightClicked) this.useBucket(held.id, hit, mode);
    } else {
      this.eatTime = 0;
      this.eating = false;
      this.bowDraw = this.bowPull = 0;
      this.placeCooldown -= dt;
      if (hit.hit && !mobHit && isUsable(hit.id) && input.rightClicked
        && !(input.actionDown(KB.SNEAK) && isBlockItem(held.id))) {
        // Use a door, trapdoor, gate, chest or bed (sneaking with a block in hand places against it instead).
        this.useBlock(hit);
      } else if (hit.hit && !mobHit && (input.rightClicked || (input.rightDown && this.placeCooldown <= 0))) {
        this.placeCooldown = 0.22;
        this.place(mode);
      }
    }

    // ---- Pick block (creative) ----
    if (input.middleClicked && hit.hit && mode === 'creative' && getBlockDef(hit.id)?.inInventory) {
      const inv = this.d.inventory;
      const item = itemFromState(hit.id, this.getMeta(hit.x, hit.y, hit.z));
      let slot = -1;
      for (let i = 0; i < 9; i++) if (inv.get(i).id === item) slot = i;
      if (slot >= 0) this.d.hotbar.select(slot);
      else this.d.hotbar.setSlot(this.d.hotbar.selected, item);
    }
  }

  /**
   * Buckets (Minecraft 1.21): an empty one scoops up the liquid source it points at, a full one pours a source into the
   * block in front of the clicked face (replacing plants and flowing liquid). A bucket is never poured into a solid block.
   */
  private useBucket(id: number, hit: RayHit, mode: GameMode): void {
    const { world, hotbar, inventory, audio, hand, camera, entities, player } = this.d;
    const slot = hotbar.selected;
    if (id === ITEM.BUCKET) {
      const p = camera.position;
      const lh = raycast(this.getBlock, p.x, p.y, p.z, this.dir.x, this.dir.y, this.dir.z, this.reach, this.liquidRay, this.getMeta, true);
      // A solid block in the way (hit earlier than the liquid) means the liquid is out of sight.
      if (!lh.hit || !isLiquid(lh.id) || world.getMeta(lh.x, lh.y, lh.z) !== 0) return;
      if (hit.hit && hit.distance < lh.distance) return;
      const filled = lh.id === BLOCK.LAVA ? ITEM.LAVA_BUCKET : ITEM.WATER_BUCKET;
      if (!world.setBlock(lh.x, lh.y, lh.z, BLOCK.AIR)) return;
      audio.playBucket(lh.id === BLOCK.LAVA);
      hand.swingHand();
      const stack = inventory.get(slot);
      if (stack.count <= 1) inventory.set(slot, { id: filled, count: 1 });
      else {
        inventory.consumeSlot(slot);
        if (inventory.add({ id: filled, count: 1 }) > 0) entities.dropItem({ id: filled, count: 1 }, player.x, player.y + 1, player.z, 40);
      }
      hotbar.refresh();
      return;
    }
    if (!hit.hit) return;
    const kind = id === ITEM.LAVA_BUCKET ? BLOCK.LAVA : BLOCK.WATER;
    const target = resolveBucketTarget({
      hitX: hit.x, hitY: hit.y, hitZ: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, getBlock: this.getBlock, getMeta: this.getMeta,
    }, kind);
    if (!target || !world.setBlock(target.x, target.y, target.z, kind, 0)) return;
    audio.playBucket(kind === BLOCK.LAVA);
    hand.swingHand();
    // Creative keeps the full bucket; survival gets the empty one back.
    if (hasSurvivalRules(mode)) { inventory.set(slot, { id: ITEM.BUCKET, count: 1 }); hotbar.refresh(); }
  }

  private useBlock(hit: RayHit): void {
    const kind = SHAPE[hit.id] === SHAPE_BOX ? BOX_KIND[hit.id] : 0;
    if (SHAPE[hit.id] === SHAPE_DOOR) this.useDoor(hit);
    else if (kind === BOX_TRAPDOOR || kind === BOX_GATE) {
      const open = this.d.world.toggleBox(hit.x, hit.y, hit.z);
      if (open === null) return;
      this.d.audio.playDoor(open);
      this.d.hand.swingHand();
    } else if (kind === BOX_BED) this.d.useBed?.(hit.x, hit.y, hit.z);
    else if (hit.id === BLOCK.CHEST) this.d.openChest?.(hit.x, hit.y, hit.z);
  }

  private useDoor(hit: RayHit): void {
    const open = this.d.world.toggleDoor(hit.x, hit.y, hit.z);
    if (open === null) return;
    this.d.audio.playDoor(open);
    this.d.hand.swingHand();
  }

  /** Outline the block, or the box around a slab, stair or door where it really is. */
  private showHit(hit: RayHit): void {
    const highlight = this.d.renderer.highlight;
    if (!PARTIAL[hit.id]) {
      highlight.show(hit.x, hit.y, hit.z);
      return;
    }
    const b = this.shapeBoxes;
    const n = collisionBoxes(hit.id, this.getMeta(hit.x, hit.y, hit.z), this.getBlock, this.getMeta, hit.x, hit.y, hit.z, b);
    let x0 = 1, y0 = 1, z0 = 1, x1 = 0, y1 = 0, z1 = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      x0 = Math.min(x0, b[o]); y0 = Math.min(y0, b[o + 1]); z0 = Math.min(z0, b[o + 2]);
      x1 = Math.max(x1, b[o + 3]); y1 = Math.max(y1, b[o + 4]); z1 = Math.max(z1, b[o + 5]);
    }
    highlight.show(hit.x, hit.y, hit.z, x0, y0, z0, x1, y1, z1);
  }

  private attack(mob: import('../entities/Mob').Mob, mode: GameMode): void {
    const { player, hotbar, inventory, audio, hand, stats } = this.d;
    hand.swingHand();
    const tool = getItemDef(hotbar.selectedBlock)?.tool;
    const damage = tool ? tool.damage : 1;
    // A server mob is hit by the server (damage from the held item, sound comes back with it).
    let hit = false;
    if (mob.remote) {
      if (mob.hurtTime === 0 && !mob.dead) {
        this.d.attackRemote(mob.netId);
        mob.hurtTime = 10; // no second request during its invulnerability frames
        hit = true;
      }
    } else if (mob.hurt(damage, player.x, player.z, player.sprinting ? 1.6 : 1, true)) {
      // Sprint hits knock back further, like Minecraft.
      audio.playMob(mob.type.kind, 'hurt', 1);
      hit = true;
    }
    if (hit) {
      if (hasSurvivalRules(mode)) {
        stats.addExhaustion(0.1);
        if (tool) {
          inventory.damageTool(hotbar.selected);
          if (tool.kind !== 'sword') inventory.damageTool(hotbar.selected);
        }
      }
    }
  }

  private updateBreaking(dt: number, input: Input, mode: GameMode, hit: RayHit): void {
    const { world, player, renderer, audio, hand, hotbar, inventory, entities, stats } = this.d;
    const def = getBlockDef(hit.id)!;
    this.breakCooldown -= dt;
    const key = hit.x * 73856093 ^ hit.y * 19349663 ^ hit.z * 83492791;
    if (!input.leftDown || def.hardness < 0 || this.breakCooldown > 0) {
      if (!input.leftDown) {
        this.breakProgress = 0;
        this.hitSoundTimer = 0;
      }
      return;
    }
    if (key !== this.breakKey) {
      this.breakKey = key;
      this.breakProgress = 0;
    }
    const survival = hasSurvivalRules(mode);
    const held = hotbar.selectedBlock;
    const hitMeta = this.getMeta(hit.x, hit.y, hit.z);
    const seconds = survival ? breakSeconds(hit.id, held, player.onGround, player.headInWater, hitMeta) : 0;
    this.breakProgress = seconds <= 0 ? 1 : this.breakProgress + dt / seconds;

    // Arm swings continuously while mining.
    this.swingTimer -= dt;
    if (this.swingTimer <= 0) {
      this.swingTimer = 0.25;
      hand.swingHand();
    }
    this.hitSoundTimer -= dt;
    if (this.hitSoundTimer <= 0 && this.breakProgress < 1) {
      this.hitSoundTimer = 0.22;
      audio.play('hit', stateSound(def, hitMeta));
      renderer.particles.spawnFace(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, hit.id,
        world.getLight(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz), 2, world.tintAt(hit.x, hit.z, hit.id, hitMeta));
    }
    if (this.breakProgress < 1) return;

    const light = world.getLight(hit.x, hit.y + 1, hit.z);
    const above = world.getBlock(hit.x, hit.y + 1, hit.z);
    const brokenMeta = world.getMeta(hit.x, hit.y, hit.z);
    const broken = world.breakBlock(hit.x, hit.y, hit.z);
    if (broken) {
      renderer.particles.spawnBreak(hit.x, hit.y, hit.z, broken, light, world.tintAt(hit.x, hit.z, broken, brokenMeta));
      audio.play('break', stateSound(def, brokenMeta));
      if (survival) {
        const drop = blockDrop(broken, held, brokenMeta);
        if (drop) entities.dropItem(drop, hit.x + 0.5, hit.y + 0.3, hit.z + 0.5);
        if (broken === BLOCK.CHEST) for (const s of world.containers.take(hit.x, hit.y, hit.z)) entities.dropItem(s, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        // A plant or torch on top breaks with its support and drops too.
        // (the upper half of a door that went with the lower one is no extra drop)
        if (above !== world.getBlock(hit.x, hit.y + 1, hit.z) && !(SHAPE[broken] === SHAPE_DOOR && above === broken)) {
          const top = blockDrop(above, 0);
          if (top) entities.dropItem(top, hit.x + 0.5, hit.y + 1.3, hit.z + 0.5);
        }
        stats.addExhaustion(0.005);
        for (let w = miningWear(held, broken, brokenMeta); w > 0; w--) inventory.damageTool(hotbar.selected);
      }
    }
    this.breakProgress = 0;
    this.breakKey = -1;
    this.breakCooldown = survival ? 0.3 : 0.18;
  }

  private place(mode: GameMode): void {
    const { world, player, hotbar, inventory, audio, renderer, hand } = this.d;
    const hit = this.ray;
    const item = hotbar.selectedBlock;
    if (item === ITEM.FLINT_AND_STEEL) {
      this.useFlintAndSteel(mode);
      return;
    }
    if (getItemDef(item)?.armor) {
      // Right click with armor wears it (swapping what was worn).
      if (this.d.inventory.equipFromSlot(hotbar.selected)) hand.swingHand();
      return;
    }
    const toolKind = getItemDef(item)?.tool?.kind;
    if (toolKind && this.useToolOnBlock(toolKind, mode)) return;
    if (!item || !isBlockItem(item)) return;
    if (itemBlock(item) === BLOCK.CHEST && this.d.chestsAllowed && !this.d.chestsAllowed()) return;
    // A block item is a block id plus the variant bits of its state (colour, wood, material).
    const id = itemBlock(item), baseMeta = itemMeta(item);
    // Where the click landed inside the block decides the half of a slab or stair.
    const cam = this.d.camera.position;
    const hx = cam.x + this.dir.x * hit.distance, hz = cam.z + this.dir.z * hit.distance;
    const fracY = Math.min(1, Math.max(0, cam.y + this.dir.y * hit.distance - hit.y));
    const placed = resolvePlacement({
      id, variant: baseMeta, hitX: hit.x, hitY: hit.y, hitZ: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, fracY, yaw: player.yaw,
      fracX: hx - Math.floor(hx), fracZ: hz - Math.floor(hz),
      getBlock: this.getBlock, getMeta: this.getMeta,
    });
    if (!placed) return;
    const { x, y, z } = placed;
    const blocking = SOLID[id] && BOX_KIND[id] !== BOX_CARPET;
    if (blocking && player.intersectsBlock(x, y, z)) return;
    if (blocking && this.d.entities.mobs.some((m) => !m.dead && m.x + m.width / 2 > x && m.x - m.width / 2 < x + 1
      && m.y + m.height > y && m.y < y + 1 && m.z + m.width / 2 > z && m.z - m.width / 2 < z + 1)) return;
    // Plants and torches need a solid block underneath.
    if ((SHAPE[id] === SHAPE_CROSS || SHAPE[id] === SHAPE_MODEL) && !SOLID[world.getBlock(x, y - 1, z)]) return;
    if (placed.upper && SHAPE[id] === SHAPE_DOOR && player.intersectsBlock(x, y + 1, z)) return;
    if (placed.upper && BOX_KIND[id] === BOX_BED && player.intersectsBlock(placed.upper.x, placed.upper.y, placed.upper.z)) return;
    if (!world.setBlock(x, y, z, id, placed.meta | baseMeta)) return;
    if (id === BLOCK.CHEST) world.containers.clear(x, y, z);
    if (placed.upper) world.setBlock(placed.upper.x, placed.upper.y, placed.upper.z, id, placed.upper.meta | baseMeta);
    const def = getBlockDef(id)!;
    audio.play('place', stateSound(def, baseMeta));
    hand.swingHand();
    renderer.particles.spawnFace(x - hit.nx, y - hit.ny, z - hit.nz, hit.nx, hit.ny, hit.nz, id, world.getLight(x, y, z), 3, world.tintAt(x, z, id, baseMeta));
    if (hasSurvivalRules(mode)) inventory.consumeSlot(hotbar.selected);
    this.breakProgress = 0;
  }

  /** Hoe, shovel and axe change the block they are used on (see items/ToolUse). */
  private useToolOnBlock(kind: import('../items/ItemRegistry').ToolKind, mode: GameMode): boolean {
    const { world, hotbar, inventory, audio, hand } = this.d;
    const hit = this.ray;
    const use = toolUse(kind, hit.id, world.getBlock(hit.x, hit.y + 1, hit.z));
    if (!use || !world.setBlock(hit.x, hit.y, hit.z, use.to, use.facesPlayer ? facingFromYaw(this.d.player.yaw) : 0)) return false;
    if (use.drops && hasSurvivalRules(mode)) this.d.entities.dropItem({ id: itemId(use.drops.name), count: use.drops.count }, hit.x + 0.5, hit.y + 1.1, hit.z + 0.5);
    audio.play('place', use.sound);
    hand.swingHand();
    if (hasSurvivalRules(mode)) inventory.damageTool(hotbar.selected);
    return true;
  }

  /**
   * Bow: hold Use to draw, release to shoot. Minecraft's power curve: f = t/20 s-ticks,
   * power = (f² + 2f) / 3 capped at 1; full draw is a critical shot. Needs an arrow
   * (consumed in survival; creative shoots without).
   */
  private updateBow(dt: number, input: Input, mode: GameMode): void {
    const { inventory, hotbar, audio, hand } = this.d;
    const survival = hasSurvivalRules(mode);
    const hasArrow = !survival || inventory.count(ITEM.ARROW) > 0;
    if (input.rightDown && hasArrow) {
      this.bowDraw += dt;
      this.bowPull = Math.min(1, this.bowDraw);
      return;
    }
    if (this.bowDraw <= 0) return;
    const f = this.bowDraw;
    this.bowDraw = this.bowPull = 0;
    const power = Math.min(1, (f * f + f * 2) / 3);
    if (power < 0.1 || !hasArrow) return;
    this.d.shootArrow(power, survival);
    audio.playBow(power);
    hand.swingHand();
    if (survival) {
      inventory.remove(ITEM.ARROW, 1);
      inventory.damageTool(hotbar.selected);
    }
  }

  /** Flint and steel lights TNT (fire blocks don't exist yet, so other blocks are unaffected). */
  private useFlintAndSteel(mode: GameMode): void {
    const { hotbar, inventory, audio, hand } = this.d;
    const hit = this.ray;
    hand.swingHand();
    if (hit.id !== BLOCK.TNT || !this.d.igniteTnt(hit.x, hit.y, hit.z)) return;
    audio.playIgnite(1);
    if (hasSurvivalRules(mode)) inventory.damageTool(hotbar.selected);
  }
}
