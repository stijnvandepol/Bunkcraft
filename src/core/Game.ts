import { enableRedstone, redstoneSound } from './RedstoneHooks';
import * as THREE from 'three';
import { MobSteps } from './audio/mobSteps';
import { PlayerSounds, surfaceLookup } from './audio/playerSounds';
import { WorldAudioProbe } from './audio/worldProbe';
import { bindUiSounds } from '../ui/uiSound';
import { EntityManager } from '../entities/EntityManager';
import { ItemRenderer } from '../entities/ItemRenderer';
import { TntRenderer } from '../entities/TntRenderer';
import { FallingBlockRenderer } from '../entities/FallingBlockRenderer';
import { NetFalling } from '../net/NetFalling';
import type { FallingBlock } from '../world/BlockUpdates';
import { ArrowRenderer } from '../entities/ArrowRenderer';
import type { Mob, MobEvents } from '../entities/Mob';
import { explosionDamage, explosionDropChance } from '../entities/Explosion';
import { MobRenderer } from '../entities/MobRenderer';
import { type UseResult, canUseOnMob, useOnMob } from '../entities/MobInteraction';
import { mount as mountHorse, rideStep } from '../entities/Riding';
import { type MobEffect, arrowEffect, meleeEffect, witchPotion } from '../entities/MobEffects';
import { EFFECT_DEFS, isEffectId } from '../player/Effects';
import { ConnectError, NetClient, type WelcomeMessage } from '../net/NetClient';
import { backoffMs, clearTicket, ticketToken } from '../net/Rejoin';
import { NetEntities } from '../net/NetEntities';
import { useBoneMeal } from '../world/Growth';
import { farmStateText, trample } from '../world/Farming';
import { normalizePartyCode } from '../modes/Party';
import { type ClientMessage, SNAP_FLAG_CROUCH, SNAP_FLAG_SLIDE, type ServerMessage, formatCode, normalizeCode } from '../net/protocol';
import { type GameType, TEAM_COLORS, gameTypeDef } from '../modes/GameTypes';
import { ARCADE_POS_HZ, arcadeInterpDelay } from '../modes/ArcadeLogic';
import { inviteLink, inviteText, rememberGame } from '../net/RoomApi';
import { RemotePlayers } from '../net/RemotePlayers';
import { skinPrefs } from '../net/SkinPrefs';
import { playersScreen } from '../ui/PlayersPanel';
import { Chat } from '../ui/Chat';
import { PlayerInventory } from '../items/Inventory';
import { facingFromCameraYaw } from './Facing';
import { ITEM, type ItemStack, blockDrop, blockDrops, decodeData, encodeData, getItemDef } from '../items/ItemRegistry';
import type { Station } from '../items/Recipes';
import { type GameMode, GAME_MODE_NAMES, canFly, hasSurvivalRules } from '../player/GameMode';
import { PHYSICS } from '../player/Physics';
import { type MoveInput, Player } from '../player/Player';
import { MAX_AIR, PlayerStats } from '../player/PlayerStats';
import { DayCycle, MOON_PHASE_NAMES } from '../rendering/DayCycle';
import { HandRenderer } from '../rendering/HandRenderer';
import {
  IMPORTED_PREFIX, MINECRAFT_LAYOUT, type PackImage, bundledResolver, findBuiltinPack, importMinecraftArchive, importedResolver, loadPack,
} from '../rendering/TexturePacks';
import { type WorldMeta, SaveSystem, cheatsAllowed, newWorldId } from '../save/SaveSystem';
import { BlockIcons } from '../ui/BlockIcons';
import { DebugOverlay } from '../ui/DebugOverlay';
import { h } from '../ui/dom';
import { applyGuiScale } from '../ui/GuiScale';
import { HUD } from '../ui/HUD';
import { Hotbar } from '../ui/Hotbar';
import { Inventory } from '../ui/Inventory';
import { AdvancementTracker, showsToast } from '../player/Advancements';
import { AdvancementToasts } from '../ui/AdvancementToasts';
import { advancementsScreen } from '../ui/AdvancementsScreen';
import { statisticsScreen } from '../ui/StatisticsScreen';
import { initKeyboardLock, keyboardLockActive } from '../pwa/KeyboardLock';
import { showToast } from '../pwa/Toast';
import { parseShareParams } from '../save/share';
import { WorldTransfer } from '../save/WorldTransfer';
import { downloadBlob } from '../ui/download';
import { MainMenu, VERSION, deathScreen, inviteScreen, pauseScreen } from '../ui/MainMenu';
import { resourcePacksScreen } from '../ui/ResourcePacksMenu';
import { ScreenStack } from '../ui/Screens';
import { type OptionsNav, languageScreen, optionsScreen } from '../ui/SettingsMenu';
import { KB, keyDisplayName, resolveKeybinds } from './Keybinds';
import { SurvivalInventory } from '../ui/SurvivalInventory';
import { WorkerPool } from '../workers/WorkerPool';
import { BLOCK, SOLID, getBlockDef } from '../world/BlockRegistry';
import { packState } from '../world/BlockStates';
import { pointInLiquid } from '../world/Liquids';
import { CHUNK_VOLUME, blockIndex, chunkKey } from '../world/constants';
import { hashString } from '../world/Noise';
import { BIOME_NAMES } from '../world/TerrainGenerator';
import { ARENA_FLOOR_Y, DEFAULT_MAP, type MapId, getMap, parseMapId } from '../modes/maps';
import { GEN_VERSION_CURRENT, normalizeGenVersion } from '../world/GenVersion';
import { type WorldType, arenaWorldType } from '../world/WorldGenerator';
import { createRayHit, raycast } from '../world/Raycast';
import { findStandingSpot } from '../world/Spawn';
import { World } from '../world/World';
import type { ArcadeFrame, ArcadeSession } from './ArcadeSession';
import { AudioEngine } from './Audio';
import { CameraController } from './Camera';
import { Input } from './Input';
import { type StationKind } from './Interaction';
import { Progression } from './Progression';
import { encodeData as encodeItemData } from '../items/ItemRegistry';
import { hasEnchants, powerBonus, punchKnockback } from '../items/EnchantRules';
import type { ContainerView } from '../ui/SurvivalInventory';
import { Interaction } from './Interaction';
import { ContainerScreens } from './ContainerScreens';
import { Renderer } from './Renderer';
import { WorldRules } from './WorldRules';
import { blocksFromDirection } from '../player/Melee';
import { gameRulesScreen } from '../ui/GameRulesScreen';
import type { Difficulty } from '../world/Difficulty';
import { WeatherSystem } from './WeatherSystem';
import { DynamicResolution, MIN_ADAPTIVE_DISTANCE, suggestPreset } from './AdaptiveQuality';
import { MAX_FPS_UNLIMITED, type Settings, SettingsStore } from './Settings';
import { applyAccessibilityDocument, effectiveParticles, limitFlash, mobSoundLabel, paletteFor } from './Accessibility';
import { GamepadController, type PadContext, cleanName } from './Gamepad';
import { latchPress, needsAutoJump } from './InputMath';
import { TouchControls, type TouchContext } from './TouchControls';
import { announce, clearAnnouncement } from '../ui/Announcer';
import { MenuNav } from '../ui/MenuNav';
import { Subtitles } from '../ui/Subtitles';
import { setSurvivalColorBlind } from '../ui/SurvivalHud';
import { detectLanguage, type I18nKey, setLanguage, t } from '../ui/i18n';
import { realmsModeName } from '../ui/RealmsMenu';
import { StatTracker } from '../player/StatTracker';
import { LOCAL_COMMAND_USAGE, SERVER_COMMAND_USAGE } from '../ui/chatLogic';

type GameState = 'menu' | 'loading' | 'playing' | 'paused' | 'inventory' | 'dead' | 'chat';

const DEFAULT_HOTBAR = [
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS,
  BLOCK.OAK_LOG, BLOCK.GLASS, BLOCK.TORCH, BLOCK.GLOWSTONE,
];
const MENU_SEED = hashString('BunkCraft');
/** Arena maps that fly by behind the home screen, one per visit in turn (the best-looking from above). */
const MENU_MAPS: MapId[] = ['atomic', 'dockyard', 'villa', 'town', 'yacht', 'plaza', 'carrier', 'suburb'];
const MENU_MAP_KEY = 'bunkcraft.menuMap';

/** The next background map (rotates per visit; `?menuMap=id` picks one, for screenshots). */
function nextMenuMap(): MapId {
  const forced = parseMapId(new URLSearchParams(location.search).get('menuMap'));
  if (forced) return forced;
  try {
    const i = (Number(localStorage.getItem(MENU_MAP_KEY)) + 1) % MENU_MAPS.length || 0;
    localStorage.setItem(MENU_MAP_KEY, String(i));
    return MENU_MAPS[i];
  } catch {
    return MENU_MAPS[0];
  }
}
const AUTOSAVE_INTERVAL = 30;
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
  private playerSounds!: PlayerSounds;
  private mobSteps!: MobSteps;
  private audioProbe!: WorldAudioProbe;
  private readonly save = new SaveSystem();
  private readonly pool: WorkerPool;
  private readonly cycle = new DayCycle();
  /** Weather: simulation (singleplayer) or server follower (multiplayer), rendering inputs and lightning. */
  private readonly weatherSys: WeatherSystem;
  /** Difficulty, game rules, respawn point and sleeping (WorldRules.ts). */
  private readonly worldRules: WorldRules;
  readonly player = new Player();
  private readonly stats = new PlayerStats();
  private readonly advancements = new AdvancementTracker();
  private readonly toasts: AdvancementToasts;
  private readonly playerInventory = new PlayerInventory();
  private readonly icons: BlockIcons;
  private readonly hotbar: Hotbar;
  private readonly hud: HUD;
  private readonly inventory: Inventory;
  private readonly survivalInventory: SurvivalInventory;
  /** Chest and furnace screens (singleplayer block entities or the server's containers). */
  private readonly containers: ContainerScreens;
  /** Experience handed out by a furnace (the XP system hooks in here; amount in points). */
  onFurnaceXp: ((amount: number) => void) | null = null;
  private readonly hand: HandRenderer;
  private readonly mobRenderer: MobRenderer;
  private readonly itemRenderer: ItemRenderer;
  private readonly tntRenderer: TntRenderer;
  private readonly fallingRenderer: FallingBlockRenderer;
  private netFalling: NetFalling | null = null;
  private static readonly NO_FALLING: FallingBlock[] = [];
  private readonly arrowRenderer: ArrowRenderer;
  /** Experience, orbs, armor enchantments and the enchanting screens. */
  private readonly progression: Progression;
  private readonly tmpDir = new THREE.Vector3();
  private readonly debug = new DebugOverlay();
  private readonly remote = new RemotePlayers();
  private readonly chat = new Chat();
  private readonly subtitles = new Subtitles();
  private readonly touch: TouchControls;
  private readonly pad: GamepadController;
  private readonly menuNav: MenuNav;
  private readonly touchCtx: TouchContext = { playing: false, arcade: false, chat: false, overlay: false };
  private readonly padCtx: PadContext = { state: 'menu', playing: false, arcade: false };
  /** Was the player walking forward last frame (releases a toggled sprint when they stop). */
  private wasMovingForward = false;
  /** Arcade: slides seen so far and the physics step of the latest start (the `sl` field of `pos`). */
  private slidesSeen = 0;
  private slideStep = NaN;
  private padsSeen = 0;
  private readonly solidAt = (x: number, y: number, z: number): boolean => !!SOLID[this.getBlock(x, y, z)];
  /** Feedback channels for the arcade session: captions and controller rumble. */
  private readonly feedback = {
    caption: (label: string, x: number, z: number) => this.caption(label, x, z),
    haptic: (strong: number, weak: number, ms: number) => this.pad.rumble(strong, weak, ms),
  };
  /** Mobs plus remote players, handed to the mob renderer each frame. */
  private readonly renderMobs: Mob[] = [];
  /** Multiplayer connection (null in singleplayer). */
  private net: NetClient | null = null;
  /** Arcade game types (team deathmatch, free for all): match state, weapons and HUD; null in the Minecraft sandbox. */
  private arcade: ArcadeSession | null = null;
  /** The arcade client (HUD, weapons, viewmodels) is a separate chunk: singleplayer never downloads it. */
  private arcadeModule: typeof import('./ArcadeSession') | null = null;
  private readonly root: HTMLElement;
  private arcadeHint = '';
  /** Reused every frame (no allocations in the frame loop). */
  private readonly arcadeFrame: ArcadeFrame = { now: 0, dt: 0, controls: false, bobPhase: 0, bobStrength: 0, light: 1, aspect: 1, lookX: 0, lookY: 0 };
  /** Development: runs once when the world has loaded (arcade preview builds its arena here). */
  private afterLoad: (() => void) | null = null;
  /** Development: the in-browser stand-in for the arcade server. */
  private previewServer: { update(dt: number, p: Player): void } | null = null;
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
  /** F2: save the next rendered frame as a PNG. */
  private wantScreenshot = false;
  private packCredit = 'Procedural textures';
  private score = 0;

  private last = 0;
  private frameDt = 0;
  /** Statistics screen counters (saved in WorldMeta.statistics). */
  readonly statTracker = new StatTracker();
  private statLast: { x: number; z: number; ground: boolean } | null = null;
  /** Frame limiter (Options > Max Framerate); 0 = unlimited. */
  private minFrameMs = 0;
  private time = 0;
  private accumulator = 0;
  private stepCount = 0;
  private autosave = 0;
  private menuOrbit = new THREE.Vector3();
  /** The arena map behind the home screen and the radii of the camera's loop over it. */
  private menuMap: MapId = MENU_MAPS[0];
  private readonly menuRadius = new THREE.Vector2();

  private readonly move: MoveInput = { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };
  /** Bound once: avoids allocating a closure per frame for physics. */
  private readonly getBlock = (x: number, y: number, z: number): number => this.world ? this.world.getBlock(x, y, z) : BLOCK.UNLOADED;
  private readonly getMeta = (x: number, y: number, z: number): number => this.world ? this.world.getMeta(x, y, z) : 0;
  private underwater = false;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private gpuName = '';
  /** Code of the hosted game we are in (null in singleplayer or on the main world). */
  private roomCode: string | null = null;
  /** Arcade: the map of the arena world being built (a MapId; the welcome message announces it). */
  private arenaMap: string = DEFAULT_MAP;
  /** How this multiplayer session was joined, to reconnect when the server rotates to another map. */
  private lastJoin: { name: string; address: string; room?: string; arena: boolean; windowMs: number } | null = null;
  /** Mirror of the server's mobs, items, arrows and TNT while in multiplayer. */
  private netEntities: NetEntities | null = null;
  private contextLost: HTMLDivElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    const canvas = root.querySelector<HTMLCanvasElement>('#game')!;
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    // Leave cores for the main thread and the browser GPU process (smoother frame pacing).
    this.pool = new WorkerPool(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
    this.icons = new BlockIcons(this.renderer.textures);
    this.hotbar = new Hotbar(this.icons, this.playerInventory);
    this.hud = new HUD(this.hotbar);
    this.toasts = new AdvancementToasts(this.icons);
    this.advancements.onAward = (def) => {
      if (!showsToast(def)) return;
      this.toasts.push(def);
      this.audio.playAdvancement();
    };
    this.inventory = new Inventory(this.icons, this.hotbar);
    this.survivalInventory = new SurvivalInventory(this.icons, this.playerInventory, {
      drop: (s) => this.throwStack(s),
      close: () => void this.resumeGame(),
    });
    this.containers = new ContainerScreens({
      world: () => this.world,
      net: () => this.net,
      inventory: this.playerInventory,
      show: (view) => {
        if (this.state !== 'playing') return;
        this.state = 'inventory';
        this.suppressPause = this.input.locked;
        this.input.exitLock();
        this.survivalInventory.open(this.nearbyStations(), view);
      },
      current: () => this.survivalInventory.container,
      cursor: () => this.survivalInventory.cursorStack,
      setCursor: (s) => this.survivalInventory.setCursor(s),
      refresh: () => this.survivalInventory.refreshBox(),
      close: () => { if (this.state === 'inventory') void this.resumeGame(); },
      message: (text) => this.chat.add(text, true),
      drop: (s) => this.throwStack(s),
      awardXp: (amount) => this.onFurnaceXp?.(amount),
    });
    this.playerInventory.onAdd = (id) => this.advancements.onItemGained(id);
    // A tool or armor piece wore out: without a cue it silently vanishes from the hand (Minecraft: item break sound).
    this.playerInventory.onBreak = () => this.audio.play('break', 'wood');
    this.playerInventory.onChange = () => {
      this.hotbar.refresh();
      this.survivalInventory.refresh();
      const armor = this.playerInventory.armorTotals();
      this.stats.armorPoints = armor.points;
      this.stats.armorToughness = armor.toughness;
      this.progression?.onArmorChanged();
    };
    this.stats.onArmorHit = (wear) => void this.playerInventory.wearArmor(wear);
    // Shield: a raised shield blocks hits from a 100 degree arc in front (mob and explosion yaw points from the source to
    // the player, arrow yaw back along the flight, towards the shooter).
    this.stats.blocker = (src, amount) => {
      const it = this.interaction;
      if (!it?.blocking || src.yaw === undefined) return false;
      const s = Math.sin(src.yaw), c = Math.cos(src.yaw);
      const p = this.player;
      const tx = src.kind === 'arrow' ? s : -s, tz = src.kind === 'arrow' ? c : -c;
      if (!blocksFromDirection(p.yaw, p.x + tx, p.z + tz, p.x, p.z)) return false;
      it.onShieldBlock(amount);
      return true;
    };
    this.stack = new ScreenStack(root.querySelector<HTMLElement>('#screens')!);
    root.append(this.toasts.el, this.remote.el, this.chat.el, this.hud.el, this.debug.el, this.inventory.el, this.survivalInventory.el);
    this.weatherSys = new WeatherSystem({
      cycle: this.cycle, renderer: this.renderer, audio: this.audio, player: this.player, stats: this.stats,
      world: () => this.world, mode: () => this.mode, entities: () => this.entities,
      multiplayer: () => this.net !== null, arcade: () => this.arcade !== null || this.meta?.worldType === 'arena',
    });
    this.worldRules = new WorldRules({
      stats: this.stats, player: this.player, cycle: this.cycle, input: this.input, overlayParent: this.hud.el,
      world: () => this.world, entities: () => this.entities, meta: () => this.meta, net: () => this.net, mode: () => this.mode,
      weather: () => this.weatherSys.weather, chat: (line) => this.chat.add(line, true),
    });
    this.chat.onSend = (text) => {
      // /enchant and /xp change only this player's items and bar: handled here, also on a server.
      const own = text.startsWith('/') ? this.progression.command(text) : null;
      if (own) {
        for (const line of own) this.chat.add(line, true);
        return;
      }
      if (this.net) return this.net.sendChat(text);
      // Singleplayer has no server: messages are echoed and the slash commands run locally (with Allow Cheats).
      if (!text.startsWith('/')) return this.chat.add(`<Player> ${text}`);
      if (!this.meta || !cheatsAllowed(this.meta)) return this.chat.add(t('chat.noCheats'), true);
      const lines = this.weatherSys.localCommand(text) ?? this.worldRules.localCommand(text) ?? [`Unknown command: ${text.split(/\s+/)[0]}. Type /help for help.`];
      for (const line of lines) this.chat.add(line, true);
    };
    this.chat.onClose = () => {
      if (this.state === 'chat') void this.resumeGame();
    };

    // Entities and the first-person hand.
    this.hand = new HandRenderer(this.renderer.uniforms, this.icons);
    this.mobRenderer = new MobRenderer(this.renderer.uniforms);
    this.itemRenderer = new ItemRenderer(this.renderer.uniforms, this.icons);
    this.tntRenderer = new TntRenderer(this.renderer.uniforms);
    this.arrowRenderer = new ArrowRenderer(this.renderer.uniforms);
    this.progression = new Progression({
      stats: this.stats, inventory: this.playerInventory, hotbar: this.hotbar, player: this.player, audio: this.audio,
      uniforms: this.renderer.uniforms, world: () => this.world, entities: () => this.entities, mode: () => this.mode,
      openView: (view) => this.openStationView(view), multiplayer: () => this.net !== null,
      rules: () => ({ keepInventory: !!this.worldRules?.rules.get('keepInventory') }),
    });
    this.renderer.scene.add(this.mobRenderer.group, this.itemRenderer.mesh, this.tntRenderer.mesh, this.arrowRenderer.mesh, this.progression.orbRenderer.mesh);
    this.renderer.shadowExcluded.push(this.progression.orbRenderer.mesh);
    // Furnace experience (taking the output) falls as orbs at the player, like Minecraft.
    this.onFurnaceXp = (amount) => {
      const p = this.player;
      if (amount > 0) this.entities?.spawnXp(p.x, p.y + 0.5, p.z, amount);
    };
    this.fallingRenderer = new FallingBlockRenderer(this.renderer.uniforms);
    this.renderer.scene.add(this.fallingRenderer.mesh);
    this.renderer.shadowExcluded.push(this.fallingRenderer.mesh);
    this.renderer.scene.add(this.remote.weapons);
    this.renderer.shadowExcluded.push(this.mobRenderer.group, this.itemRenderer.mesh, this.tntRenderer.mesh, this.arrowRenderer.mesh, this.remote.weapons);
    this.renderer.afterMain = (three) => {
      if (this.state === 'playing' || this.state === 'inventory' || this.state === 'paused' || this.state === 'chat') {
        if (this.arcade) this.arcade.render(three);
        else this.hand.render(three);
      }
    };

    this.menu = new MainMenu(this.stack, {
      listWorlds: () => this.save.listWorlds(),
      playWorld: (m) => void this.enterWorld(m),
      createWorld: (name, seed, mode, extra) => void this.createWorld(name, seed, mode, extra),
      openLanguage: () => this.pushShell(languageScreen(this.settings, { ...this.optionsNav(), languageChanged: () => this.menu.showTitle() })),
      backgroundMap: () => getMap(this.menuMap).name,
      tipKeys: () => this.tipKeys(),
      deleteWorld: (id) => this.save.deleteWorld(id),
      saveWorld: (meta) => this.save.saveWorld(meta),
      transfer: new WorldTransfer(this.save),
      openOptions: () => this.openOptions(),
      joinServer: (name, address, room, arena) => void this.joinServer(name, address, room, arena),
      defaultWorldIcon: () => this.icons.get(BLOCK.GRASS),
    });

    this.inventory.onClose = () => void this.resumeGame();
    this.inventory.onSurvival = () => {
      this.inventory.close();
      this.survivalInventory.open(this.nearbyStations());
    };
    this.stats.onHurt = () => {
      this.audio.playHurt();
      this.pad.rumble(0.7, 0.5, 200);
    };
    this.initAudioHooks();
    this.input.onKeyDown = (code) => this.onKey(code);
    // Touch, gamepad and keyboard menus: virtual presses go through the same shortcuts as keys.
    this.input.onAction = (action) => this.onKey(`Virtual${action}`);
    this.touch = new TouchControls(root, this.input, this.hotbar);
    this.touch.onPause = () => this.input.exitLock();
    this.touch.onClose = () => this.padBack();
    this.touch.onModeChange = () => applyGuiScale(this.settings.values.guiScale);
    this.menuNav = new MenuNav(() => this.stack.top, () => this.settings.values.menuRepeatDelay);
    this.menuNav.attachKeyboard();
    this.pad = new GamepadController(this.input, this.settings.values, this.menuNav, {
      start: () => this.padStart(),
      back: () => this.padBack(),
      onConnection: (name, connected) => announce(connected ? `Controller connected: ${name}` : 'Controller disconnected', true),
    });
    root.append(this.subtitles.el);
    // Screen readers: chat and advancement toasts are live regions, the canvas has a name.
    this.chat.el.setAttribute('aria-live', 'polite');
    this.toasts.el.setAttribute('aria-live', 'polite');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'BunkCraft game view');
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
    this.audio.installGestureUnlock();

    const gl = this.renderer.three.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
    if (this.settings.fresh) {
      this.settings.set('language', detectLanguage());
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
    this.precompileShaders();
    // An invite link (?join=CODE) goes straight to the join screen with the code filled in.
    const invited = normalizeCode(new URLSearchParams(location.search).get('join') ?? '');
    const partyInvite = normalizePartyCode(new URLSearchParams(location.search).get('party') ?? '');
    if (invited) void this.menu.openInvite(invited);
    else if (partyInvite) this.menu.openPartyInvite(partyInvite);
    // A share link (?seed=…&mode=…) opens Create World prefilled.
    else {
      const share = parseShareParams(location.search);
      if (share) void this.menu.showWorlds().then(() => this.menu.showCreate(share));
    }
    initKeyboardLock();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- settings

  private openOptions(): void {
    this.pushShell(optionsScreen(this.settings, this.optionsNav()));
  }

  /** Settings and the arena's menus wear the shell look (docs/research/IDENTITY.md); the survival menus keep theirs. */
  private pushShell(el: HTMLElement): void {
    el.classList.add('bc');
    this.stack.push(el);
  }

  private optionsNav(): OptionsNav {
    return {
      push: (el) => this.pushShell(el),
      pop: () => this.stack.pop(),
      openResourcePacks: () => this.openResourcePacks(),
      padName: () => (this.pad.connected ? cleanName(this.pad.name) : ''),
      credits: () => [
        VERSION,
        `Textures: ${this.packCredit}`,
        'Font: Minecraft-Font by Idrees Hassan — SIL Open Font License 1.1',
        'Rendering: three.js (MIT License)',
        'Terrain, mobs, sounds, music, sky and procedural textures: generated in code',
        'Not affiliated with Mojang or Microsoft',
      ],
      languageChanged: () => {
        // Rebuild what sits below Options (title or pause menu) in the new language, then reopen Options.
        if (this.state === 'menu') this.menu.showTitle();
        else this.showPauseMenu();
        this.openOptions();
      },
    };
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
        const files = await bundledResolver(builtin);
        try {
          images = await loadPack(builtin.layout, files.resolve, 16);
        } finally {
          files.dispose();
        }
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
    this.applyAccessibility(s, key);
    this.dynamicResolution.enabled = s.dynamicResolution;
    this.dynamicResolution.maxDistanceDrop = Math.max(0, s.renderDistance - MIN_ADAPTIVE_DISTANCE);
    if (!s.dynamicResolution) this.renderer.setDynamicScale(1);
    this.updateMenuBlur();
    this.cam.baseFov = s.fov;
    this.cam.viewBobbing = s.viewBobbing && !s.reducedMotion;
    setLanguage(s.language);
    if (key === 'language') this.arcade?.relabel();
    this.chat.applySettings(s);
    this.hud.setAttackIndicator(s.attackIndicator);
    this.input.rawInput = s.rawInput;
    this.mobRenderer.distanceScale = s.entityDistance / 100;
    this.minFrameMs = s.maxFps >= MAX_FPS_UNLIMITED ? 0 : 1000 / s.maxFps;
    if (!key || key === 'keybinds') {
      this.input.setBindings(resolveKeybinds(s.keybinds));
      this.arcade?.setBindings(this.input);
    }
    const master = s.masterVolume / 100;
    this.audio.setVolumes(s.soundVolume * master, s.musicVolume * master, s.ambientVolume * master, s.uiVolume * master);
    this.audio.setSpatialMode(s.spatialAudio);
    applyGuiScale(s.guiScale);
    if (this.world) {
      this.applyRenderDistance();
      const fancy = s.graphics === 'fancy';
      if (key === 'graphics' && this.world.chunks.fancyLeaves !== fancy) {
        this.world.chunks.fancyLeaves = fancy;
        this.world.chunks.remeshAll();
      }
    }
  }

  /** The user's render distance minus what the adaptive governor took away; fog and streaming follow it. */
  private applyRenderDistance(): void {
    const user = this.settings.values.renderDistance;
    const rd = this.state === 'menu' ? Math.min(user, 6) : Math.max(1, user - this.dynamicResolution.distanceDrop);
    if (this.state !== 'menu') this.renderer.setRenderDistance(rd);
    if (this.world) {
      this.world.chunks.renderDistance = rd;
      this.world.chunks.markDirty();
    }
  }

  /** Accessibility, touch and controller options that act outside the renderer. */
  private applyAccessibility(s: Settings, key?: string): void {
    const input = this.input;
    if (!key || key === 'touchControls') input.applyTouchSetting(s.touchControls);
    input.setToggle(KB.SNEAK, s.toggleSneak);
    input.setToggle(KB.SPRINT, s.toggleSprint);
    input.setToggle(KB.ATTACK, s.toggleAttack);
    input.setToggle(KB.USE, s.toggleUse);
    this.cam.reducedMotion = s.reducedMotion;
    this.cam.fovEffects = s.fovEffects / 100;
    this.renderer.particles.density = { all: 1, decreased: 0.5, minimal: 0.25 }[effectiveParticles(s)];
    if (s.reducedMotion) this.renderer.uniforms.uSway.value = 0;
    applyAccessibilityDocument(s);
    this.subtitles.setEnabled(s.subtitles);
    skinPrefs.setShowCustom(s.showCustomSkins);
    if (this.arcade) {
      this.arcade.hud.damageNumbers = s.damageNumbers;
      this.arcade.setAimSettings(s);
    }
    const palette = paletteFor(s.colorBlindSafe);
    TEAM_COLORS.red = palette.teamA;
    TEAM_COLORS.blue = palette.teamB;
    setSurvivalColorBlind(s.colorBlindSafe);
    this.touch.applySettings(s);
    this.pad.applySettings(s);
  }

  /** Sound caption with a direction arrow (Subtitles option); x/z are the sound's world position. */
  private caption(label: string, x?: number, z?: number): void {
    if (!this.subtitles.enabled) return;
    const p = this.player;
    this.subtitles.push(label, x === undefined ? 0 : x - p.x, z === undefined ? 0 : z - p.z, p.yaw);
  }

  /** Start button: pause in the world, resume from the pause screen or an overlay. */
  private padStart(): void {
    if (this.state === 'playing' && this.input.locked) this.input.exitLock();
    else if (this.state === 'inventory' || this.state === 'chat' || (this.state === 'paused' && this.stack.depth === 1)) void this.resumeGame();
  }

  /** B button: one screen back, or back to the game. */
  private padBack(): void {
    if ((this.state === 'paused' || this.state === 'menu') && this.stack.depth > 1) this.stack.pop();
    else if (this.state === 'paused' || this.state === 'inventory') void this.resumeGame();
    else if (this.state === 'chat') this.chat.close();
  }

  /** Menu backdrop blur only when the GPU has headroom (Fancy, full dynamic resolution). */
  /** Movement sounds, mob footsteps, ambience probe, occlusion and interface sounds. */
  private initAudioHooks(): void {
    const solid = (x: number, y: number, z: number): boolean => {
      const id = this.getBlock(x, y, z);
      return id !== BLOCK.UNLOADED && SOLID[id] === 1;
    };
    const surface = surfaceLookup(this.getBlock);
    this.playerSounds = new PlayerSounds(this.audio, surface);
    this.mobSteps = new MobSteps(this.audio, surface);
    this.audioProbe = new WorldAudioProbe({
      getBlock: this.getBlock,
      getMeta: this.getMeta,
      getLight: (x, y, z) => (this.world ? this.world.getLight(x, y, z) : 0xf0),
      biomeAt: (x, z) => (this.world ? this.world.biomeName(x, z) : 2),
    }, solid, { water: BLOCK.WATER, lava: BLOCK.LAVA });
    this.audio.setOcclusionProbe(this.audioProbe.occlusion);
    bindUiSounds(this.root, (name) => this.audio.playUi(name));
  }

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
    this.advancements.enabled = survival && !this.net;
    this.hand.visible = mode !== 'spectator';
    if (this.meta) this.meta.gameMode = mode;
  }

  // ---------------------------------------------------------------- world lifecycle

  private createWorldInstance(seed: number, edits?: Map<number, Map<number, number>>, worldType: WorldType = 'terrain', genVersion = GEN_VERSION_CURRENT): World {
    this.world?.dispose();
    const world = new World(seed, this.pool, { opaque: this.renderer.chunkMaterial, cutout: this.renderer.cutoutMaterial, water: this.renderer.waterMaterial }, edits, worldType, genVersion);
    world.chunks.fancyLeaves = this.settings.values.graphics === 'fancy';
    world.chunks.renderDistance = this.settings.values.renderDistance;
    this.world = world;
    this.renderer.attachWorld(world);
    // Entities live with the world.
    const entities = new EntityManager(world, seed);
    entities.griefing = () => !!this.worldRules.rules.get('mobGriefing');
    world.onChunkReady = (c) => entities.onChunkReady(c);
    world.onChunkUnloaded = (k) => entities.onChunkUnloaded(k);
    this.entities = entities;
    // Chests and furnaces: singleplayer owns them; on a server the server does and this store stays empty.
    world.blockEntities.enabled = !this.net;
    world.blockEntities.onDrops = (x, y, z, stacks) => {
      if (!hasSurvivalRules(this.mode)) return;
      for (const st of stacks) entities.dropItem(st, x + 0.5, y + 0.5, z + 0.5, 10, undefined, true);
    };
    world.blockEntities.onXpAwarded = (amount) => this.onFurnaceXp?.(amount);
    // Water and lava flow in singleplayer; on a server the server simulates and sends the changes.
    if (!this.net) {
      const sim = world.enableLiquids();
      sim.onDestroyed = (x, y, z, id) => {
        // Plants and torches washed away drop themselves (survival).
        if (!hasSurvivalRules(this.mode)) return;
        for (const drop of blockDrops(id, 0)) entities.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
      };
      // Plants grow, leaves decay and sand falls (random ticks and block updates); what they break drops as items.
      world.enableGrowth();
      world.skyDarkness = () => Math.round((1 - this.cycle.dayFactor) * 11 + this.weatherSys.weather.skyDarkness);
      world.rainingAt = (x, y, z) => {
        const q = this.weatherSys.worldQuery;
        return !!q && this.weatherSys.weather.isRainingAt(q, x, y, z);
      };
      world.onBlockDrop = (id, meta, x, y, z) => {
        if (!hasSurvivalRules(this.mode)) return;
        for (const drop of blockDrops(id, 0, meta)) entities.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
      };
      sim.onFizz = (x, y, z) => {
        const p = this.player;
        this.audio.playFizz(Math.max(0, 1 - Math.hypot(x - p.x, y - p.y, z - p.z) / 20));
      };
    }
    // Redstone: simulated here in singleplayer (not in arenas); in multiplayer the server's changes arrive as edits.
    if (!this.net && worldType === 'terrain') {
      enableRedstone(world, { entities, player: this.player, survival: () => hasSurvivalRules(this.mode) });
    }
    world.onRedstoneChange = (x, y, z, prevId, prevMeta, id, meta) => redstoneSound(this.audio, world, x, y, z, prevId, prevMeta, id, meta);
    this.interaction = new Interaction({
      world, player: this.player, stats: this.stats, inventory: this.playerInventory, hotbar: this.hotbar,
      entities, renderer: this.renderer, hand: this.hand, audio: this.audio, camera: this.cam.camera,
      attackRemote: (id, data) => this.net?.sendAttack(id, encodeItemData(data)),
      onStat: (key) => this.statTracker.add(key),
      igniteTnt: (x, y, z) => {
        if (this.net) {
          // The server validates, removes the block and simulates the fuse.
          this.net.sendIgnite(x, y, z);
          return true;
        }
        if (!world.setBlock(x, y, z, BLOCK.AIR)) return false;
        entities.primeTnt(x, y, z);
        return true;
      },
      openStation: (kind, x, y, z) => this.openStation(kind, x, y, z),
      openContainer: (x, y, z) => this.containers.open(x, y, z),
      useBed: (x, y, z) => this.useBed(x, y, z),
      useMob: (mob) => this.useMob(mob),
      boneMeal: (x, y, z) => {
        // Multiplayer: the server grows it (and broadcasts the blocks); the item is used up here right away.
        if (this.net) { this.net.sendBoneMeal(x, y, z); return true; }
        const ticker = world.randomTicker;
        if (!ticker) return false;
        let used = false;
        world.batch(() => { used = useBoneMeal(ticker, x, y, z); });
        return used;
      },
      shootArrow: (power, pickup, ench) => {
        const cam = this.cam.camera;
        const dir = cam.getWorldDirection(this.tmpDir);
        if (this.net) {
          this.net.sendShoot(cam.position.x, cam.position.y - 0.1, cam.position.z, dir.x, dir.y, dir.z, power,
            encodeItemData(this.hotbar.selectedStack.data));
          return;
        }
        // Player bow: speed 3 × power blocks/tick, inaccuracy 1, critical at full draw.
        const arrow = entities.shootArrow(cam.position.x, cam.position.y - 0.1, cam.position.z, dir.x, dir.y, dir.z,
          power * 3, 1, null, true, power >= 1, pickup);
        if (arrow && ench) {
          arrow.powerBonus = powerBonus(ench.power);
          arrow.punch = punchKnockback(ench.punch);
          arrow.flame = ench.flame > 0;
        }
      },
    });
    return world;
  }

  private enterMenu(): void {
    this.stopArcade();
    this.state = 'menu';
    this.chat.close();
    this.chat.setVisible(false);
    this.meta = null;
    this.weatherSys.stop();
    this.hud.setVisible(false);
    this.inventory.close();
    this.survivalInventory.close();
    // The home screen flies over an arena map: the game it opens on.
    this.menuMap = nextMenuMap();
    const map = getMap(this.menuMap);
    const world = this.createWorldInstance(MENU_SEED, undefined, arenaWorldType(this.menuMap));
    world.chunks.renderDistance = Math.min(this.settings.values.renderDistance, 6);
    this.entities!.hostileSpawning = false;
    const b = map.bounds;
    this.menuOrbit.set((b.minX + b.maxX) / 2, ARENA_FLOOR_Y + map.wallHeight + 9, (b.minZ + b.maxZ) / 2);
    this.menuRadius.set((b.maxX - b.minX) * 0.32, (b.maxZ - b.minZ) * 0.32);
    this.cycle.time = 0.11;
    this.menu.showTitle();
  }

  /** Key names for the loading tips (the player's own bindings). */
  private tipKeys(): Record<string, string> {
    const key = (kb: number) => keyDisplayName(this.input.bound(kb));
    return { inventory: key(KB.INVENTORY), chat: key(KB.CHAT), command: key(KB.COMMAND), sprint: key(KB.SPRINT), drop: key(KB.DROP) };
  }

  private async createWorld(name: string, seedText: string, mode: GameMode, extra?: { difficulty: Difficulty; rules?: Record<string, boolean | number>; cheats?: boolean }): Promise<void> {
    let seed: number;
    if (!seedText) seed = (Math.random() * 4294967296) >>> 0;
    else if (/^-?\d+$/.test(seedText)) seed = Number(BigInt.asUintN(32, BigInt(seedText)));
    else seed = hashString(seedText);
    const meta: WorldMeta = {
      id: newWorldId(), name, seed, seedText: seedText || String(seed),
      created: Date.now(), lastPlayed: Date.now(), player: null, genVersion: GEN_VERSION_CURRENT,
      hotbar: [...DEFAULT_HOTBAR], selectedSlot: 0, time: 0.08, gameMode: mode,
      difficulty: extra?.difficulty, rules: extra?.rules,
      ...(extra?.cheats === undefined ? {} : { cheats: extra.cheats }),
    };
    await this.save.saveWorld(meta);
    await this.enterWorld(meta);
  }

  private async enterWorld(meta: WorldMeta): Promise<void> {
    this.audio.unlock();
    this.loadingProgress = this.menu.showLoading(t('loading.world'));
    this.loadingProgress(t('loading.reading'), 0);
    const edits = await this.save.loadEdits(meta.id);
    this.startSession(meta, edits);
  }

  /** Common world setup for singleplayer saves and multiplayer servers. */
  private startSession(meta: WorldMeta, edits: Map<number, Map<number, number>>): void {
    this.meta = meta;
    const worldType: WorldType | undefined = meta.worldType === 'arena' ? arenaWorldType(parseMapId(this.arenaMap) ?? DEFAULT_MAP) : meta.worldType;
    const world = this.createWorldInstance(meta.seed, edits, worldType, normalizeGenVersion(meta.genVersion));
    this.cycle.time = meta.time;
    this.weatherSys.start(meta, this.net !== null);
    world.blockEntities.load(meta.blockEntities);
    const mode = meta.gameMode ?? 'creative';
    // Inventory: saved stacks, else creative gets the default hotbar and survival starts empty.
    if (meta.inventory) this.playerInventory.load(meta.inventory);
    else {
      this.playerInventory.clear();
      if (!hasSurvivalRules(mode)) meta.hotbar.forEach((id, i) => this.playerInventory.set(i, { id, count: id ? 1 : 0 }));
    }
    this.stats.load(meta.stats);
    this.stats.effects.load(meta.effects, this.stats);
    this.worldRules.load(meta);
    this.advancements.load(meta.advancements);
    this.statTracker.load(meta.statistics);
    this.statLast = null;
    if (!this.net) {
      this.chat.clear();
      this.chat.setCommands(LOCAL_COMMAND_USAGE);
      this.chat.setVisible(true);
    }
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

  /**
   * Compiles every world, entity and hand shader while the title screen is up. Otherwise the
   * first frames in a world stall on the GPU driver (mob, item, arrow, TNT and hand shaders are
   * first used there), which showed up as a ~250 ms hitch when entering a world.
   */
  private precompileShaders(): void {
    const three = this.renderer.three;
    const hidden: THREE.Object3D[] = [];
    this.renderer.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    // compileAsync starts every compile synchronously (then waits with KHR_parallel_shader_compile),
    // so the hidden objects only need to be visible during the call itself.
    const compiling = Promise.all([three.compileAsync(this.renderer.scene, this.cam.camera), this.hand.precompile(three)]);
    for (const o of hidden) o.visible = false;
    compiling.catch((e: unknown) => console.warn('Shader precompile failed', e));
  }

  private finishLoading(): void {
    const world = this.world!;
    if (this.worldRules.pendingBed) {
      // Respawn at the bed: next to it, or back to the world spawn when it is gone or blocked.
      const spot = this.worldRules.resolveBedRespawn();
      if (spot) {
        this.player.setPosition(spot.x, spot.y, spot.z);
        this.needsSurface = false;
      } else {
        const s = this.meta?.spawn ?? { ...world.findSpawn(), y: 100 };
        this.player.setPosition(s.x, s.y, s.z);
        this.needsSurface = true;
        this.state = 'loading';
        return;
      }
    }
    if (this.needsSurface) {
      // Stand on real ground near the spawn column, not on a tree canopy or in a lake (Minecraft looks for grass).
      const x = Math.floor(this.player.x), z = Math.floor(this.player.z);
      const spot = findStandingSpot((a, b, c) => world.getBlock(a, b, c), x, z);
      if (spot) this.player.setPosition(this.player.x + spot.x - x, spot.y, this.player.z + spot.z - z);
      else this.player.setPosition(this.player.x, world.surfaceY(x, z) + 1, this.player.z);
    }
    this.player.unstick((x, y, z) => world.getBlock(x, y, z), (x, y, z) => world.getMeta(x, y, z));
    if (this.meta && !this.meta.spawn) this.meta.spawn = { x: this.player.x, y: this.player.y, z: this.player.z };
    this.player.fallDistance = 0;
    this.player.landedFall = 0;
    this.loadingProgress = null;
    this.autosave = 0;
    this.advancements.onEnterWorld();
    const afterLoad = this.afterLoad;
    this.afterLoad = null;
    afterLoad?.();
    void this.resumeGame();
  }

  /**
   * @param thumbnail also refresh the world icon from the next frame. Reading the frame back stalls
   * the GPU, so autosaves skip it; pausing and quitting take it (like Minecraft's world screenshot).
   */
  private async saveGame(thumbnail = false): Promise<void> {
    const world = this.world, meta = this.meta;
    if (!world || !meta || this.state === 'loading' || this.state === 'menu' || this.arcade) return;
    // Items held on the inventory cursor go back into the inventory before saving.
    this.survivalInventory.flushCursor();
    if (this.net) {
      // Multiplayer: the server stores position, inventory and health per player.
      this.net.sendState(this.playerInventory.serialize(), this.stats.serialize(), this.stats.effects.serialize() ?? []);
      return;
    }
    const p = this.player;
    meta.player = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flying: p.flying };
    meta.hotbar = Array.from({ length: 9 }, (_, i) => this.playerInventory.get(i).id);
    meta.inventory = this.playerInventory.serialize();
    meta.blockEntities = world.blockEntities.serialize();
    delete meta.containers;
    meta.stats = this.stats.serialize();
    meta.effects = this.stats.effects.serialize();
    this.worldRules.save(meta);
    meta.advancements = this.advancements.serialize();
    meta.statistics = this.statTracker.serialize();
    meta.gameMode = this.mode;
    meta.selectedSlot = this.hotbar.selected;
    meta.time = this.cycle.time;
    this.weatherSys.save(meta);
    meta.lastPlayed = Date.now();
    if (thumbnail || !meta.icon) this.wantThumbnail = true;
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

  /** F2: the rendered 3D view (hand included, DOM HUD excluded) as a timestamped PNG download. */
  private captureScreenshot(): void {
    this.wantScreenshot = false;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `bunkcraft-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
    this.renderer.three.domElement.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, name);
      showToast(t('hud.screenshot', name));
    }, 'image/png');
  }

  /** Opens an enchanting table, anvil or grindstone (singleplayer and multiplayer: nothing is stored in the block). */
  private openStation(kind: StationKind, x: number, y: number, z: number): void {
    if (!this.world || this.state !== 'playing') return;
    this.progression.open(kind, x, y, z);
  }

  /** Shows a station's slots above the inventory, like a chest. */
  private openStationView(view: ContainerView): void {
    this.state = 'inventory';
    this.suppressPause = this.input.locked;
    this.input.exitLock();
    this.survivalInventory.open(this.nearbyStations(), view);
  }

  /** A bed sets the respawn point and sleeps at night (WorldRules: monsters, multiplayer sleeping rule). */
  private useBed(x: number, y: number, z: number): void {
    if (!this.meta || this.arcade) return;
    this.worldRules.useBed(x, y, z);
  }

  private async quitToTitle(): Promise<void> {
    window.clearTimeout(this.reconnectTimer);
    await this.saveGame(true);
    this.disconnect();
    this.input.exitLock();
    this.stack.clear();
    // Every way out ends on the home screen, which is also the arena hub (like a server list after a match).
    this.enterMenu();
  }

  // ---------------------------------------------------------------- multiplayer

  /** Pending automatic reconnect (after a server restart, a lost connection or a lag kick). */
  private reconnectTimer = 0;
  /** Why the last quiet join attempt failed, and whether trying again is pointless (the server answered and refused). */
  private joinFailure: { reason: string; fatal: boolean } | null = null;

  /**
   * The connection dropped (or the server asked us to come back): shows "Reconnecting" and tries again with growing
   * pauses until `windowMs` has passed. An arcade lobby keeps the player's seat meanwhile, so the retry lands in the
   * same match with score and class (the rejoin secret goes along in the hello, see net/Rejoin.ts).
   */
  private startReconnect(join: { name: string; address: string; room?: string; arena: boolean; windowMs: number }, reason: string, firstDelayMs: number): void {
    window.clearTimeout(this.reconnectTimer);
    const started = performance.now();
    let attempt = 0;
    const screen = this.menu.showReconnecting(reason, () => {
      window.clearTimeout(this.reconnectTimer);
      this.menu.showTitle();
    });
    const wait = (delay: number) => {
      this.reconnectTimer = window.setTimeout(() => {
        attempt++;
        screen.update(t('reconnect.attempt', attempt, Math.max(0, Math.round((join.windowMs - (performance.now() - started)) / 1000))));
        void this.joinServer(join.name, join.address, join.room, join.arena, true).then((ok) => {
          if (ok) return;
          const failure = this.joinFailure;
          if (failure?.fatal || performance.now() - started > join.windowMs) {
            if (join.room) clearTicket(join.room);
            this.menu.showDisconnected(failure?.reason ?? reason);
            return;
          }
          wait(backoffMs(attempt + 1));
        });
      }, delay);
    };
    wait(firstDelayMs);
  }

  /** `quiet`: a reconnect attempt: no loading screen until the server answers, and a failure is reported through `joinFailure`. */
  private async joinServer(name: string, address: string, room?: string, arena = false, quiet = false): Promise<boolean> {
    window.clearTimeout(this.reconnectTimer);
    this.audio.unlock();
    this.joinFailure = null;
    const fail = (e: unknown): false => {
      const reason = e instanceof Error ? e.message : String(e);
      this.joinFailure = { reason, fatal: e instanceof ConnectError && e.fatal };
      if (!quiet) this.menu.showDisconnected(reason);
      return false;
    };
    const loading = () => this.menu.showLoading(arena ? t('home.connecting') : 'Connecting to the server...', arena);
    let progress = quiet ? null : loading();
    progress?.('Logging in...', 0);
    // Load the arcade client first: the welcome may start a match, and messages arriving while a
    // module still loads would have no handler yet.
    try {
      await this.loadArcade();
    } catch (e) {
      return fail(e);
    }
    const net = new NetClient();
    let welcome;
    // Did the last visit to this lobby leave a rejoin secret? Then this login is a return, and the welcome says how it went.
    const returning = !!room && !!ticketToken(address.trim() || location.host, room);
    try {
      welcome = await net.connect(address, name, room);
    } catch (e) {
      return fail(e);
    }
    progress ??= loading();
    this.net = net;
    // Terrain comes from the seed; only the server's edit list is transferred.
    const edits = new Map<number, Map<number, number>>();
    const list = welcome.edits;
    for (let i = 0; i + 4 < list.length; i += 5) {
      const x = list[i], y = list[i + 1], z = list[i + 2], id = list[i + 3], blockMeta = list[i + 4];
      const key = chunkKey(x >> 4, z >> 4);
      let m = edits.get(key);
      if (!m) { m = new Map(); edits.set(key, m); }
      m.set(blockIndex(x & 15, y, z & 15), packState(id, blockMeta));
    }
    const rec = welcome.player;
    const meta: WorldMeta = {
      id: 'mp:' + address + (room ?? ''), name: welcome.worldName, seed: welcome.seed, genVersion: normalizeGenVersion(welcome.genVersion), seedText: '', created: 0, lastPlayed: Date.now(),
      player: rec ? { x: rec.x, y: rec.y, z: rec.z, yaw: rec.yaw, pitch: rec.pitch, flying: false } : null,
      hotbar: [...DEFAULT_HOTBAR], selectedSlot: 0, time: welcome.time, day: welcome.day, gameMode: welcome.gameMode,
      inventory: rec?.inventory, stats: rec?.stats, spawn: welcome.spawn, worldType: welcome.worldType,
      difficulty: welcome.difficulty, rules: welcome.rules, bed: rec?.bed, effects: rec?.effects,
    };
    this.stats.playerName = name;
    this.loadingProgress = progress;
    this.arenaMap = welcome.match?.map ?? DEFAULT_MAP;
    this.lastJoin = { name, address, room, arena: welcome.gameType !== 'minecraft', windowMs: ((welcome.rejoinSec ?? 60) + 20) * 1000 };
    this.containers.serverSupport = welcome.containers === true;
    this.startSession(meta, edits);
    const world = this.world!;
    // The server simulates the mobs, items, arrows and TNT; we only mirror them.
    const entities = this.entities!;
    entities.passiveSpawning = false;
    entities.hostileSpawning = false;
    const mirror = new NetEntities(entities);
    this.netEntities = mirror;
    this.netFalling = new NetFalling();
    entities.dropHook = (stack, x, y, z, delay, yaw) => {
      net.sendDrop(stack.id, stack.count, stack.damage, x, y, z, yaw, delay, encodeData(stack.data));
      return true;
    };
    entities.xpTakeHook = (orb) => {
      if (mirror.shouldTakeOrb(orb, performance.now() / 1000)) net.sendTake(orb.netId);
    };
    entities.takeHook = (item) => {
      // Only ask when the whole stack fits; the server hands it to the first asker.
      if (this.playerInventory.canFit(item.stack) && mirror.shouldTake(item, performance.now() / 1000)) net.sendTake(item.netId);
    };
    world.onEdit = (x, y, z, id, meta, prev, prevMeta) => net.sendBlock(x, y, z, id, meta, prev, prevMeta);
    net.onRevert = (x, y, z, id, meta) => world.applyRemoteEdit(x, y, z, id, meta);
    net.onMessage = (msg) => this.onServerMessage(msg);
    net.onClose = (reason, reconnectMs, lost) => {
      if (this.net !== net) return;
      const again = this.lastJoin;
      // Not a goodbye: the server keeps an arcade seat for a while, so the rejoin ticket stays.
      this.disconnect(false);
      this.input.exitLock();
      this.enterMenu();
      if (again && (reconnectMs || lost)) {
        // The connection broke, or the server said it is coming back (restart, lag kick): get back in by ourselves.
        this.startReconnect(again, reconnectMs ? reason : t('reconnect.lost'), reconnectMs ? Math.max(1500, reconnectMs) : backoffMs(1));
        return;
      }
      if (room) clearTicket(room);
      this.menu.showDisconnected(reason);
    };
    this.roomCode = room ?? null;
    if (room) {
      rememberGame({ code: room, name: welcome.worldName, gameType: welcome.gameType });
      // Invite links stay out of the address bar once you are in the game.
      if (new URLSearchParams(location.search).has('join')) history.replaceState(null, '', location.pathname);
    }
    this.remote.clear();
    if (welcome.gameType === 'minecraft') for (const p of welcome.players) this.remote.add(p.id, p.name, '', p.skin ?? '');
    if (welcome.gameType !== 'minecraft') {
      this.startArcade(welcome, (m) => net.send(m), name);
      // Arcade rooms tick faster (30 Hz): draw others two ticks in the past and report the position as often.
      const hz = welcome.tickHz ?? 20;
      this.remote.interpDelay = arcadeInterpDelay(hz);
      net.posInterval = 1 / Math.min(ARCADE_POS_HZ, hz);
    }
    this.chat.clear();
    this.chat.setCommands(SERVER_COMMAND_USAGE);
    this.chat.setVisible(true);
    if (welcome.motd) this.chat.add(welcome.motd, true);
    if (this.arcade) this.chat.add(this.arcadeHint, true);
    if (room) this.chat.add(t('chat.gameCode', formatCode(room)), true);
    if (welcome.rejoined) this.chat.add(t('rejoin.back'), true);
    else if (returning && welcome.rejoin) this.chat.add(t('rejoin.new'), true);
    return true;
  }

  /** Leaves and joins the same game again (new welcome, so the arena is rebuilt for the map the server now plays). */
  private rejoinServer(): void {
    const join = this.lastJoin;
    if (!join || !this.net) return;
    this.disconnect();
    this.input.exitLock();
    void this.joinServer(join.name, join.address, join.room);
  }

  /** Switches this session to an arcade game type: no building, no survival, weapons and the arcade HUD. */
  private async loadArcade(): Promise<void> {
    this.arcadeModule ??= await import('./ArcadeSession');
  }

  private startArcade(welcome: WelcomeMessage, send: (msg: ClientMessage) => void, name: string): void {
    const { ArcadeSession } = this.arcadeModule!; // loaded by joinServer / arcadePreview
    this.stopArcade();
    // Fixed arena: spawn where the server says; the next `spawn` message places us for real.
    this.setMode('creative');
    const p = this.player;
    p.canFly = false;
    p.flying = false;
    p.canSprint = true;
    p.setPosition(welcome.spawn.x, welcome.spawn.y, welcome.spawn.z);
    this.needsSurface = false;
    this.hand.visible = false;
    this.interaction!.arcade = true;
    this.hud.setArcade(true);
    this.subtitles.el.classList.add('arcade');
    this.cam.sprintFov = false;
    const def = gameTypeDef(welcome.gameType);
    const info = welcome.match ?? { type: welcome.gameType, scoreLimit: def.scoreLimit, timeLimitSec: def.timeLimitSec };
    const session = new ArcadeSession({
      send,
      audio: this.audio, player: p, cam: this.cam, remote: this.remote, particles: this.renderer.particles,
      getBlock: this.getBlock,
      getMeta: this.getMeta,
      getLight: (x, y, z) => this.world ? this.world.getLight(x, y, z) : 0xf0,
      selfId: welcome.id, selfName: name, info,
      feedback: this.feedback,
      // The next match is on another map: this world is wrong now, so join the game again.
      onMapChange: () => this.rejoinServer(),
    });
    this.arcade = session;
    session.hud.damageNumbers = this.settings.values.damageNumbers;
    session.setAimSettings(this.settings.values);
    session.hud.onLoadoutClose = () => void this.resumeGame();
    session.setBindings(this.input);
    this.renderer.scene.add(session.tracers.mesh);
    this.renderer.shadowExcluded.push(session.tracers.mesh);
    this.renderer.scene.add(session.modeVisuals.group);
    this.renderer.shadowExcluded.push(session.modeVisuals.group);
    this.renderer.scene.add(session.glints);
    this.renderer.shadowExcluded.push(session.glints);
    this.root.append(session.hud.el, session.hud.loadoutEl);
    session.setHudVisible(false);
    for (const pl of welcome.players) session.addPlayer(pl.id, pl.name, pl.team ?? '', pl.skin ?? '');
    const slideKey = keyDisplayName(this.input.bound(KB.SNEAK)) || 'Sneak';
    this.arcadeHint = `${realmsModeName(def.id)}: ${t(`realms.desc.${def.id}` as I18nKey)}. ${t(def.loadout === 'ladder' ? 'arc.keysLadder' : 'arc.keys')}`
      + ` ${t('arc.keySlide', slideKey)}`;
  }

  private stopArcade(): void {
    this.previewServer = null;
    this.afterLoad = null;
    const session = this.arcade;
    if (!session) return;
    this.arcade = null;
    this.remote.clear();
    this.remote.interpDelay = arcadeInterpDelay(20);
    if (this.net) this.net.posInterval = 0.05;
    session.dispose();
    session.tracers.mesh.removeFromParent();
    session.glints.removeFromParent();
    for (const o of [session.tracers.mesh, session.modeVisuals.group, session.glints]) {
      const i = this.renderer.shadowExcluded.indexOf(o);
      if (i >= 0) this.renderer.shadowExcluded.splice(i, 1);
    }
    session.hud.el.remove();
    session.hud.loadoutEl.remove();
    this.hud.setArcade(false);
    this.subtitles.el.classList.remove('arcade');
    this.hand.visible = this.mode !== 'spectator';
    this.cam.sprintFov = true;
    if (this.interaction) this.interaction.arcade = false;
  }

  private onServerMessage(msg: ServerMessage): void {
    const world = this.world;
    switch (msg.t) {
      case 'snap': this.remote.snapshot(msg.players, this.net?.id ?? -1, performance.now() / 1000, msg.k ?? -1); break;
      case 'ent': this.netEntities?.apply(msg, performance.now() / 1000); break;
      case 'fall': this.netFalling?.apply(msg.f, performance.now() / 1000); break;
      case 'hurt':
        this.hurtByServer(msg.cause, msg.amount, msg.by, msg.yaw);
        if (msg.effect) this.applyMobEffect(msg.effect as MobEffect, msg.by);
        break;
      case 'mobused': this.applyMobUse(msg); break;
      case 'mobfx': {
        const m = this.entities?.mobs.find((e) => e.netId === msg.id);
        if (m) this.mobRenderer.emote(msg.fx, m.x, m.y + m.height, m.z, m.width);
        break;
      }
      case 'boom':
        world?.applyRemoteRemovals(msg.blocks);
        this.explosionEffects(msg.by, msg.x, msg.y, msg.z, msg.power);
        break;
      case 'msound': {
        const p = this.player;
        const volume = Math.max(0, 1 - Math.hypot(msg.x - p.x, msg.y - p.y, msg.z - p.z) / 16);
        if (msg.event === 'arrow') this.audio.playArrowHit(volume, msg);
        else if (msg.event === 'shoot') this.audio.playBow(volume * 0.6);
        else this.audio.playMob(msg.kind, msg.event, volume, msg);
        if (volume > 0.05) this.caption(msg.event === 'arrow' ? 'Arrow hits' : mobSoundLabel(msg.kind, msg.event), msg.x, msg.z);
        break;
      }
      case 'taken': {
        this.netEntities?.taken(msg.id);
        const data = decodeData(msg.data);
        const left = this.playerInventory.add({ id: msg.itemId, count: msg.count, damage: msg.damage, data });
        if (left < msg.count) this.audio.playPop();
        // A race filled the inventory: hand the rest back to the world.
        if (left > 0) this.entities?.dropItem({ id: msg.itemId, count: left, damage: msg.damage, data }, this.player.x, this.player.y + 1, this.player.z, 40, undefined, true);
        break;
      }
      case 'orbs': this.netEntities?.applyOrbs(msg, performance.now() / 1000); break;
      case 'xpgain':
        this.netEntities?.orbTaken(msg.id);
        if (Number.isFinite(msg.value) && msg.value > 0) this.progression.pickupXp(Math.min(msg.value, 100_000));
        break;
      case 'block': world?.applyRemoteEdit(msg.x, msg.y, msg.z, msg.id, msg.meta ?? 0); break;
      case 'blocks':
        for (let i = 0; i + 4 < msg.edits.length; i += 5) {
          const e = msg.edits;
          world?.applyRemoteEdit(e[i], e[i + 1], e[i + 2], e[i + 3], e[i + 4]);
        }
        break;
      case 'join':
        if (this.arcade) this.arcade.addPlayer(msg.id, msg.name, '', msg.skin ?? '');
        else this.remote.add(msg.id, msg.name, '', msg.skin ?? '');
        break;
      case 'skin': this.remote.setSkin(msg.id, msg.skin); break;
      case 'leave':
        if (this.arcade) this.arcade.removePlayer(msg.id);
        else this.remote.remove(msg.id);
        break;
      case 'chat':
        this.chat.add(msg.system ? msg.text : '<' + msg.from + '> ' + msg.text, msg.system);
        if (!msg.system) this.audio.playUi('chat');
        break;
      case 'time':
        this.cycle.time = msg.time;
        if (msg.day !== undefined) this.cycle.day = msg.day;
        break;
      case 'teleport': this.player.setPosition(msg.x, msg.y, msg.z); break;
      case 'state':
        // The server did not accept our last inventory (it did not add up): take its version.
        this.playerInventory.load(msg.inventory);
        this.chat.add('The server corrected your inventory.', true);
        break;
      case 'gamemode': this.setMode(msg.mode); break;
      case 'container': this.containers.onMessage(msg); break;
      default: if (!this.weatherSys.onServerMessage(msg) && !this.worldRules.onServerMessage(msg)) this.arcade?.handle(msg, performance.now() / 1000); break;
    }
  }

  /** `leave`: the player goes on purpose (the server frees the seat and no rejoin ticket is kept); false when the connection already broke. */
  private disconnect(leave = true): void {
    this.stopArcade();
    this.roomCode = null;
    this.netEntities?.clear();
    this.netEntities = null;
    this.netFalling?.clear();
    this.netFalling = null;
    if (!this.net) return;
    const net = this.net;
    this.net = null;
    this.containers.reset();
    if (leave) net.leave(); else net.close();
    this.remote.clear();
    this.chat.close();
    this.chat.setVisible(false);
  }

  // ---------------------------------------------------------------- arcade preview (development only)

  /**
   * Development only (`window.game.arcadePreview('tdm' | 'ffa')`): starts a local test arena in
   * arcade mode with a fake server (bots, match, hits), to look at the arcade client without the
   * real server. With a map id (`arcadePreview('tdm', 'You', 'canyon')`) it plays on the real arena
   * of that map instead of a fake one. The fake server is `game.previewServer` (see ArcadePreview.ts for scripted events).
   */
  async arcadePreview(type: GameType = 'tdm', name = 'You', mapId?: string): Promise<void> {
    if (!import.meta.env.DEV) return;
    const { ArcadePreviewServer } = await import('./ArcadePreview');
    await this.loadArcade();
    this.audio.unlock();
    this.disconnect();
    this.loadingProgress = this.menu.showLoading('Loading arena preview', true);
    const meta: WorldMeta = {
      id: 'arcade-preview', name: 'Arcade preview', seed: 4242, seedText: '', created: 0, lastPlayed: Date.now(),
      player: null, hotbar: [...DEFAULT_HOTBAR], selectedSlot: 0, time: 0.3, gameMode: 'creative', spawn: { x: 8, y: 100, z: 8 },
      ...(mapId ? { worldType: 'arena' as const } : {}),
    };
    this.arenaMap = mapId ?? DEFAULT_MAP;
    this.startSession(meta, new Map());
    const world = this.world!;
    const ray = createRayHit();
    const server = new ArcadePreviewServer({
      deliver: (m) => this.onServerMessage(m),
      snapshot: (e) => this.remote.snapshot(e, 1, performance.now() / 1000),
      rayDistance: (ox, oy, oz, dx, dy, dz, max) => {
        const hit = raycast(this.getBlock, ox, oy, oz, dx, dy, dz, max, ray);
        return hit.hit ? hit.distance : max;
      },
    }, type, name, 10, mapId);
    const welcome = {
      t: 'welcome', id: server.selfId, worldName: 'Arcade preview', seed: meta.seed, gameMode: 'creative', time: 0.3,
      gameType: type, worldType: 'arena', match: server.info, spawn: { x: 8, y: 100, z: 8 }, edits: [], player: null,
      players: server.players(), motd: '',
    } as WelcomeMessage;
    this.startArcade(welcome, (m) => server.onClient(m, this.player), name);
    this.net = null;
    this.previewServer = server;
    this.afterLoad = () => {
      if (mapId) {
        // The real arena: start at a team spawn of the map.
        const spawn = getMap(mapId).spawns.red[0];
        server.centerX = 0;
        server.centerZ = 0;
        server.floorY = spawn.y;
        this.player.setPosition(spawn.x, spawn.y, spawn.z);
        server.start(spawn);
        this.player.yaw = spawn.yaw;
        return;
      }
      // A flat stone arena with a wall ring and some cover, high above the terrain.
      const cx = Math.floor(this.player.x), cz = Math.floor(this.player.z);
      let top = 0;
      for (let x = -24; x <= 24; x += 4) for (let z = -24; z <= 24; z += 4) top = Math.max(top, world.surfaceY(cx + x, cz + z));
      const floor = top + 4;
      for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) {
        for (let y = floor + 1; y <= floor + 6; y++) world.setBlock(cx + x, y, cz + z, BLOCK.AIR);
        world.setBlock(cx + x, floor, cz + z, (x + z) & 1 ? BLOCK.STONE : BLOCK.COBBLESTONE);
        if (Math.abs(x) === 24 || Math.abs(z) === 24) for (let y = 1; y <= 4; y++) world.setBlock(cx + x, floor + y, cz + z, BLOCK.COBBLESTONE);
      }
      for (const [bx, bz, h] of [[6, 0, 2], [-8, 6, 3], [0, -10, 2], [12, 12, 3], [-14, -8, 2], [4, 14, 1]]) {
        for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) for (let y = 1; y <= h; y++) world.setBlock(cx + bx + x, floor + y, cz + bz + z, BLOCK.OAK_PLANKS);
      }
      server.centerX = cx;
      server.centerZ = cz;
      server.floorY = floor + 1;
      this.player.setPosition(cx - 18, floor + 1, cz);
      server.start({ x: cx - 18, y: floor + 1, z: cz });
      this.player.yaw = -Math.PI / 2;
    };
  }

  // ---------------------------------------------------------------- death

  private onDeath(): void {
    this.statTracker.add('deaths');
    this.inventory.close();
    this.survivalInventory.close();
    this.chat.close();
    this.state = 'dead';
    announce(`You died. ${this.stats.deathMessage}`);
    if (this.input.locked) {
      this.suppressPause = true;
      this.input.exitLock();
    }
    this.interaction?.reset();
    this.progression.onDeath();
    this.worldRules.stopSleeping(false);
    if (!this.net && this.worldRules.rules.get('showDeathMessages') && this.stats.deathMessage) this.chat.add(this.stats.deathMessage, true);
    // Drop the whole inventory where the player died (unless keepInventory).
    const p = this.player;
    if (!this.worldRules.rules.get('keepInventory')) {
      for (let i = 0; i < 36; i++) {
        const s = this.playerInventory.get(i);
        if (s.count > 0) this.entities?.dropItem(s, p.x, p.y + 1, p.z, 40, undefined, true);
      }
      for (const s of this.playerInventory.armor) if (s.count > 0) this.entities?.dropItem(s, p.x, p.y + 1, p.z, 40, undefined, true);
      this.playerInventory.clear();
    }
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
    clearAnnouncement();
    const t = this.worldRules.respawnTarget(this.meta?.spawn ?? { x: this.player.x, y: this.player.y, z: this.player.z });
    this.worldRules.pendingBed = t.checkBed ? this.worldRules.bed : null;
    this.player.setPosition(t.x, t.y, t.z);
    this.player.vx = this.player.vy = this.player.vz = 0;
    this.player.fallDistance = 0;
    this.player.landedFall = 0;
    this.needsSurface = !this.worldRules.bed?.point; // a /spawnpoint position is kept as it is
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
    this.arcade?.closeLoadout();
    this.hud.setVisible(!this.hudHidden);
    this.arcade?.setHudVisible(!this.hudHidden);
    await this.input.requestLock();
    if (!this.input.locked && this.state === 'playing') {
      // The world must not keep running (mobs, hunger) behind the overlay.
      this.state = 'paused';
      this.showClickToPlay();
    }
  }

  private showClickToPlay(): void {
    this.stack.clear();
    const hint = t(this.input.touchMode ? 'click.tap' : this.input.padMode ? 'click.pad' : 'click.play');
    this.stack.push(h('div', { class: 'screen click-to-play', tabIndex: 0, role: 'button', 'aria-label': hint, onclick: () => void this.resumeGame() },
      h('div', { class: 'click-hint', text: hint })));
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
    announce('Game paused');
    void this.saveGame(true);
    this.showPauseMenu();
  }

  private showPauseMenu(): void {
    this.stack.clear();
    const pause = pauseScreen({
      resume: () => void this.resumeGame(),
      options: () => this.openOptions(),
      quit: () => void this.quitToTitle(),
      multiplayer: this.net !== null,
      statistics: this.net ? undefined : () => this.stack.push(statisticsScreen(this.statTracker, () => this.stack.pop())),
      advancements: this.net ? undefined : () => this.stack.push(advancementsScreen(this.advancements, this.icons, () => this.stack.pop())),
      invite: this.roomCode ? () => this.openInvite(this.roomCode!) : undefined,
      players: this.net ? () => this.openPlayers() : undefined,
      seed: !this.net && this.meta && this.meta.worldType !== 'arena' ? this.meta.seedText || String(this.meta.seed) : undefined,
      difficulty: this.arcade ? undefined : {
        get: () => this.worldRules.difficulty,
        set: (d) => this.worldRules.setDifficulty(d),
        // Servers change it with /difficulty; Hardcore is always Hard.
        locked: this.net !== null || this.mode === 'hardcore' || this.meta?.gameMode === 'hardcore',
      },
      gameRules: this.net || this.arcade ? undefined : () => this.stack.push(gameRulesScreen(this.worldRules.rules, () => this.stack.pop(), () => this.worldRules.apply())),
    });
    // The arena's pause menu wears the shell; the survival pause menu keeps its look for now.
    if (this.arcade) this.pushShell(pause);
    else this.stack.push(pause);
  }

  /** The player list of the pause menu: hide or report the custom skins of other players. */
  private openPlayers(): void {
    const screen = playersScreen(() => this.remote.entries(), (id) => this.net?.send({ t: 'skinreport', id }), () => this.stack.pop());
    if (this.arcade) this.pushShell(screen);
    else this.stack.push(screen);
  }

  private openInvite(code: string): void {
    this.stack.push(inviteScreen(code, inviteLink(code), inviteText(code), () => this.stack.pop(), !!this.arcade));
  }

  /** Crafting stations within 4 blocks of the player. */
  private nearbyStations(): Set<Station> {
    const s = new Set<Station>(['hand']);
    const p = this.player;
    for (let y = -2; y <= 3; y++) for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
      const b = this.getBlock(Math.floor(p.x) + x, Math.floor(p.y) + y, Math.floor(p.z) + z);
      if (b === BLOCK.CRAFTING_TABLE) s.add('table');
      else if (b === BLOCK.FURNACE || b === BLOCK.LIT_FURNACE) s.add('furnace');
    }
    return s;
  }

  /** Is this key event the action's bound key, or a virtual press (touch button, gamepad)? */
  private keyIs(code: string, action: number): boolean {
    return this.input.matches(code, action) || code === `Virtual${action}`;
  }

  private onKey(code: string): void {
    if (this.chat.isOpen) return;
    const command = this.keyIs(code, KB.COMMAND);
    const chatAvailable = this.net !== null || (this.meta !== null && !this.arcade);
    if ((command || this.keyIs(code, KB.CHAT)) && chatAvailable && this.state === 'playing' && this.input.locked) {
      this.state = 'chat';
      this.suppressPause = this.input.locked;
      this.input.exitLock();
      this.chat.openInput(command ? '/' : '');
      return;
    }
    if (code === 'F3') this.debug.toggle();
    if (code === 'F2' && this.world) this.wantScreenshot = true;
    // F11: fullscreen like Minecraft (the page's own fullscreen; the browser's F11 is a different mode).
    if (code === 'F11') {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => undefined);
    }
    // With keyboard lock (fullscreen) Esc arrives as a key press instead of ending pointer lock.
    if (code === 'Escape' && keyboardLockActive() && this.state === 'playing') this.input.exitLock();
    if (code === 'F1' && this.state === 'playing') {
      this.hudHidden = !this.hudHidden;
      this.hud.setVisible(!this.hudHidden);
      this.arcade?.setHudVisible(!this.hudHidden);
    }
    if (this.arcade && this.arcade.def.loadout !== 'ladder' && this.keyIs(code, KB.LOADOUT)) {
      // The loadout menu needs the mouse, like the inventory.
      if (this.state === 'playing' && this.input.locked) {
        this.state = 'inventory';
        this.suppressPause = true;
        this.input.exitLock();
        this.arcade.openLoadout();
      } else if (this.state === 'inventory') {
        void this.resumeGame();
      }
    }
    if (!this.arcade && this.keyIs(code, KB.INVENTORY)) {
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
    if (!this.arcade && this.keyIs(code, KB.DROP) && this.state === 'playing' && this.input.locked && this.mode !== 'spectator') {
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
    // Max Framerate: skip this display refresh while the previous frame is too recent.
    if (this.minFrameMs > 0 && now - this.last < this.minFrameMs - 1.5) return;
    const rawDt = (now - this.last) / 1000;
    this.frameDt = Math.min(rawDt, 0.1);
    const dt = Math.min(rawDt, 0.1);
    this.last = now;
    const cpuStart = performance.now();
    this.time += dt;

    this.updateInputDevices(dt);
    switch (this.state) {
      case 'menu': this.updateMenu(dt); break;
      case 'loading': this.updateLoading(); break;
      default: this.updatePlaying(dt);
    }
    this.updateEntitiesRender();

    this.renderer.render(this.cam.camera, this.cycle, this.time, this.underwater);
    if (this.state === 'playing' && !document.hidden && this.dynamicResolution.update(rawDt, this.renderer.basePixelRatio)) {
      this.renderer.setDynamicScale(this.dynamicResolution.scale);
      this.applyRenderDistance();
      this.updateMenuBlur();
    }
    if (this.wantThumbnail) this.captureThumbnail();
    if (this.wantScreenshot) this.captureScreenshot();
    this.world?.chunks.afterRender();
    this.audio.setMusicMode(this.state === 'menu' || this.state === 'loading' ? 'menu' : this.arcade ? 'arcade' : 'game');
    this.audio.setMusicIntensity(this.arcade?.phase === 'live' ? 1 : 0);
    this.audio.update(dt);
    const cpuMs = performance.now() - cpuStart;
    if (this.state === 'playing') this.world?.chunks.adapt(cpuMs);
    if (this.debug.tick(dt, cpuMs)) this.updateDebug();
    this.input.endFrame();
  };

  /** Touch HUD, controller and captions: run before the game reads the input. */
  private updateInputDevices(dt: number): void {
    const playing = this.state === 'playing' && this.input.locked;
    const arcade = this.arcade !== null;
    const t = this.touchCtx;
    t.playing = playing;
    t.arcade = arcade;
    t.chat = this.net !== null && !arcade;
    t.overlay = this.state === 'inventory' || this.state === 'chat';
    this.touch.update(dt, t);
    const c = this.padCtx;
    c.state = this.state;
    c.playing = playing;
    c.arcade = arcade;
    this.pad.update(dt, c);
    this.subtitles.update(dt);
  }

  private updateEntitiesRender(): void {
    const e = this.entities, world = this.world;
    if (!e || !world) return;
    this.netEntities?.update(performance.now() / 1000, this.frameDt);
    // Interpolation factor between 20 Hz entity ticks.
    const alpha = Math.min(1, ((this.stepCount % STEPS_PER_TICK) + this.accumulator / PHYSICS.STEP) / STEPS_PER_TICK);
    const list = this.renderMobs;
    list.length = 0;
    for (let i = 0; i < e.mobs.length; i++) list.push(e.mobs[i]);
    const remote = this.remote.mobs;
    for (let i = 0; i < remote.length; i++) list.push(remote[i]);
    this.mobRenderer.update(list, alpha, world, this.cam.camera.position);
    this.itemRenderer.update(e.items, alpha, this.time, world);
    this.tntRenderer.update(e.tnt, alpha, world);
    this.arrowRenderer.update(e.arrows, alpha, world);
    this.progression.update(alpha, this.time, hasSurvivalRules(this.mode) && !this.arcade);
    this.netFalling?.update(performance.now() / 1000);
    this.fallingRenderer.update(this.netFalling ? this.netFalling.list : world.updates?.falling ?? Game.NO_FALLING, alpha, world);
  }

  private updateMenu(dt: number): void {
    const world = this.world!;
    this.cycle.time = (this.cycle.time + dt / 2400) % 1;
    this.cycle.compute();
    this.cam.flyover(this.menuOrbit.x, this.menuOrbit.y, this.menuOrbit.z, this.menuRadius.x, this.menuRadius.y, this.time);
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
    this.loadingProgress?.(ready === 0 ? t('loading.terrain') : t('loading.meshes'), ready / total);
    // Keep the camera at the spawn so the first frame after loading is correct.
    this.cam.camera.position.set(this.player.x, this.player.y + PHYSICS.EYE_HEIGHT, this.player.z);
    if (world.chunks.isAreaReady(this.player.x, this.player.z, r)) this.finishLoading();
  }

  /** Reused every game tick (no per-tick allocations). */
  private readonly mobTarget = { x: 0, y: 0, z: 0, attackable: false, collects: true, held: 0, yaw: 0, pitch: 0 };
  /** The horse the player rides (singleplayer), null on foot. */
  private mount: Mob | null = null;

  private readonly pickupItem = (s: ItemStack): number => {
    const left = this.playerInventory.add(s);
    if (left < s.count) this.audio.playPop();
    return left;
  };

  private readonly mobEvents: MobEvents = {
    attack: (mob, damage) => {
      const p = this.player;
      const yaw = Math.atan2(p.x - mob.x, p.z - mob.z);
      if (this.stats.hurt(damage, { kind: 'mob', attacker: mob.type.name, yaw }, this.mode).hurt) {
        this.progression.thorns(mob);
        // Cave spiders poison, husks make hungry.
        this.applyMobEffect(meleeEffect(mob), mob.type.name);
        // Knockback away from the attacker.
        const d = Math.hypot(p.x - mob.x, p.z - mob.z) || 1;
        p.vx += ((p.x - mob.x) / d) * 8;
        p.vz += ((p.z - mob.z) / d) * 8;
        p.vy = Math.max(p.vy, 6);
        this.cam.hurtSide = Math.sin(yaw - p.yaw) >= 0 ? 1 : -1;
      }
    },
    killed: (mob) => {
      this.statTracker.add('killed');
      this.advancements.onMobKilled(mob.type.hostile);
    },
    playerArrowHit: () => this.advancements.onArrowHitMob(),
    explode: (mob) => this.explode(mob, mob.x, mob.y + 0.5, mob.z, 3),
    shoot: (mob) => {
      const p = this.player;
      this.entities?.skeletonShoot(mob, p.x, p.y, p.z);
      const d = Math.hypot(mob.x - p.x, mob.y - p.y, mob.z - p.z);
      this.audio.playBow(Math.max(0, 1 - d / 16) * 0.6);
      if (d < 16) this.caption('Skeleton shoots', mob.x, mob.z);
    },
    arrowHit: (arrow, damage) => {
      const p = this.player;
      const yaw = Math.atan2(-arrow.vx, -arrow.vz);
      if (this.stats.hurt(damage, { kind: 'arrow', attacker: arrow.shooter ? arrow.shooter.type.name : undefined, yaw }, this.mode).hurt) {
        // Knockback along the arrow's direction.
        const h = Math.hypot(arrow.vx, arrow.vz) || 1;
        p.vx += (arrow.vx / h) * 3;
        p.vz += (arrow.vz / h) * 3;
        p.vy = Math.max(p.vy, 3);
        this.cam.hurtSide = Math.sin(yaw - p.yaw) >= 0 ? 1 : -1;
        // Strays shoot arrows of Slowness.
        this.applyMobEffect(arrowEffect(arrow.shooter), arrow.shooter?.type.name);
      }
    },
    arrowImpact: (arrow) => {
      const p = this.player;
      const vol = 1 - Math.hypot(arrow.x - p.x, arrow.y - p.y, arrow.z - p.z) / 16;
      this.audio.playArrowHit(vol);
      if (vol > 0.05) this.caption('Arrow hits', arrow.x, arrow.z);
    },
    tntExplode: (t) => this.explode(null, t.x, t.y + 0.49, t.z, 4, t.inWater),
    sound: (mob, kind) => {
      const d = Math.hypot(mob.x - this.player.x, mob.y - this.player.y, mob.z - this.player.z);
      const vol = Math.max(0, 1 - d / 16);
      this.audio.playMob(mob.type.kind, kind, vol, mob);
      if (vol > 0.05) this.caption(mobSoundLabel(mob.type.kind, kind), mob.x, mob.z);
    },
    fx: (mob, kind) => this.mobRenderer.emote(kind, mob.x, mob.y + mob.height, mob.z, mob.width),
    potion: (mob) => this.witchPotion(mob.x, mob.z, mob.type.name),

  };

  /**
   * Creeper or TNT explosion: blocks, drops, damage with distance falloff, knockback, effects.
   * Under water (like Minecraft) it hurts entities but leaves the blocks intact.
   */
  private explode(source: Mob | null, x: number, y: number, z: number, power: number, inWater = false): void {
    const world = this.world!, entities = this.entities!;
    const positions: number[] = [];
    // Creepers break blocks only with the mobGriefing rule; TNT always does.
    const grief = !source || this.worldRules.rules.get('mobGriefing');
    const destroyed = inWater || !grief ? [] : world.explode(x, y, z, power * 1.3, positions);
    // Blocks drop with chance 1/power (TNT: all of them), like Minecraft; caught TNT lights with a short fuse.
    const dropChance = explosionDropChance(power, source === null);
    for (let i = 0; i < destroyed.length; i++) {
      const id = destroyed[i];
      if (id === BLOCK.TNT) {
        entities.primeTnt(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], 10 + Math.floor(Math.random() * 20));
        continue;
      }
      if (Math.random() < dropChance && getBlockDef(id)?.inInventory) {
        const drop = blockDrop(id, ITEM.DIAMOND_PICKAXE);
        if (drop) entities.dropItem(drop,
          x + (Math.random() - 0.5) * power, y + Math.random() * power * 0.5, z + (Math.random() - 0.5) * power);
      }
    }
    this.explosionEffects(source ? source.type.name : '', x, y, z, power);
    for (const m of entities.mobs) {
      const dmg = explosionDamage(Math.hypot(m.x - x, m.y - y, m.z - z), power);
      if (m !== source && dmg > 0) m.hurt(dmg, x, z, 1.5);
    }
  }

  /** Particles, sound and the player's own damage and knockback by distance (also for server explosions). */
  private explosionEffects(by: string, x: number, y: number, z: number, power: number): void {
    for (let i = 0; i < 6; i++) {
      this.renderer.particles.spawnBreak(Math.floor(x + (Math.random() - 0.5) * 4), Math.floor(y + (Math.random() - 0.5) * 3),
        Math.floor(z + (Math.random() - 0.5) * 4), BLOCK.COBBLESTONE, 0xf0);
    }
    const p = this.player;
    const d = Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z);
    this.audio.playExplosion(1, { x, y, z });
    this.caption('Explosion', x, z);
    if (d < 40) this.pad.rumble(Math.min(1, 1.2 - d / 40), 0.7, 350);
    const reach = power * 2;
    if (d < reach) {
      const impact = 1 - d / reach;
      const dmg = explosionDamage(d, power);
      this.stats.hurt(dmg, { kind: 'explosion', attacker: by || undefined, yaw: Math.atan2(p.x - x, p.z - z) }, this.mode);
      const len = d || 1;
      p.vx += ((p.x - x) / len) * impact * 14;
      p.vz += ((p.z - z) / len) * impact * 14;
      p.vy += impact * 9;
    }
  }

  /** Damage from a server mob or arrow: same hurt camera, knockback and rules as a local hit. */
  /** A witch's splash potion hits the player (the witch picks it like Minecraft's: see MobEffects.witchPotion). */
  private witchPotion(x: number, z: number, by: string): void {
    const p = this.player, stats = this.stats;
    if (!hasSurvivalRules(this.mode) || stats.dead) return;
    const effect = witchPotion(Math.hypot(p.x - x, p.z - z), stats.health, (id) => stats.effects.has(id), Math.random());
    this.applyMobEffect(effect, by);
    const color = EFFECT_DEFS[effect[0]].color;
    for (let i = 0; i < 4; i++) this.renderer.particles.spawnBreak(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z), BLOCK.GLASS, 0xf0, color);
    this.audio.playMob('witch', 'hurt', 0.6);
  }

  /** A status effect from a mob (bite, husk hit, stray arrow, witch potion); survival only. */
  /** @param by the mob's name, for the death message of an instant-damage potion ("was killed by Witch using magic"). */
  private applyMobEffect(e: MobEffect | null, by?: string): void {
    if (!e || !hasSurvivalRules(this.mode) || this.stats.dead || !isEffectId(e[0])) return;
    this.stats.effectAttacker = by || null;
    this.stats.effects.add(e[0], e[1], e[2], this.stats);
    this.stats.effectAttacker = null;
  }

  /** Right click on a mob: feed, tame, shear, milk, dye, saddle or mount. True when something happened. */
  private useMob(mob: Mob): boolean {
    const held = this.hotbar.selectedStack.id;
    if (mob.remote) {
      if (!this.net || !canUseOnMob(mob, held, this.net.id)) return false;
      this.net.sendUseMob(mob.netId);
      return true;
    }
    const r = useOnMob(mob, held, 0);
    if (r.action === 'none') return false;
    if (r.action === 'mount') {
      if (this.mount) return false;
      this.mount = mob;
      mountHorse(this.player, mob, this.mobTarget);
      return true;
    }
    this.applyMobUse(r);
    return true;
  }

  /** What using an item on a mob costs: the item is eaten, swapped (bucket → milk) or worn (shears). */
  private applyMobUse(r: UseResult): void {
    const inv = this.playerInventory, slot = this.hotbar.selected;
    if (r.action === 'shear') this.audio.playMob('sheep', 'hurt', 0.4);
    if (!hasSurvivalRules(this.mode)) {
      if (r.give) inv.add({ id: r.give, count: 1 });
      this.hotbar.refresh();
      return;
    }
    if (r.damageTool) inv.damageTool(slot);
    if (r.give) {
      if (inv.get(slot).count <= r.consume) inv.set(slot, { id: r.give, count: 1 });
      else {
        inv.consumeSlot(slot, r.consume);
        if (inv.add({ id: r.give, count: 1 }) > 0) this.entities?.dropItem({ id: r.give, count: 1 }, this.player.x, this.player.y + 1, this.player.z, 40);
      }
    } else if (r.consume > 0) inv.consumeSlot(slot, r.consume);
    this.hotbar.refresh();
  }

  private hurtByServer(cause: 'mob' | 'arrow', amount: number, by: string, yaw: number): void {
    const p = this.player;
    if (!this.stats.hurt(amount, { kind: cause, attacker: by || undefined, yaw }, this.mode).hurt) return;
    // yaw points from the attacker to the player (mob) or along the arrow's flight (arrow).
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    if (cause === 'mob') {
      p.vx += sin * 8;
      p.vz += cos * 8;
      p.vy = Math.max(p.vy, 6);
    } else {
      p.vx -= sin * 3;
      p.vz -= cos * 3;
      p.vy = Math.max(p.vy, 3);
    }
    this.cam.hurtSide = Math.sin(yaw - p.yaw) >= 0 ? 1 : -1;
  }

  /** 20 Hz game tick: health, hunger, entities. */
  private gameTick(): void {
    const p = this.player, stats = this.stats;
    // Arcade: no fall damage, hunger, mobs or items; the server owns health.
    if (this.arcade) {
      p.landedFall = 0;
      p.sprintDistance = p.swimDistance = 0;
      p.jumps = 0;
      return;
    }
    // Fall damage on landing (distance − 3), not in creative or water.
    if (p.landedFall > 0) {
      // Landing on farmland may trample it into dirt (any game mode, like Minecraft).
      if (this.world && this.mode !== 'spectator') trample(this.world, Math.floor(p.x), Math.floor(p.y - 0.01), Math.floor(p.z), p.landedFall, Math.random());
      const dmg = Math.ceil(p.landedFall - 3 - stats.effects.jumpBoost());
      if (dmg > 0 && !p.inWater) {
        if (stats.hurt(dmg, { kind: 'fall' }, this.mode).hurt) this.cam.hurtSide = 1;
      }
      p.landedFall = 0;
    }
    if (hasSurvivalRules(this.mode)) {
      // Exhaustion from movement (Minecraft values).
      stats.addExhaustion(p.sprintDistance * 0.1 + p.swimDistance * 0.01 + p.jumps * (p.sprinting ? 0.2 : 0.05));
    }
    p.sprintDistance = p.swimDistance = 0;
    p.jumps = 0;
    this.weatherSys.gameTick();
    this.worldRules.gameTick();
    this.world?.tickLiquids();
    this.world?.tickRedstone();
    this.world?.tickGrowth(p.x, p.z);
    this.world?.blockEntities.tick();
    this.containers.tick();
    stats.tick(p, this.getBlock, this.mode);
    p.canSprint = !hasSurvivalRules(this.mode) || stats.canSprint;

    const alive = !stats.dead;
    const target = this.mobTarget;
    target.x = p.x; target.y = p.y; target.z = p.z;
    target.attackable = alive && hasSurvivalRules(this.mode);
    target.held = this.hotbar.selectedStack.id;
    target.yaw = p.yaw; target.pitch = p.pitch;
    target.collects = alive && this.mode !== 'spectator';
    if (this.entities) this.entities.xpPickup = target.collects ? this.progression.pickupXp : null;
    this.entities?.tick(
      target,
      // Rain and thunder count as extra darkness for the spawn rules.
      Math.round((1 - this.cycle.dayFactor) * 11 + this.weatherSys.weather.skyDarkness),
      this.mobEvents,
      alive && this.mode !== 'spectator' ? this.pickupItem : null,
      this.cycle.dayFactor > 0.6,
    );
    if (this.entities) this.mobSteps.update(this.entities.mobs, p.x, p.z);
    if (stats.dead && (this.state === 'playing' || this.state === 'inventory' || this.state === 'chat' || this.state === 'paused')) this.onDeath();
  }

  /** Statistics: time played, distance walked (not flying) and jumps, from per-frame position changes. */
  private trackStats(dt: number): void {
    const p = this.player, st = this.statTracker;
    st.add('playMs', dt * 1000);
    const last = this.statLast;
    if (last) {
      if (!p.flying && !p.noclip) st.addWalk(Math.hypot(p.x - last.x, p.z - last.z));
      if (last.ground && !p.onGround && p.vy > 4) st.add('jumps');
    }
    if (!last) this.statLast = { x: p.x, z: p.z, ground: p.onGround };
    else {
      last.x = p.x;
      last.z = p.z;
      last.ground = p.onGround;
    }
  }

  private updatePlaying(dt: number): void {
    const world = this.world!;
    const p = this.player;
    const input = this.input;
    const active = this.state === 'playing' && input.locked;

    if (active) {
      const sens = 0.0022 * (this.settings.values.sensitivity / 100) * (this.arcade ? this.arcade.sensitivityScale : 1);
      p.yaw -= input.mouseDX * sens;
      p.pitch -= input.mouseDY * sens * (this.settings.values.invertMouse ? -1 : 1);
      const limit = Math.PI / 2 - 0.001;
      p.pitch = Math.max(-limit, Math.min(limit, p.pitch));
      if (!this.arcade) {
        for (let i = 0; i < 9; i++) if (input.actionPressed(KB.HOTBAR_1 + i)) this.hotbar.select(i);
        if (input.wheel !== 0) this.hotbar.select(this.hotbar.selected + input.wheel);
      }
    }

    if (this.state === 'playing' && !this.arcade) this.trackStats(dt);

    if (this.state !== 'paused') {
      // Fixed-step simulation, rendered with interpolation.
      this.accumulator = Math.min(this.accumulator + dt, 0.25);
      const move = this.move;
      const arcade = this.arcade;
      const control = active && this.state !== 'dead' && !arcade?.dead;
      // Keys give -1/0/1; sticks and the touch joystick add analog values on top.
      const keyFwd = (input.actionDown(KB.FORWARD) ? 1 : 0) - (input.actionDown(KB.BACK) ? 1 : 0);
      const keyStrafe = (input.actionDown(KB.RIGHT) ? 1 : 0) - (input.actionDown(KB.LEFT) ? 1 : 0);
      move.forward = control ? Math.max(-1, Math.min(1, keyFwd + input.axisForward)) : 0;
      move.strafe = control ? Math.max(-1, Math.min(1, keyStrafe + input.axisStrafe)) : 0;
      move.jump = control && input.actionDown(KB.JUMP);
      move.jumpPressed = latchPress(move.jumpPressed, control, input.actionPressed(KB.JUMP));
      // Arcade: always sprinting at the weapon's pace, bunny hop friendly air control, no sneaking.
      move.sprint = control && (arcade !== null || input.actionDown(KB.SPRINT) || input.sprintAxis);
      // A toggled sprint ends when the player stops walking forward.
      if (this.wasMovingForward && move.forward <= 0) input.releaseLatch(KB.SPRINT);
      this.wasMovingForward = move.forward > 0;
      // Auto-jump: walking into a one-block step (touch setting, or Options > Controls > Auto-Jump).
      if (control && !arcade && (input.touchMode ? this.settings.values.touchAutoJump : this.settings.values.autoJump) && p.onGround && p.horizontalCollision
        && (move.forward !== 0 || move.strafe !== 0)) {
        const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
        if (needsAutoJump(this.solidAt, p.x, p.y, p.z, -sin * move.forward + cos * move.strafe, -cos * move.forward - sin * move.strafe)) move.jump = true;
      }
      move.descend = control && arcade === null && input.actionDown(KB.SNEAK);
      // Arcade: the sneak key crouches, and slides while running (latched like the jump press).
      move.crouch = control && arcade !== null && input.actionDown(KB.SNEAK);
      move.crouchPressed = latchPress(move.crouchPressed === true, control && arcade !== null, input.actionPressed(KB.SNEAK));
      p.arcadeMove = arcade !== null;
      if (arcade) {
        p.speedMultiplier = arcade.speedMultiplier;
        p.airAccel = arcade.airAccel;
        p.slideCooldown = arcade.slideCooldown;
      } else {
        // Status effects: Speed/Slowness, Jump Boost, Levitation.
        const fx = this.stats.effects;
        p.speedMultiplier = fx.speedMultiplier();
        p.jumpBoost = fx.jumpBoost();
        p.levitation = fx.level('levitation');
        // A raised shield slows you down to sneaking speed.
        if (this.interaction?.blocking) p.speedMultiplier *= 0.3;
      }
      const asleep = this.worldRules.sleeping;
      while (this.accumulator >= PHYSICS.STEP) {
        // Riding: the horse moves, the player sits on it (sneak gets off).
        if (this.mount && !rideStep(p, this.mount, move, ((this.stepCount % STEPS_PER_TICK) + 1) / STEPS_PER_TICK)) this.mount = null;
        if (!asleep && !this.mount) p.step(move, this.getBlock, this.getMeta);
        move.jumpPressed = false;
        move.crouchPressed = false;
        if (p.slideStarts !== this.slidesSeen) {
          this.slidesSeen = p.slideStarts;
          this.slideStep = this.stepCount + 1;
          this.audio.playSlide();
        }
        if (p.padLaunches !== this.padsSeen) {
          this.padsSeen = p.padLaunches;
          this.audio.playJumpPad();
        }
        this.accumulator -= PHYSICS.STEP;
        if (++this.stepCount % STEPS_PER_TICK === 0) this.gameTick();
      }
      if (this.arcade || this.worldRules.daylightCycle) this.cycle.update(dt);
      this.worldRules.update(dt);
      this.weatherSys.update(dt);
      this.autosave += dt;
      if (this.autosave > AUTOSAVE_INTERVAL) {
        this.autosave = 0;
        void this.saveGame();
      }
    }
    this.cycle.compute();

    world.chunks.viewX = -Math.sin(p.yaw);
    world.chunks.viewZ = -Math.cos(p.yaw);
    world.chunks.update(p.x, p.z);
    if (this.arcade) {
      this.cam.hurt = this.arcade.hurt;
      this.cam.hurtSide = this.arcade.hurtSide;
    } else this.cam.hurt = Math.max(0, (this.stats.hurtTime - this.accumulator / PHYSICS.STEP / STEPS_PER_TICK) / 10);
    this.cam.bowPull = this.interaction?.bowPull ?? 0;
    this.cam.update(p, this.accumulator / PHYSICS.STEP, dt);
    const eye = this.cam.camera.position;
    this.underwater = pointInLiquid(this.getBlock, this.getMeta, BLOCK.WATER, eye.x, eye.y, eye.z);
    this.playerSounds.update(p);
    this.audio.setListener(eye.x, eye.y, eye.z, p.yaw);
    this.audioProbe.update(dt, this.audio.env, eye.x, eye.y, eye.z, this.cycle.dayFactor, this.underwater);
    this.hud.setUnderwater(this.underwater);
    this.hud.setHurt(limitFlash(this.arcade ? this.arcade.hurtVignette : this.stats.hurtTime / 10, this.settings.values));
    if (!this.arcade) this.hud.survival.update({
      health: Math.ceil(this.stats.health), hunger: this.stats.hunger, air: this.stats.air, maxAir: MAX_AIR, armor: this.stats.armorPoints,
      hardcore: this.mode === 'hardcore', poison: this.stats.effects.level('poison') > 0, wither: this.stats.effects.level('wither') > 0,
      hurtTime: this.stats.hurtTime, saturation: this.stats.saturation,
    }, this.time);
    if (!this.arcade) {
      const fx = this.hud.effects;
      fx.updateEffects(this.stats.effects, this.time);
      fx.updateAbsorption(hasSurvivalRules(this.mode) ? this.stats.absorption : 0);
      const charge = this.interaction?.cooldown.charge ?? 1;
      const showCooldown = this.state === 'playing' && this.mode !== 'spectator';
      fx.updateCooldown(charge, showCooldown && this.settings.values.attackIndicator === 'crosshair');
      this.hud.setAttackCharge(showCooldown ? charge : 1);
    }

    if (this.net) {
      const flags = (p.sprinting ? 1 : 0) | (p.flying ? 2 : 0) | (p.onGround ? 4 : 0) | (this.arcade ? this.arcade.aimFlags : 0)
        | (p.crouching ? SNAP_FLAG_CROUCH : 0) | (p.sliding ? SNAP_FLAG_SLIDE : 0);
      // The physics clock (steps) lets the server time the movement checks without trusting arrival times.
      this.net.update(dt, p.x, p.y, p.z, p.yaw, p.pitch, flags, this.arcade ? 0 : this.hotbar.selectedBlock, this.stepCount, this.arcade ? this.slideStep : NaN);
    }
    if (this.net || this.previewServer) this.remote.update(performance.now() / 1000, this.cam.camera, window.innerWidth, window.innerHeight);
    // Arcade: after dying the camera follows another player (with fresh interpolated poses).
    const spectating = this.arcade?.applySpectateCamera(this.cam.camera) ?? false;
    this.previewServer?.update(dt, p);
    this.interaction!.update(dt, active, input, this.mode);
    const light = world.getLight(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z));
    if (this.arcade) {
      const f = this.arcadeFrame;
      f.now = performance.now() / 1000;
      f.dt = dt;
      f.controls = active;
      f.bobPhase = this.cam.bobPhase;
      f.bobStrength = this.cam.bobStrength;
      f.light = Math.max(0.35, Math.min(1, ((light >> 4) / 15) * this.cycle.daylight + (light & 15) / 15));
      f.aspect = window.innerWidth / Math.max(1, window.innerHeight);
      // Weapon sway follows the look input; Reduced Motion turns it off.
      const sway = this.settings.values.reducedMotion ? 0 : 1;
      f.lookX = input.mouseDX * sway;
      f.lookY = input.mouseDY * sway;
      this.arcade.update(f, input);
      // Sway, recoil and the aim zoom the session applied this frame show in this frame (not one frame late).
      if (!spectating) this.cam.syncAim(p);
    } else {
      this.hand.update(dt, this.hotbar.selectedBlock, this.cam.bobPhase, this.cam.bobStrength, light,
        this.interaction!.eating, window.innerWidth / Math.max(1, window.innerHeight), hasEnchants(this.hotbar.selectedStack.data), this.time);
    }
    this.renderer.particles.update(dt, world);
    this.renderer.clouds.update(dt, this.cycle);
  }

  // ---------------------------------------------------------------- debug

  /** Living mobs around a point (in multiplayer the mirror of the server mobs), for F3. */
  private countMobsNear(x: number, z: number, radius: number): { hostile: number; passive: number } {
    const r2 = radius * radius;
    let hostile = 0, passive = 0;
    const count = (list: readonly Mob[]) => {
      for (const m of list) {
        if (m.removed || m.dead || (m.x - x) ** 2 + (m.z - z) ** 2 > r2) continue;
        if (m.type.hostile) hostile++; else passive++;
      }
    };
    if (this.entities) count(this.entities.mobs);
    return { hostile, passive };
  }

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
    const facing = facingFromCameraYaw(p.yaw);
    const light = world.getLight(bx, by, bz);
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const worldBlocks = stats.loaded * CHUNK_VOLUME;
    const ray = this.interaction?.ray;
    const target = ray?.hit ? `${getBlockDef(ray.id)?.displayName} @ ${ray.x}, ${ray.y}, ${ray.z}` : '—';
    // Block state like Minecraft's F3 lists it under the targeted block (crop age, farmland moisture).
    const targetState = ray?.hit ? farmStateText(ray.id, world.getMeta(ray.x, ray.y, ray.z)) : null;
    const e = this.entities;
    const near = this.countMobsNear(p.x, p.z, 64);
    // Grouped like Minecraft 1.21's F3: left = version, performance, renderer counts, then position and world
    // state; right = memory, system/display, then the targeted block. F3 text stays English, as in Minecraft.
    const towards: Record<string, string> = { north: 'Towards negative Z', south: 'Towards positive Z', east: 'Towards positive X', west: 'Towards negative X' };
    d.set([
      `BunkCraft 1.0 (WebGL2 · three.js r${THREE.REVISION})`,
      `${d.fps} fps · frame ${d.frameMs.toFixed(2)} ms CPU · worst ${d.worstMs.toFixed(1)} ms`,
      `C: ${visible}/${stats.loaded} (meshed ${stats.meshed}) D: ${world.chunks.renderDistance}${this.dynamicResolution.distanceDrop > 0 ? ` (adaptive -${this.dynamicResolution.distanceDrop})` : ''} · Draw calls: ${r.drawCalls} (+${r.shadowCalls} shadow)`,
      `E: ${e?.mobs.length ?? 0} mobs, ${e?.items.length ?? 0} items · P: ${this.renderer.particles.active}${this.renderer.precipitation.count > 0 ? ` · Rain: ${this.renderer.precipitation.count}` : ''} · Tris: ${(r.triangles / 1000).toFixed(1)}k`,
      `Workers: ${this.pool.size} · queue ${this.pool.queued} · gen ${this.pool.genMs.toFixed(1)} ms · mesh ${this.pool.meshMs.toFixed(1)} ms`,
      '',
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(5)} / ${p.z.toFixed(3)}`,
      `Block: ${bx} ${by} ${bz}`,
      `Chunk: ${bx & 15} ${by} ${bz & 15} in ${bx >> 4} ${bz >> 4}`,
      `Facing: ${facing} (${towards[facing] ?? ''}) (${yawDeg.toFixed(1)} / ${((-p.pitch * 180) / Math.PI).toFixed(1)})`,
      `Light: ${Math.max(light >> 4, light & 15)} (${light >> 4} sky, ${light & 15} block)`,
      `Biome: ${BIOME_NAMES[world.biomeName(bx, bz)]}`,
      `Day ${this.cycle.day + 1} · ${this.cycle.clock()} · Moon: ${MOON_PHASE_NAMES[this.cycle.moonPhase]}`,
      this.weatherSys.debugLine(),
      `Mobs within 64: ${near.hostile} hostile · ${near.passive} passive${this.net ? ' (server)' : ''}`,
      '',
      `${GAME_MODE_NAMES[this.mode]} · ${p.flying ? 'Flying' : p.onGround ? 'On ground' : 'Airborne'}${p.sprinting ? ' · Sprinting' : ''}${p.inWater ? ' · In water' : ''}`,
      `Health ${this.stats.health} · Food ${this.stats.hunger} (sat ${this.stats.saturation.toFixed(1)}) · Air ${this.stats.air}`,
      `${this.audio.debugLine()} · enclosure ${this.audio.env.enclosure.toFixed(2)}`,
      ...(this.arcade ? [this.arcade.hitregLine()] : []),
    ], [
      mem ? `Mem: ${Math.round((mem.usedJSHeapSize / mem.totalJSHeapSize) * 100)}% ${(mem.usedJSHeapSize / 1048576).toFixed(0)}/${(mem.totalJSHeapSize / 1048576).toFixed(0)}MB` : 'Mem: n/a',
      `World blocks: ${(worldBlocks / 1e6).toFixed(2)}M (${(worldBlocks / 1048576).toFixed(1)} MB) · edited chunks ${world.edits.size}`,
      `Upload queue: ${stats.uploadQueue} · in flight ${stats.genInFlight}g/${stats.meshInFlight}m`,
      '',
      `CPU: ${navigator.hardwareConcurrency || '?'} threads`,
      `Display: ${window.innerWidth}x${window.innerHeight} @ ${this.renderer.three.getPixelRatio().toFixed(2)}x`
        + (this.dynamicResolution.enabled ? ` (dynamic ${Math.round(this.dynamicResolution.scale * 100)}%)` : ''),
      `${this.gpuName.replace(/^ANGLE \(|\)$/g, '').split(',').slice(0, 2).join(',')}`,
      '',
      `Targeted Block: ${target}`,
      ...(targetState ? [targetState] : []),
      `Holding: ${getItemDef(this.hotbar.selectedBlock)?.displayName ?? 'Empty hand'}`,
      `Seed: ${world.seed}`,
    ]);
  }
}
