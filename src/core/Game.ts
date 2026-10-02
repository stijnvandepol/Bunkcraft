import * as THREE from 'three';
import { EntityManager } from '../entities/EntityManager';
import { ItemRenderer } from '../entities/ItemRenderer';
import type { Mob, MobEvents } from '../entities/Mob';
import { MobRenderer } from '../entities/MobRenderer';
import { NetClient } from '../net/NetClient';
import type { ServerMessage } from '../net/protocol';
import { RemotePlayers } from '../net/RemotePlayers';
import { Chat } from '../ui/Chat';
import { PlayerInventory } from '../items/Inventory';
import { ITEM, type ItemStack, blockDrop, getItemDef } from '../items/ItemRegistry';
import type { Station } from '../items/Recipes';
import { type GameMode, GAME_MODE_NAMES, canFly, hasSurvivalRules } from '../player/GameMode';
import { PHYSICS } from '../player/Physics';
import { type MoveInput, Player } from '../player/Player';
import { MAX_AIR, PlayerStats } from '../player/PlayerStats';
import { DayCycle } from '../rendering/DayCycle';
import { HandRenderer } from '../rendering/HandRenderer';
import {
  IMPORTED_PREFIX, MINECRAFT_LAYOUT, type PackImage, builtinResolver, findBuiltinPack, importMinecraftArchive, importedResolver, loadPack,
} from '../rendering/TexturePacks';
import { type WorldMeta, SaveSystem, newWorldId } from '../save/SaveSystem';
import { BlockIcons } from '../ui/BlockIcons';
import { DebugOverlay } from '../ui/DebugOverlay';
import { h } from '../ui/dom';
import { applyGuiScale } from '../ui/GuiScale';
import { HUD } from '../ui/HUD';
import { Hotbar } from '../ui/Hotbar';
import { Inventory } from '../ui/Inventory';
import { createLogo } from '../ui/Logo';
import { MainMenu, VERSION, deathScreen, pauseScreen } from '../ui/MainMenu';
import { resourcePacksScreen } from '../ui/ResourcePacksMenu';
import { ScreenStack } from '../ui/Screens';
import { optionsScreen } from '../ui/SettingsMenu';
import { KB, resolveKeybinds } from './Keybinds';
import { SurvivalInventory } from '../ui/SurvivalInventory';
import { WorkerPool } from '../workers/WorkerPool';
import { BLOCK, SOLID, getBlockDef } from '../world/BlockRegistry';
import { CHUNK_VOLUME, blockIndex, chunkKey } from '../world/constants';
import { hashString } from '../world/Noise';
import { BIOME_NAMES } from '../world/TerrainGenerator';
import { World } from '../world/World';
import { AudioEngine } from './Audio';
import { CameraController } from './Camera';
import { Input } from './Input';
import { Interaction } from './Interaction';
import { Renderer } from './Renderer';
import { DynamicResolution, suggestPreset } from './AdaptiveQuality';
import { SettingsStore } from './Settings';

type GameState = 'menu' | 'loading' | 'playing' | 'paused' | 'inventory' | 'dead' | 'chat';

const DEFAULT_HOTBAR = [
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS,
  BLOCK.OAK_LOG, BLOCK.GLASS, BLOCK.TORCH, BLOCK.GLOWSTONE,
];
const MENU_SEED = hashString('BunkCraft');
const AUTOSAVE_INTERVAL = 30;
const FACING = ['south (Towards positive Z)', 'west (Towards negative X)', 'north (Towards negative Z)', 'east (Towards positive X)'];
/** Physics runs at 60 Hz; game logic (entities, health) every 3rd step = 20 ticks/s like Minecraft. */
const STEPS_PER_TICK = 3;

/**
 * Top-level game: state machine (menu → loading → playing ⇄ paused/inventory/dead),
 * fixed-timestep simulation with interpolated rendering, game modes and entities.
 */
export class Game {
  private readonly settings = new SettingsStore();
  private readonly dynamicResolution = new DynamicResolution();
  private readonly renderer: Renderer;
  private readonly input: Input;
  private readonly cam = new CameraController();
  private readonly audio = new AudioEngine();
  private readonly save = new SaveSystem();
  private readonly pool: WorkerPool;
  private readonly cycle = new DayCycle();
  readonly player = new Player();
  private readonly stats = new PlayerStats();
  private readonly playerInventory = new PlayerInventory();
  private readonly icons: BlockIcons;
  private readonly hotbar: Hotbar;
  private readonly hud: HUD;
  private readonly inventory: Inventory;
  private readonly survivalInventory: SurvivalInventory;
  private readonly hand: HandRenderer;
  private readonly mobRenderer: MobRenderer;
  private readonly itemRenderer: ItemRenderer;
  private readonly debug = new DebugOverlay();
  private readonly remote = new RemotePlayers();
  private readonly chat = new Chat();
  /** Mobs plus remote players, handed to the mob renderer each frame. */
  private readonly renderMobs: Mob[] = [];
  /** Multiplayer connection (null in singleplayer). */
  private net: NetClient | null = null;
  private readonly stack: ScreenStack;
  private readonly menu: MainMenu;

  private state: GameState = 'menu';
  private mode: GameMode = 'creative';
  private world: World | null = null;
  private entities: EntityManager | null = null;
  private interaction: Interaction | null = null;
  private meta: WorldMeta | null = null;
  private needsSurface = false;
  private loadingProgress: ((status: string, p: number) => void) | null = null;
  private suppressPause = false;
  private hudHidden = false;
  /** Capture a world icon from the next rendered frame (like Minecraft's world screenshot). */
  private wantThumbnail = false;
  private packCredit = 'Procedural textures';
  private score = 0;

  private last = 0;
  private time = 0;
  private accumulator = 0;
  private stepCount = 0;
  private autosave = 0;
  private menuOrbit = new THREE.Vector3();

  private readonly move: MoveInput = { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };
  /** Bound once: avoids allocating a closure per frame for physics. */
  private readonly getBlock = (x: number, y: number, z: number): number => this.world ? this.world.getBlock(x, y, z) : BLOCK.UNLOADED;
  private underwater = false;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private gpuName = '';
  private contextLost: HTMLDivElement | null = null;

  constructor(root: HTMLElement) {
    const canvas = root.querySelector<HTMLCanvasElement>('#game')!;
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    // Leave cores for the main thread and the browser GPU process (smoother frame pacing).
    this.pool = new WorkerPool(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
    this.icons = new BlockIcons(this.renderer.textures);
    this.hotbar = new Hotbar(this.icons, this.playerInventory);
    this.hud = new HUD(this.hotbar);
    this.inventory = new Inventory(this.icons, this.hotbar);
    this.survivalInventory = new SurvivalInventory(this.icons, this.playerInventory, {
      drop: (s) => this.throwStack(s),
      close: () => void this.resumeGame(),
    });
    this.playerInventory.onChange = () => {
      this.hotbar.refresh();
      this.survivalInventory.refresh();
    };
    this.stack = new ScreenStack(root.querySelector<HTMLElement>('#screens')!);
    root.append(this.remote.el, this.chat.el, this.hud.el, this.debug.el, this.inventory.el, this.survivalInventory.el);
    this.chat.onSend = (text) => this.net?.sendChat(text);
    this.chat.onClose = () => {
      if (this.state === 'chat') void this.resumeGame();
    };

    // Entities and the first-person hand.
    this.hand = new HandRenderer(this.renderer.uniforms, this.icons);
    this.mobRenderer = new MobRenderer(this.renderer.uniforms);
    this.itemRenderer = new ItemRenderer(this.renderer.uniforms, this.icons);
    this.renderer.scene.add(this.mobRenderer.group, this.itemRenderer.mesh);
    this.renderer.shadowExcluded.push(this.mobRenderer.group, this.itemRenderer.mesh);
    this.renderer.afterMain = (three) => {
      if (this.state === 'playing' || this.state === 'inventory' || this.state === 'paused' || this.state === 'chat') this.hand.render(three);
    };

    this.menu = new MainMenu(this.stack, {
      listWorlds: () => this.save.listWorlds(),
      playWorld: (m) => void this.enterWorld(m),
      createWorld: (name, seed, mode) => void this.createWorld(name, seed, mode),
      deleteWorld: (id) => this.save.deleteWorld(id),
      openOptions: () => this.openOptions(),
      joinServer: (name, address) => void this.joinServer(name, address),
      logo: () => createLogo('BUNKCRAFT', this.renderer.textures.canvas('stone')),
      defaultWorldIcon: () => this.icons.get(BLOCK.GRASS),
    });

    this.inventory.onClose = () => void this.resumeGame();
    this.stats.onHurt = () => this.audio.playHurt();
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
      this.audio.setSuspended(document.hidden);
      // Avoid a big catch-up step when the tab comes back.
      this.last = performance.now();
    });
    // WebGL context loss (GPU reset, driver update, too many tabs): pause and recover.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.state === 'playing') this.pause();
      this.contextLost = h('div', { class: 'screen menu-bg', style: 'justify-content: center' },
        h('div', { text: 'Graphics context lost — restoring...' }));
      root.append(this.contextLost);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost?.remove();
      this.contextLost = null;
      this.renderer.textures.texture.needsUpdate = true;
      this.renderer.shadows.invalidate();
      this.world?.chunks.remeshAll();
    });
    window.addEventListener('pagehide', () => void this.saveGame());
    // Audio needs a user gesture before it may start.
    window.addEventListener('pointerdown', () => this.audio.unlock());
    window.addEventListener('keydown', () => this.audio.unlock());

    const gl = this.renderer.three.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
    if (this.settings.fresh) {
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      this.settings.setMany(suggestPreset(this.gpuName, navigator.hardwareConcurrency || 0, memory).values);
    }
  }

  async start(): Promise<void> {
    await this.save.open();
    // Safari otherwise evicts IndexedDB (the saved worlds) after 7 days without a visit.
    void navigator.storage?.persist?.().catch(() => false);
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
        'Terrain, mobs, sounds, music, sky and procedural textures: generated in code',
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
    this.dynamicResolution.enabled = s.dynamicResolution;
    if (!s.dynamicResolution) this.renderer.setDynamicScale(1);
    this.updateMenuBlur();
    this.cam.baseFov = s.fov;
    this.cam.viewBobbing = s.viewBobbing;
    if (!key || key === 'keybinds') this.input.setBindings(resolveKeybinds(s.keybinds));
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

  /** Menu backdrop blur only when the GPU has headroom (Fancy, full dynamic resolution). */
  private updateMenuBlur(): void {
    const weak = this.settings.values.graphics === 'fast' || this.dynamicResolution.scale < 1;
    document.body.classList.toggle('no-blur', weak);
  }

  // ---------------------------------------------------------------- game modes

  private setMode(mode: GameMode): void {
    this.mode = mode;
    const p = this.player;
    p.canFly = canFly(mode);
    p.noclip = mode === 'spectator';
    if (!p.canFly) p.flying = false;
    const survival = hasSurvivalRules(mode);
    this.hotbar.showCounts = survival;
    this.hotbar.refresh();
    this.hud.setMode(mode !== 'spectator', survival);
    this.hand.visible = mode !== 'spectator';
    if (this.meta) this.meta.gameMode = mode;
  }

  // ---------------------------------------------------------------- world lifecycle

  private createWorldInstance(seed: number, edits?: Map<number, Map<number, number>>): World {
    this.world?.dispose();
    const world = new World(seed, this.pool, { opaque: this.renderer.chunkMaterial, cutout: this.renderer.cutoutMaterial, water: this.renderer.waterMaterial }, edits);
    world.chunks.fancyLeaves = this.settings.values.graphics === 'fancy';
    world.chunks.renderDistance = this.settings.values.renderDistance;
    this.world = world;
    this.renderer.attachWorld(world);
    // Entities live with the world.
    const entities = new EntityManager(world, seed);
    world.onChunkReady = (c) => entities.onChunkReady(c);
    world.onChunkUnloaded = (k) => entities.onChunkUnloaded(k);
    this.entities = entities;
    this.interaction = new Interaction({
      world, player: this.player, stats: this.stats, inventory: this.playerInventory, hotbar: this.hotbar,
      entities, renderer: this.renderer, hand: this.hand, audio: this.audio, camera: this.cam.camera,
    });
    return world;
  }

  private enterMenu(): void {
    this.state = 'menu';
    this.meta = null;
    this.hud.setVisible(false);
    this.inventory.close();
    this.survivalInventory.close();
    const world = this.createWorldInstance(MENU_SEED);
    world.chunks.renderDistance = Math.min(this.settings.values.renderDistance, 6);
    // The menu panorama shows animals but no monsters.
    this.entities!.hostileSpawning = false;
    const spawn = world.findSpawn();
    this.menuOrbit.set(spawn.x, world.generator.heightAt(spawn.x, spawn.z) + 14, spawn.z);
    this.cycle.time = 0.09;
    this.menu.showTitle();
  }

  private async createWorld(name: string, seedText: string, mode: GameMode): Promise<void> {
    let seed: number;
    if (!seedText) seed = (Math.random() * 4294967296) >>> 0;
    else if (/^-?\d+$/.test(seedText)) seed = Number(BigInt.asUintN(32, BigInt(seedText)));
    else seed = hashString(seedText);
    const meta: WorldMeta = {
      id: newWorldId(), name, seed, seedText: seedText || String(seed),
      created: Date.now(), lastPlayed: Date.now(), player: null,
      hotbar: [...DEFAULT_HOTBAR], selectedSlot: 0, time: 0.08, gameMode: mode,
    };
    await this.save.saveWorld(meta);
    await this.enterWorld(meta);
  }

  private async enterWorld(meta: WorldMeta): Promise<void> {
    this.audio.unlock();
    this.loadingProgress = this.menu.showLoading('Loading world');
    this.loadingProgress('Reading save data...', 0);
    const edits = await this.save.loadEdits(meta.id);
    this.startSession(meta, edits);
  }

  /** Common world setup for singleplayer saves and multiplayer servers. */
  private startSession(meta: WorldMeta, edits: Map<number, Map<number, number>>): void {
    this.meta = meta;
    const world = this.createWorldInstance(meta.seed, edits);
    this.cycle.time = meta.time;
    const mode = meta.gameMode ?? 'creative';
    // Inventory: saved stacks, else creative gets the default hotbar and survival starts empty.
    if (meta.inventory) this.playerInventory.load(meta.inventory);
    else {
      this.playerInventory.clear();
      if (!hasSurvivalRules(mode)) meta.hotbar.forEach((id, i) => this.playerInventory.set(i, { id, count: id ? 1 : 0 }));
    }
    this.stats.load(meta.stats);
    this.score = 0;
    // A save made on the death screen: hardcore becomes spectator, others respawn at spawn.
    const diedBeforeSave = this.stats.wasDead;
    this.setMode(diedBeforeSave && mode === 'hardcore' ? 'spectator' : mode);
    this.hotbar.selected = meta.selectedSlot;
    this.hotbar.refresh();
    const p = diedBeforeSave && mode !== 'hardcore' ? null : meta.player;
    if (p) {
      this.player.setPosition(p.x, p.y, p.z);
      this.player.yaw = p.yaw;
      this.player.pitch = p.pitch;
      this.player.flying = p.flying && this.player.canFly;
      this.needsSurface = false;
    } else {
      const spawn = meta.spawn ?? world.findSpawn();
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
    if (this.meta && !this.meta.spawn) this.meta.spawn = { x: this.player.x, y: this.player.y, z: this.player.z };
    this.player.fallDistance = 0;
    this.player.landedFall = 0;
    this.loadingProgress = null;
    this.autosave = 0;
    void this.resumeGame();
  }

  private async saveGame(): Promise<void> {
    const world = this.world, meta = this.meta;
    if (!world || !meta || this.state === 'loading' || this.state === 'menu') return;
    // Items held on the inventory cursor go back into the inventory before saving.
    this.survivalInventory.flushCursor();
    if (this.net) {
      // Multiplayer: the server stores position, inventory and health per player.
      this.net.sendState(this.playerInventory.serialize(), this.stats.serialize());
      return;
    }
    const p = this.player;
    meta.player = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flying: p.flying };
    meta.hotbar = Array.from({ length: 9 }, (_, i) => this.playerInventory.get(i).id);
    meta.inventory = this.playerInventory.serialize();
    meta.stats = this.stats.serialize();
    meta.gameMode = this.mode;
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
    this.disconnect();
    this.input.exitLock();
    this.stack.clear();
    this.enterMenu();
  }

  // ---------------------------------------------------------------- multiplayer

  private async joinServer(name: string, address: string): Promise<void> {
    this.audio.unlock();
    const progress = this.menu.showLoading('Connecting to the server...');
    progress('Logging in...', 0);
    const net = new NetClient();
    let welcome;
    try {
      welcome = await net.connect(address, name);
    } catch (e) {
      this.menu.showDisconnected(e instanceof Error ? e.message : String(e));
      return;
    }
    this.net = net;
    // Terrain comes from the seed; only the server's edit list is transferred.
    const edits = new Map<number, Map<number, number>>();
    const list = welcome.edits;
    for (let i = 0; i + 3 < list.length; i += 4) {
      const x = list[i], y = list[i + 1], z = list[i + 2], id = list[i + 3];
      const key = chunkKey(x >> 4, z >> 4);
      let m = edits.get(key);
      if (!m) { m = new Map(); edits.set(key, m); }
      m.set(blockIndex(x & 15, y, z & 15), id);
    }
    const rec = welcome.player;
    const meta: WorldMeta = {
      id: 'mp:' + address, name: welcome.worldName, seed: welcome.seed, seedText: '', created: 0, lastPlayed: Date.now(),
      player: rec ? { x: rec.x, y: rec.y, z: rec.z, yaw: rec.yaw, pitch: rec.pitch, flying: false } : null,
      hotbar: [...DEFAULT_HOTBAR], selectedSlot: 0, time: welcome.time, gameMode: welcome.gameMode,
      inventory: rec?.inventory, stats: rec?.stats, spawn: welcome.spawn,
    };
    this.loadingProgress = progress;
    this.startSession(meta, edits);
    const world = this.world!;
    // Multiplayer v1 is peaceful: mobs are not simulated by the server yet.
    this.entities!.passiveSpawning = false;
    this.entities!.hostileSpawning = false;
    world.onEdit = (x, y, z, id, prev) => net.sendBlock(x, y, z, id, prev);
    net.onRevert = (x, y, z, id) => world.applyRemoteEdit(x, y, z, id);
    net.onMessage = (msg) => this.onServerMessage(msg);
    net.onClose = (reason) => {
      if (this.net !== net) return;
      this.disconnect();
      this.input.exitLock();
      this.enterMenu();
      this.menu.showDisconnected(reason);
    };
    this.remote.clear();
    for (const p of welcome.players) this.remote.add(p.id, p.name);
    this.chat.clear();
    this.chat.setVisible(true);
    if (welcome.motd) this.chat.add(welcome.motd, true);
  }

  private onServerMessage(msg: ServerMessage): void {
    const world = this.world;
    switch (msg.t) {
      case 'snap': this.remote.snapshot(msg.players, this.net?.id ?? -1, performance.now() / 1000); break;
      case 'block': world?.applyRemoteEdit(msg.x, msg.y, msg.z, msg.id); break;
      case 'join': this.remote.add(msg.id, msg.name); break;
      case 'leave': this.remote.remove(msg.id); break;
      case 'chat': this.chat.add(msg.system ? msg.text : '<' + msg.from + '> ' + msg.text, msg.system); break;
      case 'time': this.cycle.time = msg.time; break;
      case 'teleport': this.player.setPosition(msg.x, msg.y, msg.z); break;
      default: break;
    }
  }

  private disconnect(): void {
    if (!this.net) return;
    const net = this.net;
    this.net = null;
    net.close();
    this.remote.clear();
    this.chat.close();
    this.chat.setVisible(false);
  }

  // ---------------------------------------------------------------- death

  private onDeath(): void {
    this.inventory.close();
    this.survivalInventory.close();
    this.chat.close();
    this.state = 'dead';
    if (this.input.locked) {
      this.suppressPause = true;
      this.input.exitLock();
    }
    this.interaction?.reset();
    // Drop the whole inventory where the player died.
    const p = this.player;
    for (let i = 0; i < 36; i++) {
      const s = this.playerInventory.get(i);
      if (s.count > 0) this.entities?.dropItem(s, p.x, p.y + 1, p.z, 40, undefined, true);
    }
    this.playerInventory.clear();
    const hardcore = this.mode === 'hardcore';
    // Hardcore: the single life is gone even if the tab is closed now.
    if (hardcore && this.meta) this.meta.gameMode = 'spectator';
    this.stack.clear();
    this.stack.push(deathScreen({
      hardcore,
      message: this.stats.deathMessage,
      score: this.score,
      respawn: () => this.respawn(),
      spectate: () => {
        this.stats.reset();
        this.setMode('spectator');
        void this.resumeGame();
      },
      title: () => {
        if (hardcore) this.setMode('spectator');
        else {
          this.stats.reset();
          this.player.setPosition(this.meta?.spawn?.x ?? this.player.x, this.meta?.spawn?.y ?? this.player.y, this.meta?.spawn?.z ?? this.player.z);
          if (this.meta) this.meta.player = null;
        }
        void this.quitToTitle();
      },
    }));
  }

  /**
   * Respawn goes through the loading path: the spawn chunk may have been unloaded, and
   * placing the player before it exists would push them up and drop them to their death.
   */
  private respawn(): void {
    this.stats.reset();
    const s = this.meta?.spawn ?? { x: this.player.x, y: this.player.y, z: this.player.z };
    this.player.setPosition(s.x, s.y, s.z);
    this.player.vx = this.player.vy = this.player.vz = 0;
    this.player.fallDistance = 0;
    this.player.landedFall = 0;
    this.needsSurface = true;
    this.stack.clear();
    this.state = 'loading';
  }

  // ---------------------------------------------------------------- input / states

  private async resumeGame(): Promise<void> {
    this.inventory.close();
    this.survivalInventory.close();
    this.stack.clear();
    this.suppressPause = false;
    this.state = 'playing';
    this.hud.setVisible(!this.hudHidden);
    await this.input.requestLock();
    if (!this.input.locked && this.state === 'playing') {
      // The world must not keep running (mobs, hunger) behind the overlay.
      this.state = 'paused';
      this.showClickToPlay();
    }
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
      multiplayer: this.net !== null,
    }));
  }

  /** Crafting stations within 4 blocks of the player. */
  private nearbyStations(): Set<Station> {
    const s = new Set<Station>(['hand']);
    const p = this.player;
    for (let y = -2; y <= 3; y++) for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
      const b = this.getBlock(Math.floor(p.x) + x, Math.floor(p.y) + y, Math.floor(p.z) + z);
      if (b === BLOCK.CRAFTING_TABLE) s.add('table');
      else if (b === BLOCK.FURNACE) s.add('furnace');
    }
    return s;
  }

  private onKey(code: string): void {
    if (this.chat.isOpen) return;
    const input = this.input;
    const command = code === input.bound(KB.COMMAND);
    if ((command || code === input.bound(KB.CHAT)) && this.net && this.state === 'playing' && this.input.locked) {
      this.state = 'chat';
      this.suppressPause = this.input.locked;
      this.input.exitLock();
      this.chat.openInput(command ? '/' : '');
      return;
    }
    if (code === 'F3') this.debug.toggle();
    if (code === 'F1' && this.state === 'playing') {
      this.hudHidden = !this.hudHidden;
      this.hud.setVisible(!this.hudHidden);
    }
    if (code === input.bound(KB.INVENTORY)) {
      if (this.state === 'playing' && this.input.locked && this.mode !== 'spectator') {
        this.state = 'inventory';
        this.suppressPause = this.input.locked;
        this.input.exitLock();
        if (this.mode === 'creative') this.inventory.open();
        else this.survivalInventory.open(this.nearbyStations());
      } else if (this.state === 'inventory') {
        void this.resumeGame();
      }
    }
    if (code === input.bound(KB.DROP) && this.state === 'playing' && this.input.locked && this.mode !== 'spectator') {
      // Drop one item from the selected slot (Q), like Minecraft.
      const s = this.hotbar.selectedStack;
      if (s.count > 0) {
        this.throwStack({ ...s, count: 1 });
        if (hasSurvivalRules(this.mode)) this.playerInventory.consumeSlot(this.hotbar.selected);
      }
    }
    if (code === 'Escape') {
      if (this.state === 'inventory') void this.resumeGame();
      else if (this.state === 'paused' && this.stack.depth > 1) this.stack.pop();
      else if (this.state === 'menu' && this.stack.depth > 1) this.stack.pop();
    }
  }

  private throwStack(stack: ItemStack): void {
    const p = this.player;
    this.entities?.dropItem(stack, p.x, p.eyeY - 0.3, p.z, 40, p.yaw);
  }

  // ---------------------------------------------------------------- frame loop

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(rawDt, 0.1);
    this.last = now;
    const cpuStart = performance.now();
    this.time += dt;

    switch (this.state) {
      case 'menu': this.updateMenu(dt); break;
      case 'loading': this.updateLoading(); break;
      default: this.updatePlaying(dt);
    }
    this.updateEntitiesRender();

    this.renderer.render(this.cam.camera, this.cycle, this.time, this.underwater);
    if (this.state === 'playing' && !document.hidden && this.dynamicResolution.update(rawDt, this.renderer.basePixelRatio)) {
      this.renderer.setDynamicScale(this.dynamicResolution.scale);
      this.updateMenuBlur();
    }
    if (this.wantThumbnail) this.captureThumbnail();
    this.world?.chunks.afterRender();
    this.audio.update(dt);
    if (this.debug.tick(dt, performance.now() - cpuStart)) this.updateDebug();
    this.input.endFrame();
  };

  private updateEntitiesRender(): void {
    const e = this.entities, world = this.world;
    if (!e || !world) return;
    // Interpolation factor between 20 Hz entity ticks.
    const alpha = Math.min(1, ((this.stepCount % STEPS_PER_TICK) + this.accumulator / PHYSICS.STEP) / STEPS_PER_TICK);
    const list = this.renderMobs;
    list.length = 0;
    for (const m of e.mobs) list.push(m);
    for (const m of this.remote.mobs) list.push(m);
    this.mobRenderer.update(list, alpha, world);
    this.itemRenderer.update(e.items, alpha, this.time, world);
  }

  private updateMenu(dt: number): void {
    const world = this.world!;
    this.cycle.time = (this.cycle.time + dt / 2400) % 1;
    this.cycle.compute();
    this.cam.orbit(this.menuOrbit.x, this.menuOrbit.y, this.menuOrbit.z, this.time);
    world.chunks.update(this.menuOrbit.x, this.menuOrbit.z);
    this.renderer.clouds.update(dt, this.cycle);
    this.underwater = false;
    // Animals wander around in the panorama.
    this.accumulator += dt;
    while (this.accumulator >= PHYSICS.STEP) {
      this.accumulator -= PHYSICS.STEP;
      if (++this.stepCount % STEPS_PER_TICK === 0) {
        this.entities?.tick({ x: this.menuOrbit.x, y: this.menuOrbit.y, z: this.menuOrbit.z, attackable: false }, 0, this.mobEvents, null, true);
      }
    }
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

  private readonly mobEvents: MobEvents = {
    attack: (mob, damage) => {
      const p = this.player;
      const yaw = Math.atan2(p.x - mob.x, p.z - mob.z);
      if (this.stats.damage(damage, 'mob', this.mode, mob.type.name, yaw)) {
        // Knockback away from the attacker.
        const d = Math.hypot(p.x - mob.x, p.z - mob.z) || 1;
        p.vx += ((p.x - mob.x) / d) * 8;
        p.vz += ((p.z - mob.z) / d) * 8;
        p.vy = Math.max(p.vy, 6);
        this.cam.hurtSide = Math.sin(yaw - p.yaw) >= 0 ? 1 : -1;
      }
    },
    explode: (mob) => this.explode(mob, mob.x, mob.y + 0.5, mob.z, 3),
    sound: (mob, kind) => {
      const d = Math.hypot(mob.x - this.player.x, mob.y - this.player.y, mob.z - this.player.z);
      this.audio.playMob(mob.type.kind, kind, Math.max(0, 1 - d / 16));
    },
  };

  /** Creeper explosion: blocks, drops, damage with distance falloff, knockback, effects. */
  private explode(source: Mob | null, x: number, y: number, z: number, power: number): void {
    const world = this.world!, entities = this.entities!;
    const destroyed = world.explode(x, y, z, power * 1.3);
    // Drop roughly 1/power of the destroyed blocks, like Minecraft.
    for (const id of destroyed) {
      if (Math.random() < 1 / power && getBlockDef(id)?.inInventory) {
        const drop = blockDrop(id, ITEM.DIAMOND_PICKAXE);
        if (drop) entities.dropItem(drop,
          x + (Math.random() - 0.5) * power, y + Math.random() * power * 0.5, z + (Math.random() - 0.5) * power);
      }
    }
    for (let i = 0; i < 6; i++) {
      this.renderer.particles.spawnBreak(Math.floor(x + (Math.random() - 0.5) * 4), Math.floor(y + (Math.random() - 0.5) * 3),
        Math.floor(z + (Math.random() - 0.5) * 4), BLOCK.COBBLESTONE, 0xf0);
    }
    const p = this.player;
    const d = Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z);
    this.audio.playExplosion(Math.max(0.2, 1 - d / 40));
    const reach = power * 2;
    if (d < reach) {
      const impact = 1 - d / reach;
      const dmg = Math.floor(((impact * impact + impact) / 2) * 7 * reach + 1);
      this.stats.damage(dmg, 'explosion', this.mode, source ? source.type.name : '', Math.atan2(p.x - x, p.z - z));
      const len = d || 1;
      p.vx += ((p.x - x) / len) * impact * 14;
      p.vz += ((p.z - z) / len) * impact * 14;
      p.vy += impact * 9;
    }
    for (const m of entities.mobs) {
      const md = Math.hypot(m.x - x, m.y - y, m.z - z);
      if (m !== source && md < reach) m.hurt(Math.floor((1 - md / reach) * 7 * power), x, z, 1.5);
    }
  }

  /** 20 Hz game tick: health, hunger, entities. */
  private gameTick(): void {
    const p = this.player, stats = this.stats;
    // Fall damage on landing (distance − 3), not in creative or water.
    if (p.landedFall > 0) {
      const dmg = Math.ceil(p.landedFall - 3);
      if (dmg > 0 && !p.inWater) {
        if (this.stats.damage(dmg, 'fall', this.mode)) this.cam.hurtSide = 1;
      }
      p.landedFall = 0;
    }
    if (hasSurvivalRules(this.mode)) {
      // Exhaustion from movement (Minecraft values).
      stats.addExhaustion(p.sprintDistance * 0.1 + p.swimDistance * 0.01 + p.jumps * (p.sprinting ? 0.2 : 0.05));
    }
    p.sprintDistance = p.swimDistance = 0;
    p.jumps = 0;
    stats.tick(p, this.getBlock, this.mode);
    p.canSprint = !hasSurvivalRules(this.mode) || stats.canSprint;

    const alive = !stats.dead;
    this.entities?.tick(
      { x: p.x, y: p.y, z: p.z, attackable: alive && hasSurvivalRules(this.mode) },
      Math.round((1 - this.cycle.dayFactor) * 11),
      this.mobEvents,
      alive && this.mode !== 'spectator' ? (s) => {
        const left = this.playerInventory.add(s);
        if (left < s.count) this.audio.playPop();
        return left;
      } : null,
      this.cycle.dayFactor > 0.6,
    );
    if (stats.dead && (this.state === 'playing' || this.state === 'inventory' || this.state === 'chat' || this.state === 'paused')) this.onDeath();
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
      for (let i = 0; i < 9; i++) if (input.actionPressed(KB.HOTBAR_1 + i)) this.hotbar.select(i);
      if (input.wheel !== 0) this.hotbar.select(this.hotbar.selected + input.wheel);
    }

    if (this.state !== 'paused') {
      // Fixed-step simulation, rendered with interpolation.
      this.accumulator = Math.min(this.accumulator + dt, 0.25);
      const move = this.move;
      const control = active && this.state !== 'dead';
      move.forward = control ? (input.actionDown(KB.FORWARD) ? 1 : 0) - (input.actionDown(KB.BACK) ? 1 : 0) : 0;
      move.strafe = control ? (input.actionDown(KB.RIGHT) ? 1 : 0) - (input.actionDown(KB.LEFT) ? 1 : 0) : 0;
      move.jump = control && input.actionDown(KB.JUMP);
      move.jumpPressed = control && input.actionPressed(KB.JUMP);
      move.sprint = control && input.actionDown(KB.SPRINT);
      move.descend = control && input.actionDown(KB.SNEAK);
      while (this.accumulator >= PHYSICS.STEP) {
        p.step(move, this.getBlock);
        move.jumpPressed = false;
        this.accumulator -= PHYSICS.STEP;
        if (++this.stepCount % STEPS_PER_TICK === 0) this.gameTick();
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
    this.cam.hurt = Math.max(0, (this.stats.hurtTime - this.accumulator / PHYSICS.STEP / STEPS_PER_TICK) / 10);
    this.cam.update(p, this.accumulator / PHYSICS.STEP, dt);
    if (this.cam.stepped && !p.inWater && !p.noclip) {
      const below = world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.1), Math.floor(p.z));
      const def = getBlockDef(below);
      if (def && SOLID[below]) this.audio.play('step', def.sound);
    }

    const eye = this.cam.camera.position;
    this.underwater = world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) === BLOCK.WATER;
    this.hud.setUnderwater(this.underwater);
    this.hud.setHurt(this.stats.hurtTime / 10);
    this.hud.survival.update({ health: this.stats.health, hunger: this.stats.hunger, air: this.stats.air, maxAir: MAX_AIR }, this.time);

    if (this.net) {
      const flags = (p.sprinting ? 1 : 0) | (p.flying ? 2 : 0) | (p.onGround ? 4 : 0);
      this.net.update(dt, p.x, p.y, p.z, p.yaw, p.pitch, flags, this.hotbar.selectedBlock);
      this.remote.update(performance.now() / 1000, this.cam.camera, window.innerWidth, window.innerHeight);
    }
    this.interaction!.update(dt, active, input, this.mode);
    const held = this.hotbar.selectedBlock;
    this.hand.update(dt, held, this.cam.bobPhase, this.cam.bobStrength, world.getLight(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)),
      this.interaction!.eating, window.innerWidth / Math.max(1, window.innerHeight));
    this.renderer.particles.update(dt, world);
    this.renderer.clouds.update(dt, this.cycle);
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
    const ray = this.interaction?.ray;
    const target = ray?.hit ? `${getBlockDef(ray.id)?.displayName} @ ${ray.x}, ${ray.y}, ${ray.z}` : '—';
    const e = this.entities;
    d.set([
      `BunkCraft 1.0 (WebGL2 · three.js r${THREE.REVISION})`,
      `${d.fps} fps · frame ${d.frameMs.toFixed(2)} ms CPU · worst ${d.worstMs.toFixed(1)} ms`,
      `Chunks: ${stats.loaded} loaded · ${stats.meshed} meshed · ${visible} rendered`,
      `Draw calls: ${r.drawCalls} (+${r.shadowCalls} shadow) · Triangles: ${(r.triangles / 1000).toFixed(1)}k`,
      `Workers: ${this.pool.size} · queue ${this.pool.queued} · gen ${this.pool.genMs.toFixed(1)} ms · mesh ${this.pool.meshMs.toFixed(1)} ms`,
      `Entities: ${e?.mobs.length ?? 0} mobs · ${e?.items.length ?? 0} items · Particles: ${this.renderer.particles.active}`,
      '',
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(3)} / ${p.z.toFixed(3)}`,
      `Block: ${bx} ${by} ${bz}`,
      `Chunk: ${bx >> 4} ${bz >> 4} (in chunk ${bx & 15} ${by} ${bz & 15})`,
      `Facing: ${facing} (${yawDeg.toFixed(1)} / ${((-p.pitch * 180) / Math.PI).toFixed(1)})`,
      `Biome: ${BIOME_NAMES[world.biomeName(bx, bz)]}`,
      `Light: ${light >> 4} sky, ${light & 15} block`,
      `Time: ${this.cycle.clock()} · Render distance: ${world.chunks.renderDistance} chunks`,
      `${GAME_MODE_NAMES[this.mode]} · ${p.flying ? 'Flying' : p.onGround ? 'On ground' : 'Airborne'}${p.sprinting ? ' · Sprinting' : ''}${p.inWater ? ' · In water' : ''}`,
      `Health ${this.stats.health} · Food ${this.stats.hunger} (sat ${this.stats.saturation.toFixed(1)}) · Air ${this.stats.air}`,
    ], [
      mem ? `JS heap: ${(mem.usedJSHeapSize / 1048576).toFixed(0)} / ${(mem.totalJSHeapSize / 1048576).toFixed(0)} MB` : 'JS heap: n/a',
      `World blocks: ${(worldBlocks / 1e6).toFixed(2)}M (${(worldBlocks / 1048576).toFixed(1)} MB)`,
      `Edited chunks: ${world.edits.size}`,
      `Upload queue: ${stats.uploadQueue} · in flight ${stats.genInFlight}g/${stats.meshInFlight}m`,
      '',
      `Display: ${window.innerWidth}×${window.innerHeight} @ ${this.renderer.three.getPixelRatio().toFixed(2)}x`
        + (this.dynamicResolution.enabled ? ` (dynamic ${Math.round(this.dynamicResolution.scale * 100)}%)` : ''),
      `GPU: ${this.gpuName.replace(/^ANGLE \(|\)$/g, '').split(',').slice(0, 2).join(',')}`,
      '',
      `Targeted: ${target}`,
      `Holding: ${getItemDef(this.hotbar.selectedBlock)?.displayName ?? 'Empty hand'}`,
      `Seed: ${world.seed}`,
    ]);
  }
}
