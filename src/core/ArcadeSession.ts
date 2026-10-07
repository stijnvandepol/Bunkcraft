import * as THREE from 'three';
import {
  ARCADE_AIR_ACCEL, ARCADE_SPEED_MULT, FireControl, KillFeed, RecoilState, SPAWN_PROTECTION, SPECTATE_KILLER_SECONDS, ScopeBreath, currentSpread,
  cycleSlot, cycleTarget, impactNormal, reloadProgress, spectateCandidates, spreadPixels, swayOffset,
} from '../modes/ArcadeLogic';
import { type GameTypeDef, type Team, TEAM_COLORS, gameTypeDef } from '../modes/GameTypes';
import { carriesFlag, eventView, localizeServerText, phaseBanner } from '../modes/ModeView';
import {
  type ClassSpec, DEFAULT_CLASS, LAST_CLASS_STORAGE_KEY, LOADOUT_PRESETS, loadSavedClass, saveClass, validateClass,
} from '../modes/Loadouts';
import {
  AIM_CLIMB, DEFAULT_PRIMARY, DEFAULT_SECONDARY, type OpticId, PLAYER_MAX_HEALTH, RESPAWN_SECONDS, type WeaponDef, adsTimeFor, fireInterval,
  isPerk, opticFor, opticZoom, switchDelayFor, weaponDef,
} from '../modes/Weapons';
import { type ClientMessage, type MatchInfo, type MatchPhase, type ModeState, type RosterEntry, SNAP_FLAG_ADS, type ServerMessage } from '../net/protocol';
import type { RemotePlayers } from '../net/RemotePlayers';
import type { Player } from '../player/Player';
import { PHYSICS } from '../player/Physics';
import type { Particles } from '../rendering/Particles';
import { Tracers } from '../rendering/Tracers';
import { muzzleFor } from '../rendering/WeaponModels';
import { WeaponViewmodel } from '../rendering/WeaponViewmodel';
import { ArcadeHud, type ScoreboardContext } from '../ui/ArcadeHud';
import { ModeHud } from '../ui/ModeHud';
import { MatchLobby } from '../ui/MatchLobby';
import { ModeVisuals } from '../rendering/ModeVisuals';
import { BLOCK } from '../world/BlockRegistry';
import { type RayHit, createRayHit, raycast } from '../world/Raycast';
import { type BulletTrace, type HitPart, createBulletTrace, rayPlayer, shotSpread, spreadDirection, spreadRandom, traceBullet } from '../modes/Hitscan';
import { HitregStats } from '../modes/HitregStats';
import type { AudioEngine } from './Audio';
import { type SurfaceLookup, surfaceLookup } from './audio/playerSounds';
import { BOLT_DELAY, MULTI_KILL_WINDOW, type MechKind, gunEarshot, medalFor, medalText, reloadSteps } from './audio/weaponSounds';
import { t } from '../ui/i18n';
import type { CameraController } from './Camera';
import type { Input } from './Input';
import { KB } from './Keybinds';

type Slot = 0 | 1 | 2;

interface AmmoState {
  mag: number;
  reloading: boolean;
  /** Clock time the reload began (for the reload bar and animation). */
  since: number;
}

export interface ArcadeDeps {
  send(msg: ClientMessage): void;
  audio: AudioEngine;
  player: Player;
  cam: CameraController;
  remote: RemotePlayers;
  particles: Particles;
  getBlock(x: number, y: number, z: number): number;
  /** Block state (slab half, stair facing): bullets stop only where a partial block's shape is. */
  getMeta?(x: number, y: number, z: number): number;
  getLight(x: number, y: number, z: number): number;
  selfId: number;
  selfName: string;
  info: MatchInfo;
  /** Captions (Subtitles option) and controller rumble. */
  feedback?: {
    caption(label: string, x: number, z: number): void;
    haptic(strong: number, weak: number, ms: number): void;
  };
  /** The server started a match on another map than this session was built for. */
  onMapChange?(map: string): void;
}

/** Per-frame values the game already has at hand. */
export interface ArcadeFrame {
  /** Seconds, same clock for every call (performance.now() / 1000). */
  now: number;
  dt: number;
  /** The player may act: playing, pointer locked. */
  controls: boolean;
  bobPhase: number;
  bobStrength: number;
  /** World brightness 0..1 at the player, for the weapon model. */
  light: number;
  aspect: number;
  /** Mouse movement this frame in pixels (weapon sway). */
  lookX: number;
  lookY: number;
}

/** Spectator camera: distance behind the watched player's head and the lift above it. */
const SPECTATE_DISTANCE = 3.2;

const tmpV = new THREE.Vector3();
const tmpMuzzle: [number, number, number] = [0, 0, 0];
const tmpSway = { x: 0, y: 0 };
const DEG = Math.PI / 180;
/** Seconds a weapon takes to come up after a switch (Quickdraw halves it). */
const EQUIP_SEC = 0.28;
/** Enemy footsteps: blocks of travel per footfall (running) and how far away they are tracked at all. */
const STRIDE = 2.1;
const STEP_TRACK_RANGE = 30;
/** Below this health the heartbeat plays. */
const LOW_HEALTH = 35;
/** At most this many scope glints at once. */
const MAX_GLINTS = 4;

/** Per remote player: footstep bookkeeping and what the server told about their gear. */
interface RemoteGear { x: number; z: number; y: number; acc: number; quiet: boolean; optic: OpticId; known: boolean }

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Glint texture: a hot white core with a cross flare (drawn once). */
function glintTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,250,210,0.8)');
  g.addColorStop(1, 'rgba(255,230,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = 'rgba(255,255,230,0.9)';
  ctx.fillRect(31, 0, 2, 64);
  ctx.fillRect(0, 31, 64, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
const tmpAim = { x: 0, y: 0, z: 0 };
const tmpDir: [number, number, number] = [0, 0, 0];
const tmpRand: [number, number] = [0, 0];
const tmpPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
/** Tracers drawn per shot at most (a shotgun's pellets are thinned out evenly). */
const MAX_TRACERS = 5;
/** Position handed to the audio engine for gunshots and impacts (read synchronously). */
const gunAt = { x: 0, y: 0, z: 0 };

/**
 * Client side of an arcade match (team deathmatch, free for all): holds the match state, your
 * health, ammo and weapons, the roster and kill feed, turns input into `fire`/`reload`/`weapon`
 * messages, and plays the effects. The server is authoritative for ammo, hits, health and kills;
 * the client only predicts the visuals (recoil, flash, tracer) of its own shots.
 */
export class ArcadeSession {
  readonly hud = new ArcadeHud();
  readonly viewmodel = new WeaponViewmodel();
  readonly tracers = new Tracers();
  /** Scope glints of enemies aiming at you through a scope (add to the scene). */
  readonly glints = new THREE.Group();
  private readonly glintSprites: THREE.Sprite[] = [];

  readonly info: MatchInfo;
  readonly teams: boolean;
  /** The game type's rules as data (HUD widgets, respawn rule, loadout rule). */
  readonly def: GameTypeDef;
  /** Objective HUD (zones, flags, rounds, ladder) and the flags/zone rings in the world. */
  readonly modeHud: ModeHud;
  readonly modeVisuals = new ModeVisuals();
  /** Realms pre-match lobby (warm-up panel) and the map vote after a match. */
  readonly lobby: MatchLobby;
  private modeState: ModeState | null = null;
  private matchText = '';
  private selfPts = 0;
  private carrying = false;
  phase: MatchPhase = 'warmup';
  private timeLeft = 0;
  private timeStamp = 0;
  private scores = { red: 0, blue: 0 };
  private roster: RosterEntry[] = [];
  private rosterVersion = 0;
  private shownRosterVersion = -1;
  private boardShown = false;
  private readonly players = new Map<number, { name: string; team: Team | '' }>();
  private readonly feed = new KillFeed();

  health = PLAYER_MAX_HEALTH;
  team: Team | '' = '';
  /** The class of this life (server's word), the one the server holds for the next life, and the saved custom class. */
  private cls: ClassSpec = { ...DEFAULT_CLASS };
  private nextClass: ClassSpec = { ...DEFAULT_CLASS };
  private custom: ClassSpec = { ...DEFAULT_CLASS };
  private slot: Slot = 0;
  private prevSlot: Slot = 1;
  private readonly weaponIds: [string, string, string] = [DEFAULT_PRIMARY, DEFAULT_SECONDARY, 'knife'];
  private readonly ammo: AmmoState[] = [0, 1, 2].map(() => ({ mag: 0, reloading: false, since: 0 }));
  private pending = 0;
  private readonly trigger = new FireControl();
  private ads = 0;
  private wantAds = false;
  private kick = 0;
  private readonly recoil = new RecoilState();
  private readonly breath = new ScopeBreath();
  /** Scope sway applied to the view so far (radians), and its clock. */
  private swayYaw = 0;
  private swayPitch = 0;
  private swayTime = 0;
  private scoped = false;
  /** Next reload step to play per slot, and the pending bolt cycle (time of the next stage, 0 = none). */
  private readonly reloadStep = [0, 0, 0];
  private boltAt = 0;
  private boltStage = 0;
  /** Kills this life and in the current multi-kill chain. */
  private streak = 0;
  private multi = 0;
  private lastKillAt = -1e9;
  private readonly gear = new Map<number, RemoteGear>();
  private readonly surfaceAt: SurfaceLookup;
  private readonly stepPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly stepAt = { x: 0, y: 0, z: 0 };
  private glintCount = 0;
  private frameNow = 0;
  /** Low health heartbeat: time of the next beat. */
  private nextBeat = 0;
  /**
   * Seeded spread (the server deals `ss` at the spawn): the index of the next shot, the client's shot counter (`seq`)
   * and whether the server sent a seed at all (an older server rolls its own spread; tracers are then a guess).
   */
  private spreadSeed = 0;
  private seeded = false;
  private shotN = 0;
  private fireSeq = 0;
  private readonly trace: BulletTrace = createBulletTrace();
  private readonly blocks = { getBlock: (x: number, y: number, z: number) => this.d.getBlock(x, y, z), getMeta: (x: number, y: number, z: number) => this.d.getMeta?.(x, y, z) ?? 0 };
  /** Shots this client fired at what its screen showed, and what the server said (hit registration statistics, F3 and QA). */
  readonly hitreg = new HitregStats();
  /** 0..1 camera hurt strength after taking damage, decaying. */
  hurt = 0;
  /** Side of the last hit (−1 left, 1 right) for the camera tilt. */
  hurtSide = 1;
  private protect = 0;

  dead = false;
  private deadAt = 0;
  /** Who killed us (for the first second of spectating) and whom the camera follows now (0 = nobody). */
  private killerId = 0;
  private watchId = 0;
  private readonly watchPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly candidates: number[] = [];
  private nextCandidates = 0;
  private ended = false;
  private endAt = 0;
  /** Title and colour of the end screen while it is up (redrawn when the final scores and roster arrive after `matchend`). */
  private endTitle: { title: string; color: string } | null = null;
  private lastNow = 0;
  private readonly ray: RayHit = createRayHit();
  private loadoutOpen = false;
  /** Key labels of the three weapon slots (follow the key binds). */
  private keyLabels: string[] = ['1', '2', '3'];
  private matchDirty = true;
  private lastClockSec = -1;
  private selfKills = 0;
  private leader = '';
  private readonly matchCtx = {
    selfId: 0, teams: false, scores: { red: 0, blue: 0 }, scoreLimit: 0, selfKills: 0, leader: '', text: '', selfScore: undefined as string | undefined,
  };

  constructor(private readonly d: ArcadeDeps) {
    this.info = d.info;
    this.def = gameTypeDef(d.info.type);
    this.teams = this.def.teams;
    this.modeHud = new ModeHud(this.def);
    this.hud.el.append(this.modeHud.el);
    this.lobby = new MatchLobby(this.def, d.selfId);
    this.lobby.onVote = (map) => this.d.send({ t: 'vote', map });
    this.hud.el.append(this.lobby.el);
    // The vote sits under the result in the match-end overlay.
    this.hud.el.querySelector('.arc-end')?.append(this.lobby.voteEl);
    this.players.set(d.selfId, { name: d.selfName, team: '' });
    this.surfaceAt = surfaceLookup(d.getBlock);
    this.custom = loadSavedClass(storage()) ?? { ...DEFAULT_CLASS };
    this.hud.setCustomClass(this.custom);
    this.hud.onClass = (c, custom) => this.chooseClass(c, custom);
    const tex = glintTexture();
    for (let i = 0; i < MAX_GLINTS; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
      s.visible = false;
      s.scale.setScalar(0.05);
      this.glintSprites.push(s);
      this.glints.add(s);
    }
    // The class chosen last time (any game) goes to the server at once: it applies right after spawning.
    if (this.def.loadout !== 'ladder') {
      const last = loadSavedClass(storage(), LAST_CLASS_STORAGE_KEY);
      if (last) this.sendClass(last);
    }
    this.hud.setHealth(this.health);
    this.equipSlot(0, false);
    this.fillAmmo();
    this.hud.setVisible(true);
    this.refreshSlots();
    d.remote.setTagOcclusion(d.getBlock);
  }

  // ---------------------------------------------------------------- game-facing state

  /** Movement multiplier for Player.speedMultiplier: always-sprint pace times the weapon's modifier. */
  get speedMultiplier(): number {
    // A flag carrier is slower (capture the flag); the server announces who carries in the mode state.
    const carry = this.carrying ? 1 - (this.def.params?.carrySlow ?? 0.1) : 1;
    return ARCADE_SPEED_MULT * this.weapon.moveSpeed * (1 - 0.2 * this.ads) * carry;
  }

  readonly airAccel = ARCADE_AIR_ACCEL;

  /** Aiming down the sights (the `pos` flag that lets enemies see a scope glint). */
  get aimFlags(): number {
    return this.ads > 0.5 ? SNAP_FLAG_ADS : 0;
  }

  /** The optic on the weapon in hand (the primary carries the class optic; others their own sights). */
  private get optic(): OpticId {
    return this.slot === 0 ? opticFor(this.weapon, this.cls.optic) : this.weapon.optics[0];
  }

  /** Look sensitivity scale: aiming through a zoom turns slower so aim stays precise. */
  get sensitivityScale(): number {
    return this.d.cam.zoom;
  }

  get weapon(): WeaponDef {
    return weaponDef(this.weaponIds[this.slot])!;
  }

  /** Is the loadout menu (mouse driven) open? */
  get menuOpen(): boolean {
    return this.loadoutOpen;
  }

  addPlayer(id: number, name: string, team: Team | ''): void {
    if (id === this.d.selfId) return;
    this.players.set(id, { name, team });
    this.d.remote.add(id, name, team);
    if (!this.gear.has(id)) this.gear.set(id, { x: 0, y: 0, z: 0, acc: 0, quiet: false, optic: 'iron', known: false });
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    this.gear.delete(id);
    this.d.remote.remove(id);
  }

  private readonly nameOfFn = (id: number): string => this.nameOf(id);
  private readonly selfRef: { team: Team | ''; id: number } = { team: '', id: 0 };

  private nameOf(id: number): string {
    return this.players.get(id)?.name ?? `Player ${id}`;
  }

  /** The weapon slot keys changed in the Key Binds screen. */
  setBindings(input: Input): void {
    this.keyLabels = [KB.WEAPON_1, KB.WEAPON_2, KB.WEAPON_3].map((k) => keyLabel(input.bound(k)));
    this.refreshSlots();
  }

  private refreshSlots(): void {
    this.hud.setSlots(this.slotNames(), this.slot, this.keyLabels);
  }

  // ---------------------------------------------------------------- server messages

  handle(msg: ServerMessage, now: number): void {
    switch (msg.t) {
      case 'match': this.onMatch(msg, now); break;
      case 'roster': this.onRoster(msg.players); break;
      case 'spawn': this.onSpawn(msg, now); break;
      case 'hp': this.onHealth(msg.health, now); break;
      case 'ammo': {
        const a = this.ammo[msg.slot];
        if (!a) break;
        if (msg.reloading && !a.reloading) { a.since = now; this.reloadStep[msg.slot] = 0; }
        a.mag = msg.mag;
        a.reloading = msg.reloading;
        if (msg.slot === this.slot) this.pending = 0;
        // The server's spread index after the shot `seq`, plus our shots still on the way.
        if (msg.sn !== undefined) this.shotN = msg.sn + (msg.seq !== undefined ? Math.max(0, this.fireSeq - 1 - msg.seq) : 0);
        if (msg.seq !== undefined) this.hitreg.acked(msg.seq, now);
        break;
      }
      case 'shot': this.onShot(msg); break;
      case 'hit':
        if (msg.seq !== undefined) this.hitreg.confirmed(msg.seq, msg.head);
        this.hud.showHit(msg.killed ? 'kill' : msg.head ? 'head' : 'hit', msg.damage, now);
        if (msg.killed) {
          this.d.audio.playKillDing(msg.head);
          this.onOwnKill(now);
        } else this.d.audio.playHitMarker(msg.head);
        this.d.feedback?.haptic(msg.killed ? 0.4 : 0, msg.killed ? 0.6 : 0.35, msg.killed ? 120 : 45);
        break;
      case 'damaged': {
        this.hud.addDamage(msg.dx, msg.dz, now);
        this.hurt = 1;
        this.hurtSide = Math.sin(Math.atan2(msg.dx, msg.dz) - this.d.player.yaw) >= 0 ? 1 : -1;
        this.d.audio.playHurt();
        this.d.audio.duck(0.3, 0.1);
        this.d.feedback?.haptic(0.7, 0.5, 200);
        break;
      }
      case 'kill': this.onKill(msg, now); break;
      case 'matchend': this.onMatchEnd(msg, now); break;
      case 'holds': this.onHolds(msg); break;
      case 'gear': this.onGear(msg); break;
      case 'mode': this.onMode(msg.state); break;
      case 'event': this.onEvent(msg, now); break;
      case 'vote': this.lobby.setVote(msg); break;
      default: break;
    }
  }

  /** A kill of ours: multi-kill chain and killstreak medals (sound, banner, caption). */
  private onOwnKill(now: number): void {
    this.streak++;
    this.multi = now - this.lastKillAt <= MULTI_KILL_WINDOW ? this.multi + 1 : 1;
    this.lastKillAt = now;
    const medal = medalFor(this.multi, this.streak);
    if (!medal) return;
    this.d.audio.playAnnouncer(medal);
    const text = medalText(medal);
    this.hud.showMedal(text, medal.startsWith('streak') ? '#ff9f2a' : '#ffd23f', now);
    this.d.feedback?.caption(text.toLowerCase().replace(/^./, (c) => c.toUpperCase()), this.d.player.x, this.d.player.z);
  }

  /** Another player's hands: weapon model with optic and suppressor; Ninja and scope for footsteps and glints. */
  private onHolds(msg: Extract<ServerMessage, { t: 'holds' }>): void {
    const def = weaponDef(msg.weapon);
    const optic: OpticId = def ? opticFor(def, msg.optic) : 'iron';
    this.d.remote.setWeapon(msg.id, msg.weapon, optic, msg.sup === 1);
    const g = this.gear.get(msg.id);
    if (g) { g.quiet = msg.quiet === 1; g.optic = optic; }
  }

  private onMatch(msg: Extract<ServerMessage, { t: 'match' }>, now: number): void {
    if (this.ended && msg.phase !== 'ended') {
      // A new match began: back to the arena view.
      this.ended = false;
      this.endTitle = null;
      this.hud.setMatchEnd(null);
      this.d.remote.reviveAll();
    }
    if (msg.info.map && msg.info.map !== (this.info.map ?? 'classic')) {
      this.d.onMapChange?.(msg.info.map);
      return;
    }
    if (msg.phase === 'live' && this.phase !== 'live' && this.phase !== 'ended') {
      this.d.audio.playStinger('start');
      this.d.feedback?.caption(t('arc.cap.matchStarts'), this.d.player.x, this.d.player.z);
    }
    this.phase = msg.phase;
    this.matchText = localizeServerText(msg.text ?? '');
    this.timeLeft = msg.timeLeft;
    this.timeStamp = now;
    this.scores = msg.scores;
    this.matchDirty = true;
    this.refreshEnd();
  }

  /** The server sends the final `match` and `roster` right after `matchend`: show those numbers on the end screen. */
  private refreshEnd(): void {
    if (this.ended && this.endTitle) this.hud.setMatchEnd({ ...this.endTitle, roster: this.roster, ctx: this.boardContext() });
  }

  private onRoster(players: RosterEntry[]): void {
    this.roster = players;
    this.rosterVersion++;
    this.matchDirty = true;
    this.refreshEnd();
    let best: RosterEntry | null = null;
    this.selfKills = 0;
    for (const p of players) {
      if (!best || (p.pts ?? 0) > (best.pts ?? 0) || ((p.pts ?? 0) === (best.pts ?? 0) && p.kills > best.kills)) best = p;
      if (p.id === this.d.selfId) { this.selfKills = p.kills; this.selfPts = p.pts ?? 0; }
    }
    this.leader = !best ? '' : this.def.ladder ? t('arc.leaderLevel', best.name, (best.pts ?? 0) + 1) : t('arc.leader', best.name);
    for (const p of players) {
      this.players.set(p.id, { name: p.name, team: p.team });
      if (p.id === this.d.selfId) this.setTeam(p.team);
      else this.d.remote.setTeam(p.id, p.team);
    }
  }

  private setTeam(team: Team | ''): void {
    if (team === this.team) return;
    this.team = team;
    this.viewmodel.setSleeve(team ? (team === 'red' ? '#8e2a24' : '#244a8e') : '#4f5a3a');
  }

  private onSpawn(msg: Extract<ServerMessage, { t: 'spawn' }>, now: number): void {
    const p = this.d.player;
    p.setPosition(msg.x, msg.y, msg.z);
    p.yaw = msg.yaw;
    p.pitch = 0;
    p.fallDistance = 0;
    p.landedFall = 0;
    this.setTeam(msg.team);
    this.dead = false;
    this.endSpectate();
    this.hud.setDeath(null);
    this.applyGear(msg.primary, msg.secondary, msg.optic, msg.perk);
    this.seeded = msg.ss !== undefined;
    this.spreadSeed = msg.ss ?? 0;
    this.health = msg.health;
    this.hud.setHealth(this.health);
    this.protect = SPAWN_PROTECTION;
    this.fillAmmo();
    this.equipSlot(0, false);
    this.viewmodel.visible = true;
    this.hurt = 0;
    this.kick = 0;
    this.trigger.reset();
    this.recoil.reset();
    this.breath.reset();
    this.streak = 0;
    this.multi = 0;
    if (this.ended && this.phase !== 'ended') {
      this.ended = false;
      this.hud.setMatchEnd(null);
    }
    this.d.audio.playSpawn();
    this.lastNow = now;
  }

  /** The mode swapped our weapons while we live (gun game level): new primary/secondary, full magazines, primary in hand. */
  private onGear(msg: Extract<ServerMessage, { t: 'gear' }>): void {
    this.applyGear(msg.primary, msg.secondary, msg.optic, msg.perk);
    this.fillAmmo();
    this.equipSlot(0, false);
    this.d.audio.playSpawn();
  }

  /** The server's word on our weapons (spawn, gear): primary, secondary, optic and perk. */
  private applyGear(primary: string, secondary: string | undefined, optic: string | undefined, perk: string | undefined): void {
    const p = weaponDef(primary) ? primary : DEFAULT_PRIMARY;
    const s = secondary && weaponDef(secondary) ? secondary : this.cls.secondary || DEFAULT_SECONDARY;
    this.cls = { primary: p, secondary: s, optic: opticFor(weaponDef(p)!, optic), perk: isPerk(perk) ? perk : 'none' };
    this.weaponIds[0] = p;
    this.weaponIds[1] = s;
  }

  /** New objective state from the server: markers, panels, world flags and rings, the carrier slow-down. */
  private onMode(state: ModeState): void {
    this.modeState = state;
    this.modeHud.setState(state);
    this.modeVisuals.setState(state);
    this.carrying = state.kind === 'ctf' && carriesFlag(state.flags, this.d.selfId);
    this.matchDirty = true;
  }

  private onEvent(msg: Extract<ServerMessage, { t: 'event' }>, now: number): void {
    const who = msg.id ? (msg.id === this.d.selfId ? t('arc.you') : this.nameOf(msg.id)) : '';
    const v = eventView(msg.kind, msg.team ?? '', this.team, msg.text ?? '', who, msg.id === this.d.selfId);
    const color = msg.team ? TEAM_COLORS[msg.team] : '#ffff55';
    // Ladder steps of other players are not worth a banner.
    if (v.text) this.modeHud.toast(v.text, color, now);
    if (v.text || msg.id === this.d.selfId) this.d.audio.playModeCue(v.cue);
  }

  /** Position of a player for markers and carried flags: yourself or the interpolated remote pose. */
  private readonly carrierPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  readonly carrierPos = (id: number, out: THREE.Vector3): boolean => {
    if (id === this.d.selfId) {
      if (this.dead) return false;
      const p = this.d.player;
      out.set(p.x, p.y, p.z);
      return true;
    }
    if (!this.d.remote.pose(id, this.carrierPose)) return false;
    out.set(this.carrierPose.x, this.carrierPose.y, this.carrierPose.z);
    return true;
  };

  private onHealth(hp: number, now: number): void {
    this.health = hp;
    this.hud.setHealth(hp);
    if (hp <= 0 && !this.dead) this.die('', '', false, '', now);
  }

  private onKill(msg: Extract<ServerMessage, { t: 'kill' }>, now: number): void {
    const killer = this.players.get(msg.killer), victim = this.players.get(msg.victim);
    this.feed.add({
      killer: this.nameOf(msg.killer), victim: this.nameOf(msg.victim),
      killerTeam: killer?.team ?? '', victimTeam: victim?.team ?? '',
      weapon: msg.weapon, head: msg.head, born: now,
    });
    this.hud.setKillFeed(this.feed.entries, this.d.selfName);
    if (msg.victim === this.d.selfId) {
      this.killerId = msg.killer !== this.d.selfId ? msg.killer : 0;
      this.watchId = this.killerId;
      this.die(this.nameOf(msg.killer), msg.weapon, msg.head, killer?.team ?? '', now);
    } else this.d.remote.markDead(msg.victim, now);
  }

  private die(killer: string, weapon: string, head: boolean, team: Team | '', now: number): void {
    if (this.dead && killer === '') return;
    const first = !this.dead;
    this.dead = true;
    this.streak = 0;
    this.scoped = false;
    this.hud.setScope(false);
    if (first) {
      this.deadAt = now;
      this.nextCandidates = 0;
    }
    this.health = 0;
    this.hud.setHealth(0);
    this.hud.setDeath({ killer, weapon, head, killerTeam: team });
    this.ads = 0;
    this.viewmodel.visible = false;
  }

  // ---------------------------------------------------------------- spectating after death

  /** Players the camera may follow: the living teammates (tdm) or everybody else (ffa). */
  private fillCandidates(): void {
    spectateCandidates(this.players, this.d.selfId, this.team, this.teams, (id) => this.d.remote.isAlive(id), this.candidates);
  }

  /** Left click = next player, right click = previous (wrapping). */
  private cycleWatch(dir: 1 | -1): void {
    this.fillCandidates();
    this.watchId = cycleTarget(this.candidates, this.watchId, dir) || this.watchId;
  }

  private endSpectate(): void {
    this.watchId = 0;
    this.killerId = 0;
    this.d.remote.setSpectated(0);
    this.hud.setSpectating('', false);
  }

  /** Per frame while dead: keeps a valid target, handles the cycle clicks and updates the HUD line. */
  private updateSpectate(f: ArcadeFrame, input: Input): void {
    const now = f.now;
    const remote = this.d.remote;
    // The candidate list is refreshed a few times a second (it walks the player map).
    if (now >= this.nextCandidates) {
      this.nextCandidates = now + 0.25;
      this.fillCandidates();
    }
    if (now - this.deadAt >= SPECTATE_KILLER_SECONDS) {
      // After the first second the killer only stays when the rules allow watching them (ffa; in tdm
      // they are an enemy), and a target that died or left is replaced.
      const allowed = this.watchId !== 0 && remote.isAlive(this.watchId) && (!this.teams || this.players.get(this.watchId)?.team === this.team);
      if (!allowed) {
        this.watchId = this.candidates.length > 0 ? this.candidates[0] : 0;
      }
      if (f.controls) {
        if (input.leftClicked) this.cycleWatch(1);
        else if (input.rightClicked) this.cycleWatch(-1);
      }
    } else if (this.watchId !== 0 && !remote.isAlive(this.watchId)) {
      this.watchId = 0;
    }
    const watching = this.watchId !== 0 && remote.pose(this.watchId, this.watchPose);
    remote.setSpectated(watching ? this.watchId : 0);
    if (!watching) {
      this.hud.setSpectating('', false);
      return;
    }
    this.hud.setSpectating(this.nameOf(this.watchId), this.candidates.length > 1);
  }

  /**
   * While dead the camera follows the watched player from behind (a chase view, pulled in where
   * blocks are in the way). Returns whether it took over the camera this frame.
   */
  applySpectateCamera(camera: THREE.PerspectiveCamera): boolean {
    if (!this.dead || this.ended || this.watchId === 0) return false;
    const pose = this.watchPose;
    if (!this.d.remote.pose(this.watchId, pose)) return false;
    const c = Math.cos(pose.pitch);
    const fx = -Math.sin(pose.yaw) * c, fy = Math.sin(pose.pitch), fz = -Math.cos(pose.yaw) * c;
    const hx = pose.x, hy = pose.y + 1.7, hz = pose.z;
    const hit = raycast(this.d.getBlock, hx, hy, hz, -fx, -fy + 0.12, -fz, SPECTATE_DISTANCE, this.ray);
    const dist = hit.hit ? Math.max(0.4, hit.distance - 0.3) : SPECTATE_DISTANCE;
    camera.position.set(hx - fx * dist, hy - fy * dist + 0.12 * dist, hz - fz * dist);
    camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
    return true;
  }

  private onMatchEnd(msg: Extract<ServerMessage, { t: 'matchend' }>, now: number): void {
    this.ended = true;
    this.matchDirty = true;
    this.phase = 'ended';
    this.endAt = now + msg.restartIn;
    let title = t('arc.end.draw');
    let color = '#ffffff';
    if (msg.winnerTeam) {
      title = msg.winnerTeam === 'red' ? t('arc.end.redWins') : t('arc.end.blueWins');
      color = TEAM_COLORS[msg.winnerTeam];
    } else if (msg.winnerId) {
      title = msg.winnerId === this.d.selfId ? t('arc.end.youWin') : t('arc.end.wins', this.nameOf(msg.winnerId));
      color = msg.winnerId === this.d.selfId ? '#ffd23f' : '#ffffff';
    }
    // The final kill may have been yours: the end screen replaces the death screen and spectating.
    this.d.remote.setSpectated(0);
    this.hud.setDeath(null);
    this.endTitle = { title, color };
    const won = msg.winnerTeam ? msg.winnerTeam === this.team : msg.winnerId === this.d.selfId;
    const draw = !msg.winnerTeam && !msg.winnerId;
    this.d.audio.playStinger(draw ? 'draw' : won ? 'win' : 'lose');
    this.d.feedback?.caption(draw ? t('arc.cap.draw') : won ? t('arc.cap.victory') : t('arc.cap.defeat'), this.d.player.x, this.d.player.z);
    this.hud.setMatchEnd({ title, color, roster: this.roster, ctx: this.boardContext() });
  }

  private onShot(msg: Extract<ServerMessage, { t: 'shot' }>): void {
    const p = this.d.player;
    // Own shots are drawn the moment they are fired; the server's echo would double them.
    if (msg.id === this.d.selfId) return;
    const dist = Math.hypot(msg.ox - p.x, msg.oy - p.eyeY, msg.oz - p.z);
    gunAt.x = msg.ox; gunAt.y = msg.oy; gunAt.z = msg.oz;
    const sup = msg.sup === 1;
    this.d.audio.playGun(msg.weapon, 1, gunAt, sup);
    if (dist < gunEarshot(msg.weapon, sup) * 0.8) {
      this.d.feedback?.caption(t(msg.weapon === 'knife' ? 'arc.cap.knife' : sup ? 'arc.cap.suppressed' : dist > 45 ? 'arc.cap.distant' : 'arc.cap.gunshot'), msg.ox, msg.oz);
    }
    if (msg.weapon === 'knife') return;
    // Muzzle of the shooter: ahead of the eye, a bit to the right and down.
    let dx = msg.ex - msg.ox, dy = msg.ey - msg.oy, dz = msg.ez - msg.oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const rx = -dz, rz = dx;
    const rl = Math.hypot(rx, rz) || 1;
    const sx = msg.ox + dx * 0.8 + (rx / rl) * 0.22, sy = msg.oy + dy * 0.8 - 0.28, sz = msg.oz + dz * 0.8 + (rz / rl) * 0.22;
    this.tracers.spawn(sx, sy, sz, msg.ex, msg.ey, msg.ez);
    // Glass on the way (the same trace the server ran) and the impact where it ended.
    const tr = traceBullet(this.blocks, msg.ox, msg.oy, msg.oz, dx, dy, dz, len + 0.05, this.trace);
    this.passFx(tr, len + 0.01, msg.ox, msg.oy, msg.oz, dx, dy, dz, Math.hypot(msg.ex - p.x, msg.ey - p.eyeY, msg.ez - p.z));
    this.impact(msg.ex, msg.ey, msg.ez, dx, dy, dz, Math.hypot(msg.ex - p.x, msg.ey - p.eyeY, msg.ez - p.z));
    // A bullet passing close by: crack and whizz.
    this.nearMiss(msg.ox, msg.oy, msg.oz, dx, dy, dz, len, msg.weapon);
  }

  /** Supersonic crack and whizz when another player's bullet passes within a couple of blocks of your head. */
  private nearMiss(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number, weapon: string): void {
    if (this.dead) return;
    const p = this.d.player;
    const hx = p.x - ox, hy = p.eyeY - oy, hz = p.z - oz;
    const along = hx * dx + hy * dy + hz * dz;
    if (along < 1.5 || along > len + 0.5) return; // behind the shooter, or the bullet stopped before reaching us
    const cx = hx - dx * along, cy = hy - dy * along, cz = hz - dz * along;
    const miss = Math.hypot(cx, cy, cz);
    if (miss > 2.2) return;
    gunAt.x = ox + dx * along; gunAt.y = oy + dy * along; gunAt.z = oz + dz * along;
    this.d.audio.playBulletWhizz(1 - miss / 2.2, gunAt, weapon);
  }

  /** Puff of block fragments where a bullet ended on a block. */
  private impact(ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, listenerDistance: number): void {
    const bx = Math.floor(ex + dx * 0.02), by = Math.floor(ey + dy * 0.02), bz = Math.floor(ez + dz * 0.02);
    const id = this.d.getBlock(bx, by, bz);
    if (id === BLOCK.AIR || id === BLOCK.UNLOADED || id === BLOCK.WATER) return;
    impactNormal(ex, ey, ez, dx, dy, dz, tmpAim);
    this.d.particles.spawnFace(bx, by, bz, tmpAim.x, tmpAim.y, tmpAim.z, id, this.d.getLight(bx + tmpAim.x, by + tmpAim.y, bz + tmpAim.z), 3);
    if (listenerDistance < 40) {
      gunAt.x = ex; gunAt.y = ey; gunAt.z = ez;
      this.d.audio.playBulletImpact(1 - listenerDistance / 40, gunAt, id);
    }
  }

  // ---------------------------------------------------------------- weapons and input

  private fillAmmo(): void {
    for (let i = 0; i < 3; i++) {
      const def = weaponDef(this.weaponIds[i])!;
      this.ammo[i].mag = def.magazine;
      this.ammo[i].reloading = false;
    }
    this.pending = 0;
  }

  private equipSlot(slot: Slot, announce: boolean): void {
    if (announce && slot === this.slot) return;
    if (announce) this.prevSlot = this.slot;
    this.slot = slot;
    const w = this.weapon;
    const equip = switchDelayFor(this.cls.perk, EQUIP_SEC);
    this.viewmodel.setWeapon(w, this.optic, this.cls.perk === 'suppressor');
    this.viewmodel.setEquipTime(equip);
    this.hud.setWeapon(w);
    this.refreshSlots();
    this.pending = 0;
    this.boltAt = 0;
    this.trigger.delay(this.lastNow, equip);
    if (announce) {
      this.d.send({ t: 'weapon', slot });
      this.d.audio.playMech('switch');
    }
  }

  /** Slot names for the HUD; the primary shows the weapon you carry (or will carry next life). */
  private slotNames(): string[] {
    return this.weaponIds.map((id) => weaponDef(id)?.name ?? id);
  }

  /** Tells the server the class for the next life (it applies at once right after a spawn). */
  private sendClass(c: ClassSpec): void {
    this.nextClass = validateClass(c);
    const n = this.nextClass;
    this.d.send({ t: 'loadout', primary: n.primary, secondary: n.secondary, optic: n.optic, perk: n.perk });
    this.hud.markClass(n);
  }

  /** A class from the menu or the death screen; the custom class is saved too, and the choice is remembered. */
  chooseClass(c: ClassSpec, custom: boolean): void {
    if (this.def.loadout === 'ladder') return;
    if (custom) {
      this.custom = validateClass(c);
      saveClass(storage(), this.custom);
    }
    this.sendClass(c);
    saveClass(storage(), this.nextClass, LAST_CLASS_STORAGE_KEY);
  }

  openLoadout(): void {
    if (this.def.loadout === 'ladder') return; // gun game: the ladder chooses
    this.loadoutOpen = true;
    this.hud.showLoadout(this.nextClass, !this.dead);
  }

  closeLoadout(): void {
    this.loadoutOpen = false;
    this.hud.hideLoadout();
  }

  private requestReload(now: number): void {
    const w = this.weapon;
    const a = this.ammo[this.slot];
    if (w.magazine === 0 || a.reloading || a.mag >= w.magazine) return;
    a.reloading = true;
    a.since = now;
    this.reloadStep[this.slot] = 0;
    this.d.send({ t: 'reload', slot: this.slot });
  }

  /** Aim direction from the view angles, written into `out`. */
  private aim(out: { x: number; y: number; z: number }): void {
    const p = this.d.player;
    const c = Math.cos(p.pitch);
    out.x = -Math.sin(p.yaw) * c;
    out.y = Math.sin(p.pitch);
    out.z = -Math.cos(p.yaw) * c;
  }

  /** What the shooter's screen shows right now: the moving / airborne flags of the spread. */
  private get moving(): boolean {
    const p = this.d.player;
    return Math.hypot(p.vx, p.vz) > 0.5;
  }

  private shoot(now: number): void {
    const w = this.weapon;
    const p = this.d.player;
    this.aim(tmpAim);
    const ox = p.x, oy = p.eyeY, oz = p.z;
    const ads = this.ads > 0.5, mv = this.moving, air = !p.onGround;
    const n = this.shotN++, seq = this.fireSeq++;
    // The server rewinds the targets to the snapshot moment this screen shows (lag compensation).
    const rk = this.d.remote.renderTick(now);
    this.d.send({
      t: 'fire', slot: this.slot, ox, oy, oz, dx: tmpAim.x, dy: tmpAim.y, dz: tmpAim.z, ads, seq,
      ...(rk >= 0 ? { rk: Math.round(rk * 1000) / 1000 } : {}), ...(mv ? { mv } : {}), ...(air ? { air } : {}),
    });
    this.pending++;
    // Predicted effects.
    const sup = this.cls.perk === 'suppressor';
    this.d.audio.playGun(w.id, 1, undefined, sup);
    this.viewmodel.fire();
    this.kick = Math.min(0.12, this.kick + (w.recoil * Math.PI) / 180 * 0.8);
    if (w.bolt) { this.boltAt = now + BOLT_DELAY; this.boltStage = 0; }
    // Muzzle in the world: the weapon model's muzzle transformed by the view model's pose is close
    // enough to a fixed offset from the camera.
    const cam = this.d.cam.camera;
    const e = this.ads * this.ads * (3 - 2 * this.ads);
    // The weapon is drawn with its own 62° camera: scale the sideways offsets to the main camera's field of view.
    const k = 0.6009 / Math.tan((cam.fov * Math.PI) / 360);
    const mz = muzzleFor(w.id, sup, tmpMuzzle);
    const sightY = this.viewmodel.sightLine;
    tmpV.set((0.18 * (1 - e) + mz[0] * 0.85) * k, (-0.18 * (1 - e) - sightY * e * 0.85 + mz[1] * 0.85) * k, -0.62 * (1 - e) + this.viewmodel.adsZ() * e + mz[2] * 0.85);
    cam.localToWorld(tmpV);
    const sx = tmpV.x, sy = tmpV.y, sz = tmpV.z;
    // The same pellets the server will test (seeded spread), each traced through the same blocks and against the
    // other players as drawn: the tracer ends where the bullet does.
    const spread = shotSpread(w, ads, mv, air);
    const every = Math.max(1, Math.ceil(w.pellets / MAX_TRACERS));
    let claimed = -1, claimedHead = false;
    for (let i = 0; i < w.pellets; i++) {
      if (this.seeded) spreadRandom(this.spreadSeed, n, i, tmpRand);
      else { tmpRand[0] = Math.random(); tmpRand[1] = Math.random(); }
      spreadDirection(tmpAim.x, tmpAim.y, tmpAim.z, spread, tmpRand[0], tmpRand[1], tmpDir);
      const dx = tmpDir[0], dy = tmpDir[1], dz = tmpDir[2];
      const tr = traceBullet(this.blocks, ox, oy, oz, dx, dy, dz, Math.min(w.maxRange, 160), this.trace);
      const body = this.firstPlayer(ox, oy, oz, dx, dy, dz, tr.t);
      const dist = body ? body.t : tr.t;
      if (body && claimed < 0) { claimed = body.id; claimedHead = body.part === 'head'; }
      if (i % every === 0) this.tracers.spawn(sx, sy, sz, ox + dx * dist, oy + dy * dist, oz + dz * dist);
      // Glass and leaves on the way burst; the block that stopped the bullet puffs.
      this.passFx(tr, dist, ox, oy, oz, dx, dy, dz, 0);
      if (!body && tr.blocked) {
        this.d.particles.spawnFace(tr.x, tr.y, tr.z, tr.nx, tr.ny, tr.nz, tr.id, this.d.getLight(tr.x + tr.nx, tr.y + tr.ny, tr.z + tr.nz), 3);
        if (i % every === 0) {
          gunAt.x = ox + dx * dist; gunAt.y = oy + dy * dist; gunAt.z = oz + dz * dist;
          this.d.audio.playBulletImpact(Math.max(0.2, 1 - dist / 40), gunAt, tr.id);
        }
      }
    }
    this.hitreg.fired(seq, now, claimed, claimedHead);
    // The aim climbs along the weapon's pattern (after the shot went out with the old aim).
    const r = this.recoil.kick(now, w.recoil, w.recoilX, w.pattern, this.ads, AIM_CLIMB, w.auto ? fireInterval(w) : 0);
    p.pitch = Math.min(Math.PI / 2 - 0.001, p.pitch + r.pitch * DEG);
    p.yaw -= r.yaw * DEG;
  }

  /** The nearest other player (as drawn now) on the ray before `maxT`, or null. Teammates block bullets too here: they do not on the server. */
  private firstPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { id: number; t: number; part: HitPart } | null {
    let best: { id: number; t: number; part: HitPart } | null = null;
    for (const [id, info] of this.players) {
      if (id === this.d.selfId || (this.teams && info.team === this.team) || !this.d.remote.isAlive(id) || !this.d.remote.pose(id, tmpPose)) continue;
      const hit = rayPlayer(ox, oy, oz, dx, dy, dz, tmpPose.x, tmpPose.y, tmpPose.z, tmpPose.yaw, tmpPose.pitch);
      if (hit && hit.t < maxT && (!best || hit.t < best.t)) best = { id, t: hit.t, part: hit.part };
    }
    return best;
  }

  /** Glass shards, leaf bits and a clink where a bullet went through see-through blocks before `end`. */
  private passFx(tr: BulletTrace, end: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, listener: number): void {
    for (let j = 0; j < tr.thin; j++) {
      if (tr.thinT[j] >= end) break;
      const bx = tr.thinX[j], by = tr.thinY[j], bz = tr.thinZ[j], id = tr.thinId[j];
      impactNormal(ox + dx * tr.thinT[j], oy + dy * tr.thinT[j], oz + dz * tr.thinT[j], dx, dy, dz, tmpAim);
      this.d.particles.spawnFace(bx, by, bz, tmpAim.x, tmpAim.y, tmpAim.z, id, this.d.getLight(bx, by, bz), 6);
      if (listener < 40) {
        gunAt.x = ox + dx * tr.thinT[j]; gunAt.y = oy + dy * tr.thinT[j]; gunAt.z = oz + dz * tr.thinT[j];
        this.d.audio.playBulletImpact(Math.max(0.2, 1 - listener / 40), gunAt, id);
      }
    }
  }

  private melee(now: number): void {
    const p = this.d.player;
    this.aim(tmpAim);
    this.shotN++; // the server counts every shot, the knife's too
    const seq = this.fireSeq++;
    const rk = this.d.remote.renderTick(now);
    this.d.send({ t: 'fire', slot: this.slot, ox: p.x, oy: p.eyeY, oz: p.z, dx: tmpAim.x, dy: tmpAim.y, dz: tmpAim.z, ads: false, seq, ...(rk >= 0 ? { rk: Math.round(rk * 1000) / 1000 } : {}) });
    this.viewmodel.swingKnife();
    this.d.audio.playGun('knife', 1);
  }

  // ---------------------------------------------------------------- per frame

  /** Per frame: input, weapon state, viewmodel, tracers and HUD. Allocation-free except for message events. */
  update(f: ArcadeFrame, input: Input): void {
    const { now, dt } = f;
    this.lastNow = now;
    const canAct = f.controls && !this.dead && !this.ended && !this.loadoutOpen;
    const ammo = this.ammo[this.slot];

    // A local reload that the server never confirmed (or that is long over) must not hang forever.
    for (let i = 0; i < 3; i++) {
      const a = this.ammo[i];
      if (a.reloading && now - a.since > (weaponDef(this.weaponIds[i])?.reloadSec ?? 1) + 1) a.reloading = false;
    }

    if (canAct) {
      for (let i = 0; i < 3; i++) if (input.actionPressed(KB.WEAPON_1 + i)) this.equipSlot(i as Slot, true);
      if (input.wheel !== 0) this.equipSlot(cycleSlot(this.slot, input.wheel), true);
      if (input.actionPressed(KB.QUICK_SWITCH)) this.equipSlot(this.prevSlot, true);
      if (input.actionPressed(KB.RELOAD)) this.requestReload(now);
    } else if (this.dead && f.controls && this.def.loadout !== 'ladder') {
      // On the death screen the number keys pick the next class (presets, then the custom class; the menu is B).
      for (let i = 0; i < LOADOUT_PRESETS.length; i++) if (input.wasPressed(DIGITS[i])) this.chooseClass(LOADOUT_PRESETS[i], false);
      if (input.wasPressed(DIGITS[LOADOUT_PRESETS.length])) this.chooseClass(this.custom, true);
    }

    const w = this.weapon;
    if (canAct) {
      if (w.slot === 'melee') {
        if (this.trigger.tryFire(now, fireInterval(w), false, input.leftDown, input.leftClicked)) this.melee(now);
      } else if (!ammo.reloading) {
        const mag = ammo.mag - this.pending;
        if (mag <= 0) {
          this.trigger.cancelBurst();
          if (input.leftClicked) this.d.audio.playEmpty();
          if (input.leftDown) this.requestReload(now);
        } else if (w.burst && w.burstCycleSec) {
          if (this.trigger.tryBurst(now, fireInterval(w), w.burst, w.burstCycleSec, input.leftClicked)) this.shoot(now);
        } else if (this.trigger.tryFire(now, fireInterval(w), w.auto, input.leftDown, input.leftClicked)) {
          this.shoot(now);
        }
      }
    }

    // Aim down the sights: linear in the weapon's aim time (optic and perk), eased for the view.
    const optic = this.optic;
    const wantAds = canAct && input.rightDown && w.zoom < 1 && !ammo.reloading;
    if (wantAds !== this.wantAds) {
      this.wantAds = wantAds;
      this.d.audio.playMech(wantAds ? 'adsin' : 'adsout');
    }
    const step = dt / Math.max(0.05, adsTimeFor(w, optic, this.cls.perk));
    this.ads = wantAds ? Math.min(1, this.ads + step) : Math.max(0, this.ads - step * 1.4);
    const cam = this.d.cam;
    const eased = this.ads * this.ads * (3 - 2 * this.ads);
    cam.zoom = 1 + (opticZoom(w, optic) - 1) * eased;
    this.updateAimFeel(f, input, w, optic);
    this.updateMechanics(now, w, ammo);
    this.updateRemotes(f);
    this.kick *= Math.exp(-9 * dt);
    // Aimed down the sights the sights are the aim point: the kick goes into the weapon model, not the view.
    cam.kick = this.kick * (1 - eased);
    this.hurt = Math.max(0, this.hurt - dt * 2);
    // Low health: a heartbeat that cuts through (and quickens below 20).
    if (!this.dead && !this.ended && this.health > 0 && this.health < LOW_HEALTH && now >= this.nextBeat) {
      this.d.audio.playHeartbeat(0.45 + 0.55 * (1 - this.health / LOW_HEALTH));
      this.nextBeat = now + (this.health < 20 ? 0.72 : 0.95);
    }
    this.protect = Math.max(0, this.protect - dt);

    const reload = ammo.reloading ? reloadProgress(now - ammo.since, w.reloadSec) : -1;
    this.viewmodel.update(dt, this.ads, reload, f.bobPhase, f.bobStrength, f.lookX, f.lookY, f.light, f.aspect);
    this.tracers.update(dt);
    this.updateHud(f, w, ammo, reload, input);
  }

  private boardContext(): ScoreboardContext {
    return { selfId: this.d.selfId, teams: this.teams, scores: this.scores, scoreColumn: this.def.scoreColumn };
  }

  private updateHud(f: ArcadeFrame, w: WeaponDef, ammo: AmmoState, reload: number, input: Input): void {
    const hud = this.hud;
    const p = this.d.player;
    const now = f.now;
    hud.setAmmo(w, ammo.mag, reload);
    const scoped = this.scoped;
    hud.setScope(scoped, scoped ? this.breath.breath : -1, this.breath.holding, this.breath.spent);
    const spread = w.magazine === 0 ? 0.5 : currentSpread(w, this.ads, Math.hypot(p.vx, p.vz) > 0.5, !p.onGround);
    // Aimed down the sights the sights (or the reticle) are the crosshair.
    hud.setCrosshair(2 + spreadPixels(spread, this.d.cam.camera.fov, window.innerHeight), !scoped && !this.dead && this.ads < 0.6);
    // The camera kick tilts the view up while the aim stays: draw the crosshair (and hit marker) where bullets go.
    const kick = this.d.cam.appliedKick;
    hud.setAimOffset(kick > 0 ? (Math.tan(kick) / Math.tan((this.d.cam.camera.fov * Math.PI) / 360)) * (window.innerHeight / 2) : 0);
    this.hitreg.update(now);
    hud.setProtection(this.protect);
    hud.frame(now, p.yaw);
    if (this.feed.prune(now)) hud.setKillFeed(this.feed.entries, this.d.selfName);

    // Timer, scores and warm-up banner: only when the second ticks over or the match changed.
    const left = this.phase === 'ended' ? 0 : this.timeLeft - (now - this.timeStamp);
    const sec = Math.ceil(left);
    if (sec !== this.lastClockSec || this.matchDirty) {
      this.lastClockSec = sec;
      this.matchDirty = false;
      const c = this.matchCtx;
      c.selfId = this.d.selfId; c.teams = this.teams; c.scores = this.scores;
      // Gun game shows the leader in its ladder panel: not twice.
      c.scoreLimit = this.info.scoreLimit; c.selfKills = this.selfKills; c.leader = this.def.ladder ? '' : this.leader;
      c.text = this.matchText;
      const ladder = this.def.ladder;
      c.selfScore = ladder ? `${Math.min(this.selfPts + 1, ladder.length)}/${ladder.length}` : undefined;
      hud.setMatch(this.phase, left, c);
      const round = this.modeState?.kind === 'rounds' ? this.modeState.round : 1;
      hud.setBanner(this.phase === 'warmup' ? this.lobby.banner(this.roster, sec) : phaseBanner(this.phase, left, round));
      if (ladder) this.modeHud.setLadder(this.selfPts, ladder, this.leader);
      if (this.def.hud?.includes('zones') || this.def.hud?.includes('flags')) this.modeHud.setScores(this.scores.red, this.scores.blue, this.info.scoreLimit);
    }
    const me = this.selfRef;
    me.team = this.team; me.id = this.d.selfId;
    this.modeHud.frame(now, this.d.cam.camera, window.innerWidth, window.innerHeight, me, this.nameOfFn, this.carrierPos);
    this.modeVisuals.update(now, this.carrierPos);

    // Scoreboard while the key is held.
    const showBoard = f.controls && input.actionDown(KB.SCOREBOARD) && !this.ended;
    if (showBoard !== this.boardShown || (showBoard && this.shownRosterVersion !== this.rosterVersion)) {
      this.boardShown = showBoard;
      this.shownRosterVersion = this.rosterVersion;
      hud.setScoreboard(showBoard, this.roster, this.boardContext());
    }

    if (this.dead) {
      const rule = this.def.respawn;
      const wait = rule?.rule === 'never' ? -1 : (rule?.seconds ?? RESPAWN_SECONDS) - (now - this.deadAt);
      hud.setRespawn(wait, this.nextClass, this.def.loadout !== 'ladder');
      if (!this.ended) this.updateSpectate(f, input);
    }
    if (this.ended) hud.setNextMatch(this.endAt - now);
    this.lobby.update(this.phase, left, this.roster, this.info.map, this.ended);
    if (this.ended && this.lobby.voting && f.controls) {
      for (let i = 0; i < 3; i++) if (input.actionPressed(KB.WEAPON_1 + i)) this.lobby.pick(i);
    }
  }

  /**
   * Scope sway with breath control and recoil recovery, applied to the real view (the server takes the
   * aim from yaw and pitch, so what you see is where you shoot). Allocation-free.
   */
  private updateAimFeel(f: ArcadeFrame, input: Input, w: WeaponDef, optic: OpticId): void {
    const p = this.d.player;
    const dt = f.dt;
    this.scoped = optic === 'scope' && this.ads > 0.92 && !this.dead;
    const moving = Math.hypot(p.vx, p.vz) > 0.5 || !p.onGround;
    const cue = this.breath.update(dt, f.now, this.scoped, f.controls && input.actionDown(KB.SPRINT), moving);
    if (cue) this.d.audio.playBreath(cue === 'hold');
    // Sway: a figure-eight around the aim while scoped, fading out when not.
    this.swayTime += dt;
    let tx = 0, ty = 0;
    if (this.scoped) {
      swayOffset(this.swayTime, this.breath.amp, tmpSway);
      tx = tmpSway.x * DEG; ty = tmpSway.y * DEG;
    } else {
      tx = this.swayYaw * Math.max(0, 1 - dt * 8);
      ty = this.swayPitch * Math.max(0, 1 - dt * 8);
    }
    p.yaw += tx - this.swayYaw;
    p.pitch += ty - this.swayPitch;
    this.swayYaw = tx;
    this.swayPitch = ty;
    // Recoil recovery once the trigger rests.
    const rec = this.recoil.recover(f.now, dt);
    if (rec !== 0) p.pitch += rec * DEG;
    const limit = Math.PI / 2 - 0.001;
    p.pitch = Math.max(-limit, Math.min(limit, p.pitch));
    void w;
  }

  /** Reload steps (mag out, mag in, bolt) as the reload progresses, and the bolt of a bolt-action after a shot. */
  private updateMechanics(now: number, w: WeaponDef, ammo: AmmoState): void {
    const slot = this.slot;
    if (ammo.reloading) {
      const steps = reloadSteps(w.id);
      const t = (now - ammo.since) / Math.max(0.1, w.reloadSec);
      let i = this.reloadStep[slot];
      while (i < steps.length && steps[i][0] <= t) this.d.audio.playMech(steps[i++][1] as MechKind);
      this.reloadStep[slot] = i;
    }
    if (this.boltAt > 0 && now >= this.boltAt) {
      if (this.boltStage === 0) {
        this.d.audio.playMech('boltback');
        this.viewmodel.cycleBolt();
        this.boltStage = 1;
        this.boltAt = now + 0.2;
      } else {
        this.d.audio.playMech('boltfwd');
        this.boltAt = 0;
      }
    }
  }

  /** Enemy and teammate footsteps (per surface, positional; Ninja only up close) and scope glints. */
  private updateRemotes(f: ArcadeFrame): void {
    this.frameNow = f.now;
    this.glintCount = 0;
    this.gear.forEach(this.remoteStep);
    for (let i = this.glintCount; i < MAX_GLINTS; i++) this.glintSprites[i].visible = false;
  }

  private readonly remoteStep = (g: RemoteGear, id: number): void => {
    const remote = this.d.remote;
    const pose = this.stepPose;
    if (!remote.isAlive(id) || !remote.pose(id, pose)) { g.known = false; return; }
    const me = this.d.player;
    const dx = pose.x - me.x, dz = pose.z - me.z;
    if (!g.known) { g.x = pose.x; g.y = pose.y; g.z = pose.z; g.acc = 0; g.known = true; return; }
    const moved = Math.hypot(pose.x - g.x, pose.z - g.z);
    const dy = pose.y - g.y;
    g.x = pose.x; g.y = pose.y; g.z = pose.z;
    if (moved > 3) { g.acc = 0; return; } // a teleport (spawn)
    if (Math.abs(dy) < 0.08 && Math.abs(dx) < STEP_TRACK_RANGE && Math.abs(dz) < STEP_TRACK_RANGE) {
      g.acc += moved;
      if (g.acc >= STRIDE) {
        g.acc -= STRIDE;
        const surface = this.surfaceAt(Math.floor(pose.x), Math.floor(pose.y - 0.1), Math.floor(pose.z)) ?? 'stone';
        const at = this.stepAt;
        at.x = pose.x; at.y = pose.y; at.z = pose.z;
        this.d.audio.playPlayerStep(surface, at, g.quiet);
        if (!g.quiet && Math.hypot(dx, dz) < 18) this.d.feedback?.caption(t('arc.cap.footsteps'), pose.x, pose.z);
      }
    } else g.acc = 0;
    // Scope glint: an enemy aiming through a scope roughly at us shines.
    if (g.optic !== 'scope' || this.glintCount >= MAX_GLINTS || (remote.flagsOf(id) & SNAP_FLAG_ADS) === 0) return;
    const info = this.players.get(id);
    if (this.teams && info && info.team === this.team) return;
    const dist = Math.hypot(dx, pose.y - me.y, dz);
    if (dist < 8) return;
    const c = Math.cos(pose.pitch);
    const fx = -Math.sin(pose.yaw) * c, fy = Math.sin(pose.pitch), fz = -Math.cos(pose.yaw) * c;
    const facing = (-dx * fx + (me.eyeY - pose.y - 1.62) * fy - dz * fz) / dist;
    if (facing < 0.93) return;
    const s = this.glintSprites[this.glintCount++];
    const flicker = 0.75 + 0.25 * Math.sin(this.frameNow * 23 + id);
    s.position.set(pose.x + fx * 0.55, pose.y + 1.55 + fy * 0.55, pose.z + fz * 0.55);
    s.scale.setScalar(0.035 * flicker * (0.6 + 0.4 * (facing - 0.93) / 0.07));
    s.visible = true;
  };

  /** Draws the first-person weapon (after the world pass). */
  render(three: THREE.WebGLRenderer): void {
    this.viewmodel.render(three);
  }

  /** Hide all HUD pieces (F1) without losing state. */
  setHudVisible(v: boolean): void {
    this.hud.setVisible(v);
  }

  /** Leaving the game: drop effects and remote state. */
  dispose(): void {
    this.hud.reset();
    this.modeHud.reset();
    this.lobby.reset();
    this.modeVisuals.dispose();
    this.tracers.clear();
    for (const s of this.glintSprites) s.visible = false;
    this.d.cam.kick = 0;
    this.d.cam.zoom = 1;
    this.d.cam.sprintFov = true;
    this.d.player.speedMultiplier = 1;
    this.d.player.airAccel = PHYSICS.AIR_ACCEL;
    this.d.remote.reviveAll();
    this.d.remote.setTagOcclusion(null);
  }
}

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

function keyLabel(code: string): string {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  return m ? m[1] : code === '' ? '-' : code.slice(0, 3);
}
