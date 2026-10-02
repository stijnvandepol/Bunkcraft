import * as THREE from 'three';
import { PHYSICS } from '../player/Physics';
import { type MoveInput, Player } from '../player/Player';
import { DayCycle } from '../rendering/DayCycle';
import {
  IMPORTED_PREFIX, MINECRAFT_LAYOUT, type PackImage, builtinResolver, findBuiltinPack, importMinecraftArchive, importedResolver, loadPack,
} from '../rendering/TexturePacks';
import { resourcePacksScreen } from '../ui/ResourcePacksMenu';
import { type WorldMeta, SaveSystem, newWorldId } from '../save/SaveSystem';
import { BlockIcons } from '../ui/BlockIcons';
import { DebugOverlay } from '../ui/DebugOverlay';
import { h } from '../ui/dom';
import { HUD } from '../ui/HUD';
import { Hotbar } from '../ui/Hotbar';
import { Inventory } from '../ui/Inventory';
import { MainMenu, VERSION, pauseScreen } from '../ui/MainMenu';
import { applyGuiScale } from '../ui/GuiScale';
import { createLogo } from '../ui/Logo';
import { ScreenStack } from '../ui/Screens';
import { optionsScreen } from '../ui/SettingsMenu';
import { WorkerPool } from '../workers/WorkerPool';
import { BLOCK, SHAPE, SHAPE_CROSS, SHAPE_LIQUID, SHAPE_NONE, SOLID, getBlockDef } from '../world/BlockRegistry';
import { CHUNK_VOLUME } from '../world/constants';
import { hashString } from '../world/Noise';
import { createRayHit, raycast } from '../world/Raycast';
import { BIOME_NAMES } from '../world/TerrainGenerator';
import { World } from '../world/World';
import { AudioEngine } from './Audio';
import { CameraController } from './Camera';
import { Input } from './Input';
import { Renderer } from './Renderer';
import { SettingsStore } from './Settings';

type GameState = 'menu' | 'loading' | 'playing' | 'paused' | 'inventory';

const DEFAULT_HOTBAR = [
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS,
  BLOCK.OAK_LOG, BLOCK.GLASS, BLOCK.BRICKS, BLOCK.GLOWSTONE,
];
const MENU_SEED = hashString('BunkCraft');
const AUTOSAVE_INTERVAL = 30;
const FACING = ['south (Towards positive Z)', 'west (Towards negative X)', 'north (Towards negative Z)', 'east (Towards positive X)'];

/**
 * Top-level game: state machine (menu → loading → playing ⇄ paused/inventory),
 * fixed-timestep simulation with interpolated rendering, and block interaction.
 */
export class Game {
  private readonly settings = new SettingsStore();
  private readonly renderer: Renderer;
  private readonly input: Input;
  private readonly cam = new CameraController();
  private readonly audio = new AudioEngine();
  private readonly save = new SaveSystem();
  private readonly pool: WorkerPool;
  private readonly cycle = new DayCycle();
  readonly player = new Player();
  private readonly icons: BlockIcons;
  private readonly hotbar: Hotbar;
  private readonly hud: HUD;
  private readonly inventory: Inventory;
  private readonly debug = new DebugOverlay();
  private readonly stack: ScreenStack;
  private readonly menu: MainMenu;

  private state: GameState = 'menu';
  private world: World | null = null;
  private meta: WorldMeta | null = null;
  private needsSurface = false;
  private loadingProgress: ((status: string, p: number) => void) | null = null;
  private suppressPause = false;
  private hudHidden = false;
  /** Capture a world icon from the next rendered frame (like Minecraft's world screenshot). */
  private wantThumbnail = false;
  private packCredit = 'Procedural textures';

  private last = 0;
  private time = 0;
  private accumulator = 0;
  private autosave = 0;
  private menuOrbit = new THREE.Vector3();

  private readonly ray = createRayHit();
  private readonly move: MoveInput = { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };
  /** Bound once: avoids allocating a closure per frame for physics and raycasts. */
  private readonly getBlock = (x: number, y: number, z: number): number => this.world ? this.world.getBlock(x, y, z) : BLOCK.UNLOADED;
  private readonly dir = new THREE.Vector3();
  private breakProgress = 0;
  private breakKey = -1;
  private breakCooldown = 0;
  private hitSoundTimer = 0;
  private placeCooldown = 0;
  private underwater = false;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private gpuName = '';

  constructor(root: HTMLElement) {
    const canvas = root.querySelector<HTMLCanvasElement>('#game')!;
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    // Leave cores for the main thread and the browser GPU process (smoother frame pacing).
    this.pool = new WorkerPool(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
    this.icons = new BlockIcons(this.renderer.textures);
    this.hotbar = new Hotbar(this.icons, DEFAULT_HOTBAR);
    this.hud = new HUD(this.hotbar);
    this.inventory = new Inventory(this.icons, this.hotbar);
    this.stack = new ScreenStack(root.querySelector<HTMLElement>('#screens')!);
    root.append(this.hud.el, this.debug.el, this.inventory.el);

    this.menu = new MainMenu(this.stack, {
      listWorlds: () => this.save.listWorlds(),
      playWorld: (m) => void this.enterWorld(m),
      createWorld: (name, seed) => void this.createWorld(name, seed),
      deleteWorld: (id) => this.save.deleteWorld(id),
      openOptions: () => this.openOptions(),
      logo: () => createLogo('BUNKCRAFT', this.renderer.textures.canvas('stone')),
      defaultWorldIcon: () => this.icons.get(BLOCK.GRASS),
    });

    this.inventory.onClose = () => void this.resumeGame();
    this.input.onKeyDown = (code) => this.onKey(code);
    this.input.onLockChange = (locked) => this.onLockChange(locked);
    this.settings.onChange((_, key) => this.applySettings(key));
    this.applySettings();
    window.addEventListener('resize', () => {
      this.renderer.resize();
      applyGuiScale(this.settings.values.guiScale);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.saveGame();
    });
    window.addEventListener('pagehide', () => void this.saveGame());
    // Audio needs a user gesture before it may start.
    window.addEventListener('pointerdown', () => this.audio.unlock());
    window.addEventListener('keydown', () => this.audio.unlock());

    const gl = this.renderer.three.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
  }

  async start(): Promise<void> {
    await this.save.open();
    await this.applyTexturePack();
    this.enterMenu();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- settings

  private openOptions(): void {
    this.stack.push(optionsScreen(this.settings, {
      push: (el) => this.stack.push(el),
      pop: () => this.stack.pop(),
      openResourcePacks: () => this.openResourcePacks(),
      credits: () => [
        VERSION,
        `Textures: ${this.packCredit}`,
        'Font: Minecraft-Font by Idrees Hassan — SIL Open Font License 1.1',
        'Rendering: three.js (MIT License)',
        'Terrain, sounds, music, sky and procedural textures: generated in code',
        'Not affiliated with Mojang or Microsoft',
      ],
    }));
  }

  private openResourcePacks(): void {
    const refresh = () => this.stack.replace(screen());
    const screen = () => resourcePacksScreen(this.settings, {
      listImported: () => this.save.listPacks(),
      icon: () => this.icons.get(BLOCK.BOOKSHELF),
      importFile: async (file) => {
        const pack = await importMinecraftArchive(file);
        await this.save.savePack(pack);
        this.settings.set('texturePack', IMPORTED_PREFIX + pack.id);
        refresh();
      },
      remove: async (id) => {
        await this.save.deletePack(id);
        if (this.settings.values.texturePack === IMPORTED_PREFIX + id) this.settings.set('texturePack', 'pixel-perfection');
        refresh();
      },
    }, () => this.stack.pop());
    this.stack.push(screen());
  }

  private async applyTexturePack(): Promise<void> {
    const id = this.settings.values.texturePack;
    let images: Map<string, PackImage> | null = null;
    let greyscale = false;
    let credit = 'Procedural textures';
    try {
      const builtin = findBuiltinPack(id);
      if (builtin) {
        images = await loadPack(builtin.layout, builtinResolver(builtin), 16);
        credit = builtin.credit;
      } else if (id.startsWith(IMPORTED_PREFIX)) {
        const pack = await this.save.getPack(id.slice(IMPORTED_PREFIX.length));
        if (pack) {
          const files = importedResolver(pack);
          try {
            images = await loadPack(MINECRAFT_LAYOUT, files.resolve, 16);
          } finally {
            files.dispose();
          }
          greyscale = true;
          credit = `Resource pack: ${pack.name} (local)`;
        }
      }
    } catch (e) {
      console.warn('Texture pack failed to load, using procedural textures', e);
    }
    this.packCredit = credit;
    this.renderer.textures.applyPack(images, greyscale);
    this.icons.clear();
    this.hotbar.refresh();
  }

  private applySettings(key?: string): void {
    if (key === 'texturePack') void this.applyTexturePack();
    const s = this.settings.values;
    this.renderer.applySettings(s);
    this.cam.baseFov = s.fov;
    this.cam.viewBobbing = s.viewBobbing;
    this.audio.setVolumes((s.soundVolume * s.masterVolume) / 100, (s.musicVolume * s.masterVolume) / 100);
    applyGuiScale(s.guiScale);
    if (this.world) {
      this.world.chunks.renderDistance = this.state === 'menu' ? Math.min(s.renderDistance, 6) : s.renderDistance;
      this.world.chunks.markDirty();
      const fancy = s.graphics === 'fancy';
      if (key === 'graphics' && this.world.chunks.fancyLeaves !== fancy) {
        this.world.chunks.fancyLeaves = fancy;
        this.world.chunks.remeshAll();
      }
    }
  }

  // ---------------------------------------------------------------- world lifecycle

  private createWorldInstance(seed: number, edits?: Map<number, Map<number, number>>): World {
    this.world?.dispose();
    const world = new World(seed, this.pool, { opaque: this.renderer.chunkMaterial, cutout: this.renderer.cutoutMaterial, water: this.renderer.waterMaterial }, edits);
    world.chunks.fancyLeaves = this.settings.values.graphics === 'fancy';
    world.chunks.renderDistance = this.settings.values.renderDistance;
    this.world = world;
    this.renderer.attachWorld(world);
    return world;
  }

  private enterMenu(): void {
    this.state = 'menu';
    this.meta = null;
    this.hud.setVisible(false);
    this.inventory.close();
    const world = this.createWorldInstance(MENU_SEED);
    world.chunks.renderDistance = Math.min(this.settings.values.renderDistance, 6);
    const spawn = world.findSpawn();
    this.menuOrbit.set(spawn.x, world.generator.heightAt(spawn.x, spawn.z) + 14, spawn.z);
    this.cycle.time = 0.09;
    this.menu.showTitle();
  }

  private async createWorld(name: string, seedText: string): Promise<void> {
    let seed: number;
    if (!seedText) seed = (Math.random() * 4294967296) >>> 0;
    else if (/^-?\d+$/.test(seedText)) seed = Number(BigInt.asUintN(32, BigInt(seedText)));
    else seed = hashString(seedText);
    const meta: WorldMeta = {
      id: newWorldId(), name, seed, seedText: seedText || String(seed),
      created: Date.now(), lastPlayed: Date.now(), player: null,
      hotbar: [...DEFAULT_HOTBAR], selectedSlot: 0, time: 0.08,
    };
    await this.save.saveWorld(meta);
    await this.enterWorld(meta);
  }

  private async enterWorld(meta: WorldMeta): Promise<void> {
    this.audio.unlock();
    this.loadingProgress = this.menu.showLoading('Loading world');
    this.loadingProgress('Reading save data...', 0);
    const edits = await this.save.loadEdits(meta.id);
    this.meta = meta;
    const world = this.createWorldInstance(meta.seed, edits);
    this.cycle.time = meta.time;
    this.hotbar.slots.splice(0, 9, ...meta.hotbar);
    this.hotbar.refresh();
    this.hotbar.select(meta.selectedSlot);
    const p = meta.player;
    if (p) {
      this.player.setPosition(p.x, p.y, p.z);
      this.player.yaw = p.yaw;
      this.player.pitch = p.pitch;
      this.player.flying = p.flying;
      this.needsSurface = false;
    } else {
      const spawn = world.findSpawn();
      this.player.setPosition(spawn.x, 100, spawn.z);
      this.player.yaw = 0;
      this.player.pitch = 0;
      this.player.flying = false;
      this.needsSurface = true;
    }
    this.state = 'loading';
  }

  private finishLoading(): void {
    const world = this.world!;
    if (this.needsSurface) {
      const x = Math.floor(this.player.x), z = Math.floor(this.player.z);
      this.player.setPosition(this.player.x, world.surfaceY(x, z) + 1, this.player.z);
    }
    this.player.unstick((x, y, z) => world.getBlock(x, y, z));
    this.loadingProgress = null;
    this.autosave = 0;
    void this.resumeGame();
  }

  private async saveGame(): Promise<void> {
    const world = this.world, meta = this.meta;
    if (!world || !meta || this.state === 'loading' || this.state === 'menu') return;
    const p = this.player;
    meta.player = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flying: p.flying };
    meta.hotbar = [...this.hotbar.slots];
    meta.selectedSlot = this.hotbar.selected;
    meta.time = this.cycle.time;
    meta.lastPlayed = Date.now();
    this.wantThumbnail = true;
    try {
      await this.save.saveWorld(meta);
      await this.save.saveEdits(meta.id, world.edits, world.dirtyEditChunks);
    } catch (e) {
      console.error('Saving failed', e);
    }
  }

  /** Square centre crop of the current frame, read right after rendering (same task). */
  private captureThumbnail(): void {
    this.wantThumbnail = false;
    const meta = this.meta;
    if (!meta || (this.state !== 'playing' && this.state !== 'paused')) return;
    const src = this.renderer.three.domElement;
    const side = Math.min(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    c.getContext('2d')!.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, 64, 64);
    meta.icon = c.toDataURL('image/png');
    void this.save.saveWorld(meta);
  }

  private async quitToTitle(): Promise<void> {
    await this.saveGame();
    this.input.exitLock();
    this.stack.clear();
    this.enterMenu();
  }

  // ---------------------------------------------------------------- input / states

  private async resumeGame(): Promise<void> {
    this.inventory.close();
    this.stack.clear();
    this.state = 'playing';
    this.hud.setVisible(!this.hudHidden);
    await this.input.requestLock();
    if (!this.input.locked && this.state === 'playing') this.showClickToPlay();
  }

  private showClickToPlay(): void {
    this.stack.clear();
    this.stack.push(h('div', { class: 'screen click-to-play', onclick: () => void this.resumeGame() },
      h('div', { class: 'click-hint', text: 'Click to play' })));
  }

  private onLockChange(locked: boolean): void {
    if (locked) {
      if (this.state === 'playing' || this.state === 'paused') {
        this.state = 'playing';
        this.stack.clear();
      }
      return;
    }
    if (this.suppressPause) {
      this.suppressPause = false;
      return;
    }
    if (this.state === 'playing') this.pause();
  }

  private pause(): void {
    this.state = 'paused';
    void this.saveGame();
    this.stack.clear();
    this.stack.push(pauseScreen({
      resume: () => void this.resumeGame(),
      options: () => this.openOptions(),
      quit: () => void this.quitToTitle(),
    }));
  }

  private onKey(code: string): void {
    if (code === 'F3') this.debug.toggle();
    if (code === 'F1' && this.state === 'playing') {
      this.hudHidden = !this.hudHidden;
      this.hud.setVisible(!this.hudHidden);
    }
    if (code === 'KeyE') {
      if (this.state === 'playing' && this.input.locked) {
        this.state = 'inventory';
        this.suppressPause = true;
        this.input.exitLock();
        this.inventory.open();
      } else if (this.state === 'inventory') {
        void this.resumeGame();
      }
    }
    if (code === 'Escape') {
      if (this.state === 'inventory') void this.resumeGame();
      else if (this.state === 'paused' && this.stack.depth > 1) this.stack.pop();
      else if (this.state === 'menu' && this.stack.depth > 1) this.stack.pop();
    }
  }

  // ---------------------------------------------------------------- frame loop

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    const cpuStart = performance.now();
    this.time += dt;

    switch (this.state) {
      case 'menu': this.updateMenu(dt); break;
      case 'loading': this.updateLoading(); break;
      default: this.updatePlaying(dt);
    }

    this.renderer.render(this.cam.camera, this.cycle, this.time, this.underwater);
    if (this.wantThumbnail) this.captureThumbnail();
    this.world?.chunks.afterRender();
    this.audio.update(dt);
    if (this.debug.tick(dt, performance.now() - cpuStart)) this.updateDebug();
    this.input.endFrame();
  };

  private updateMenu(dt: number): void {
    const world = this.world!;
    this.cycle.time = (this.cycle.time + dt / 2400) % 1;
    this.cycle.compute();
    this.cam.orbit(this.menuOrbit.x, this.menuOrbit.y, this.menuOrbit.z, this.time);
    world.chunks.update(this.menuOrbit.x, this.menuOrbit.z);
    this.renderer.clouds.update(dt, this.cycle);
    this.underwater = false;
  }

  private updateLoading(): void {
    const world = this.world!;
    world.chunks.update(this.player.x, this.player.z, 16 * 1024 * 1024);
    this.cycle.compute();
    const r = 2;
    let ready = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const c = world.chunks.get(Math.floor(this.player.x / 16) + dx, Math.floor(this.player.z / 16) + dz);
        if (c && c.meshedVersion >= 0) ready++;
      }
    }
    const total = (r * 2 + 1) ** 2;
    this.loadingProgress?.(ready === 0 ? 'Generating terrain...' : 'Building chunk meshes...', ready / total);
    // Keep the camera at the spawn so the first frame after loading is correct.
    this.cam.camera.position.set(this.player.x, this.player.y + PHYSICS.EYE_HEIGHT, this.player.z);
    if (world.chunks.isAreaReady(this.player.x, this.player.z, r)) this.finishLoading();
  }

  private updatePlaying(dt: number): void {
    const world = this.world!;
    const p = this.player;
    const input = this.input;
    const active = this.state === 'playing' && input.locked;

    if (active) {
      const sens = 0.0022 * (this.settings.values.sensitivity / 100);
      p.yaw -= input.mouseDX * sens;
      p.pitch -= input.mouseDY * sens * (this.settings.values.invertMouse ? -1 : 1);
      const limit = Math.PI / 2 - 0.001;
      p.pitch = Math.max(-limit, Math.min(limit, p.pitch));
      for (let i = 0; i < 9; i++) if (input.wasPressed(`Digit${i + 1}`)) this.hotbar.select(i);
      if (input.wheel !== 0) this.hotbar.select(this.hotbar.selected + input.wheel);
    }

    if (this.state !== 'paused') {
      // Fixed-step simulation, rendered with interpolation.
      this.accumulator = Math.min(this.accumulator + dt, 0.25);
      const move = this.move;
      move.forward = active ? (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0) : 0;
      move.strafe = active ? (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0) : 0;
      move.jump = active && input.isDown('Space');
      move.jumpPressed = active && input.wasPressed('Space');
      move.sprint = active && (input.isDown('ShiftLeft') || input.isDown('ShiftRight'));
      move.descend = active && input.isDown('KeyC');
      while (this.accumulator >= PHYSICS.STEP) {
        p.step(move, this.getBlock);
        move.jumpPressed = false;
        this.accumulator -= PHYSICS.STEP;
      }
      this.cycle.update(dt);
      this.autosave += dt;
      if (this.autosave > AUTOSAVE_INTERVAL) {
        this.autosave = 0;
        void this.saveGame();
      }
    }
    this.cycle.compute();

    world.chunks.update(p.x, p.z);
    this.cam.update(p, this.accumulator / PHYSICS.STEP, dt);
    if (this.cam.stepped && !p.inWater) {
      const below = world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.1), Math.floor(p.z));
      const def = getBlockDef(below);
      if (def && SOLID[below]) this.audio.play('step', def.sound);
    }

    this.underwater = world.getBlock(Math.floor(this.cam.camera.position.x), Math.floor(this.cam.camera.position.y), Math.floor(this.cam.camera.position.z)) === BLOCK.WATER;
    this.hud.setUnderwater(this.underwater);

    this.updateInteraction(dt, active);
    this.renderer.particles.update(dt, world);
    this.renderer.clouds.update(dt, this.cycle);
  }

  private updateInteraction(dt: number, active: boolean): void {
    const world = this.world!;
    const input = this.input;
    const highlight = this.renderer.highlight;
    const camPos = this.cam.camera.position;
    this.cam.camera.getWorldDirection(this.dir);
    const hit = raycast(this.getBlock, camPos.x, camPos.y, camPos.z,
      this.dir.x, this.dir.y, this.dir.z, PHYSICS.REACH, this.ray);

    if (!hit.hit || !active) {
      highlight.hide();
      highlight.setProgress(0);
      this.breakProgress = 0;
      return;
    }
    highlight.show(hit.x, hit.y, hit.z);
    const def = getBlockDef(hit.id)!;

    // --- Breaking (hold left mouse) ---
    this.breakCooldown -= dt;
    const key = hit.x * 73856093 ^ hit.y * 19349663 ^ hit.z * 83492791;
    if (input.leftDown && def.hardness >= 0 && this.breakCooldown <= 0) {
      if (key !== this.breakKey) {
        this.breakKey = key;
        this.breakProgress = 0;
      }
      this.breakProgress += def.hardness === 0 ? 1 : dt / def.hardness;
      this.hitSoundTimer -= dt;
      if (this.hitSoundTimer <= 0 && this.breakProgress < 1) {
        this.hitSoundTimer = 0.22;
        this.audio.play('hit', def.sound);
        this.renderer.particles.spawnFace(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, hit.id, this.lightAt(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz), 2, world.tintAt(hit.x, hit.z, hit.id));
      }
      if (this.breakProgress >= 1) {
        const light = this.lightAt(hit.x, hit.y + 1, hit.z);
        const broken = world.breakBlock(hit.x, hit.y, hit.z);
        if (broken) {
          this.renderer.particles.spawnBreak(hit.x, hit.y, hit.z, broken, light, world.tintAt(hit.x, hit.z, broken));
          this.audio.play('break', def.sound);
        }
        this.breakProgress = 0;
        this.breakKey = -1;
        this.breakCooldown = 0.18;
      }
    } else if (!input.leftDown) {
      this.breakProgress = 0;
      this.hitSoundTimer = 0;
    }
    highlight.setProgress(this.breakProgress);

    // --- Placing (right click, repeats while held) ---
    this.placeCooldown -= dt;
    if (input.rightClicked || (input.rightDown && this.placeCooldown <= 0)) {
      this.placeCooldown = 0.22;
      this.placeBlock();
    }

    // --- Pick block (middle click) ---
    if (input.middleClicked && getBlockDef(hit.id)?.inInventory) {
      const slot = this.hotbar.slots.indexOf(hit.id);
      if (slot >= 0) this.hotbar.select(slot);
      else this.hotbar.setSlot(this.hotbar.selected, hit.id);
    }
  }

  private placeBlock(): void {
    const world = this.world!;
    const hit = this.ray;
    const id = this.hotbar.selectedBlock;
    if (!id) return;
    let x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    // Placing onto grass/flowers replaces them, like in Minecraft.
    if (SHAPE[hit.id] === SHAPE_CROSS) { x = hit.x; y = hit.y; z = hit.z; }
    const existing = world.getBlock(x, y, z);
    const replaceable = SHAPE[existing] === SHAPE_NONE || SHAPE[existing] === SHAPE_LIQUID || SHAPE[existing] === SHAPE_CROSS;
    if (!replaceable || existing === BLOCK.UNLOADED) return;
    if (SOLID[id] && this.player.intersectsBlock(x, y, z)) return;
    if (SHAPE[id] === SHAPE_CROSS && !SOLID[world.getBlock(x, y - 1, z)]) return;
    if (world.setBlock(x, y, z, id)) {
      const def = getBlockDef(id)!;
      this.audio.play('place', def.sound);
      this.renderer.particles.spawnFace(x - hit.nx, y - hit.ny, z - hit.nz, hit.nx, hit.ny, hit.nz, id, this.lightAt(x, y, z), 3, world.tintAt(x, z, id));
      this.breakProgress = 0;
    }
  }

  private lightAt(x: number, y: number, z: number): number {
    return this.world ? this.world.getLight(x, y, z) : 0xf0;
  }

  // ---------------------------------------------------------------- debug

  private updateDebug(): void {
    const world = this.world;
    if (!world) return;
    const d = this.debug;
    const p = this.player;
    const stats = world.chunks.stats();
    const cam = this.cam.camera;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const visible = world.chunks.countVisible(this.frustum);
    const r = this.renderer.stats;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const yawDeg = ((((-p.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const facing = FACING[Math.round(yawDeg / 90) % 4];
    const light = world.getLight(bx, by, bz);
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const worldBlocks = stats.loaded * CHUNK_VOLUME;
    const target = this.ray.hit ? `${getBlockDef(this.ray.id)?.displayName} @ ${this.ray.x}, ${this.ray.y}, ${this.ray.z}` : '—';
    d.set([
      `BunkCraft 1.0 (WebGL2 · three.js r${THREE.REVISION})`,
      `${d.fps} fps · frame ${d.frameMs.toFixed(2)} ms CPU · worst ${d.worstMs.toFixed(1)} ms`,
      `Chunks: ${stats.loaded} loaded · ${stats.meshed} meshed · ${visible} rendered`,
      `Draw calls: ${r.drawCalls} (+${r.shadowCalls} shadow) · Triangles: ${(r.triangles / 1000).toFixed(1)}k`,
      `Workers: ${this.pool.size} · queue ${this.pool.queued} · gen ${this.pool.genMs.toFixed(1)} ms · mesh ${this.pool.meshMs.toFixed(1)} ms`,
      `Particles: ${this.renderer.particles.active} · Shadow map renders: ${this.renderer.shadows.updates}`,
      '',
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(3)} / ${p.z.toFixed(3)}`,
      `Block: ${bx} ${by} ${bz}`,
      `Chunk: ${bx >> 4} ${bz >> 4} (in chunk ${bx & 15} ${by} ${bz & 15})`,
      `Facing: ${facing} (${yawDeg.toFixed(1)} / ${((-p.pitch * 180) / Math.PI).toFixed(1)})`,
      `Biome: ${BIOME_NAMES[world.biomeName(bx, bz)]}`,
      `Light: ${light >> 4} sky, ${light & 15} block`,
      `Time: ${this.cycle.clock()} · Render distance: ${world.chunks.renderDistance} chunks`,
      `${p.flying ? 'Flying' : p.onGround ? 'On ground' : 'Airborne'}${p.sprinting ? ' · Sprinting' : ''}${p.inWater ? ' · In water' : ''}`,
    ], [
      mem ? `JS heap: ${(mem.usedJSHeapSize / 1048576).toFixed(0)} / ${(mem.totalJSHeapSize / 1048576).toFixed(0)} MB` : 'JS heap: n/a',
      `World blocks: ${(worldBlocks / 1e6).toFixed(2)}M (${(worldBlocks / 1048576).toFixed(1)} MB)`,
      `Edited chunks: ${world.edits.size}`,
      `Upload queue: ${stats.uploadQueue} · in flight ${stats.genInFlight}g/${stats.meshInFlight}m`,
      '',
      `Display: ${window.innerWidth}×${window.innerHeight} @ ${this.renderer.three.getPixelRatio().toFixed(2)}x`,
      `GPU: ${this.gpuName.replace(/^ANGLE \(|\)$/g, '').split(',').slice(0, 2).join(',')}`,
      '',
      `Targeted: ${target}`,
      `Seed: ${world.seed}`,
    ]);
  }
}
