import * as THREE from 'three';
import type { EntityManager } from '../entities/EntityManager';
import type { PlayerInventory } from '../items/Inventory';
import { blockDrop, breakSeconds, getItemDef, isBlockItem } from '../items/ItemRegistry';
import { type GameMode, hasSurvivalRules } from '../player/GameMode';
import { PHYSICS } from '../player/Physics';
import type { Player } from '../player/Player';
import type { PlayerStats } from '../player/PlayerStats';
import type { HandRenderer } from '../rendering/HandRenderer';
import type { Hotbar } from '../ui/Hotbar';
import { BLOCK, SHAPE, SHAPE_CROSS, SHAPE_LIQUID, SHAPE_MODEL, SHAPE_NONE, SOLID, getBlockDef } from '../world/BlockRegistry';
import { type RayHit, createRayHit, raycast } from '../world/Raycast';
import type { World } from '../world/World';
import type { AudioEngine } from './Audio';
import type { Input } from './Input';
import type { Renderer } from './Renderer';

const EAT_TIME = 1.6;

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

  constructor(private readonly d: InteractionDeps) {}

  reset(): void {
    this.breakProgress = 0;
    this.breakKey = -1;
    this.eatTime = 0;
    this.eating = false;
    this.d.renderer.highlight.hide();
    this.d.renderer.highlight.setProgress(0);
  }

  update(dt: number, active: boolean, input: Input, mode: GameMode): void {
    const { world, player, renderer, camera } = this.d;
    const highlight = renderer.highlight;
    const pos = camera.position;
    camera.getWorldDirection(this.dir);
    const hit = raycast((x, y, z) => world.getBlock(x, y, z), pos.x, pos.y, pos.z, this.dir.x, this.dir.y, this.dir.z, PHYSICS.REACH, this.ray);
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
      highlight.show(hit.x, hit.y, hit.z);
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
    if (canEat && input.rightDown) {
      if (held.id !== this.eatItem) {
        this.eatItem = held.id;
        this.eatTime = 0;
      }
      this.eatTime += dt;
      this.eating = true;
      if (Math.floor((this.eatTime - dt) / 0.2) !== Math.floor(this.eatTime / 0.2)) this.d.audio.playEat();
      if (this.eatTime >= EAT_TIME) {
        this.d.stats.eat(food.hunger, food.saturation);
        this.d.inventory.consumeSlot(this.d.hotbar.selected);
        this.d.audio.playBurp();
        this.eatTime = 0;
      }
    } else {
      this.eatTime = 0;
      this.eating = false;
      this.placeCooldown -= dt;
      if (hit.hit && !mobHit && (input.rightClicked || (input.rightDown && this.placeCooldown <= 0))) {
        this.placeCooldown = 0.22;
        this.place(mode);
      }
    }

    // ---- Pick block (creative) ----
    if (input.middleClicked && hit.hit && mode === 'creative' && getBlockDef(hit.id)?.inInventory) {
      const inv = this.d.inventory;
      let slot = -1;
      for (let i = 0; i < 9; i++) if (inv.get(i).id === hit.id) slot = i;
      if (slot >= 0) this.d.hotbar.select(slot);
      else this.d.hotbar.setSlot(this.d.hotbar.selected, hit.id);
    }
  }

  private attack(mob: import('../entities/Mob').Mob, mode: GameMode): void {
    const { player, hotbar, inventory, audio, hand, stats } = this.d;
    hand.swingHand();
    const tool = getItemDef(hotbar.selectedBlock)?.tool;
    const damage = tool ? tool.damage : 1;
    // Sprint hits knock back further, like Minecraft.
    if (mob.hurt(damage, player.x, player.z, player.sprinting ? 1.6 : 1)) {
      audio.playMob(mob.type.kind, 'hurt', 1);
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
    const seconds = survival ? breakSeconds(hit.id, held, player.onGround, player.headInWater) : 0;
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
      audio.play('hit', def.sound);
      renderer.particles.spawnFace(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, hit.id,
        world.getLight(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz), 2, world.tintAt(hit.x, hit.z, hit.id));
    }
    if (this.breakProgress < 1) return;

    const light = world.getLight(hit.x, hit.y + 1, hit.z);
    const above = world.getBlock(hit.x, hit.y + 1, hit.z);
    const broken = world.breakBlock(hit.x, hit.y, hit.z);
    if (broken) {
      renderer.particles.spawnBreak(hit.x, hit.y, hit.z, broken, light, world.tintAt(hit.x, hit.z, broken));
      audio.play('break', def.sound);
      if (survival) {
        const drop = blockDrop(broken, held);
        if (drop) entities.dropItem(drop, hit.x + 0.5, hit.y + 0.3, hit.z + 0.5);
        // A plant or torch on top breaks with its support and drops too.
        if (above !== world.getBlock(hit.x, hit.y + 1, hit.z)) {
          const top = blockDrop(above, 0);
          if (top) entities.dropItem(top, hit.x + 0.5, hit.y + 1.3, hit.z + 0.5);
        }
        stats.addExhaustion(0.005);
        if (getItemDef(held)?.tool) inventory.damageTool(hotbar.selected);
      }
    }
    this.breakProgress = 0;
    this.breakKey = -1;
    this.breakCooldown = survival ? 0.3 : 0.18;
  }

  private place(mode: GameMode): void {
    const { world, player, hotbar, inventory, audio, renderer, hand } = this.d;
    const hit = this.ray;
    const id = hotbar.selectedBlock;
    if (!id || !isBlockItem(id)) return;
    let x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    // Placing onto grass/flowers replaces them, like in Minecraft.
    if (SHAPE[hit.id] === SHAPE_CROSS) { x = hit.x; y = hit.y; z = hit.z; }
    const existing = world.getBlock(x, y, z);
    const replaceable = SHAPE[existing] === SHAPE_NONE || SHAPE[existing] === SHAPE_LIQUID || SHAPE[existing] === SHAPE_CROSS;
    if (!replaceable || existing === BLOCK.UNLOADED) return;
    if (SOLID[id] && player.intersectsBlock(x, y, z)) return;
    if (SOLID[id] && this.d.entities.mobs.some((m) => !m.dead && m.x + m.width / 2 > x && m.x - m.width / 2 < x + 1
      && m.y + m.height > y && m.y < y + 1 && m.z + m.width / 2 > z && m.z - m.width / 2 < z + 1)) return;
    // Plants and torches need a solid block underneath.
    if ((SHAPE[id] === SHAPE_CROSS || SHAPE[id] === SHAPE_MODEL) && !SOLID[world.getBlock(x, y - 1, z)]) return;
    if (!world.setBlock(x, y, z, id)) return;
    const def = getBlockDef(id)!;
    audio.play('place', def.sound);
    hand.swingHand();
    renderer.particles.spawnFace(x - hit.nx, y - hit.ny, z - hit.nz, hit.nx, hit.ny, hit.nz, id, world.getLight(x, y, z), 3, world.tintAt(x, z, id));
    if (hasSurvivalRules(mode)) inventory.consumeSlot(hotbar.selected);
    this.breakProgress = 0;
  }
}
