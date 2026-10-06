import * as THREE from 'three';
import {
  ARCADE_AIR_ACCEL, ARCADE_SPEED_MULT, FireControl, KillFeed, SPAWN_PROTECTION, SPECTATE_KILLER_SECONDS, currentSpread, cycleSlot, cycleTarget,
  impactNormal, reloadProgress, spectateCandidates, spreadPixels,
} from '../modes/ArcadeLogic';
import { type GameTypeDef, type Team, TEAM_COLORS, gameTypeDef } from '../modes/GameTypes';
import { carriesFlag, eventView, phaseBanner } from '../modes/ModeView';
import { LOADOUT_PRESETS } from '../modes/Loadouts';
import {
  DEFAULT_PRIMARY, DEFAULT_SECONDARY, PLAYER_MAX_HEALTH, PRIMARY_WEAPONS, RESPAWN_SECONDS, SECONDARY_WEAPONS, type WeaponDef, fireInterval, weaponDef,
} from '../modes/Weapons';
import type { ClientMessage, MatchInfo, MatchPhase, ModeState, RosterEntry, ServerMessage } from '../net/protocol';
import type { RemotePlayers } from '../net/RemotePlayers';
import type { Player } from '../player/Player';
import { PHYSICS } from '../player/Physics';
import type { Particles } from '../rendering/Particles';
import { Tracers } from '../rendering/Tracers';
import { WEAPON_MODELS } from '../rendering/WeaponModels';
import { WeaponViewmodel } from '../rendering/WeaponViewmodel';
import { ArcadeHud, type ScoreboardContext } from '../ui/ArcadeHud';
import { ModeHud } from '../ui/ModeHud';
import { ModeVisuals } from '../rendering/ModeVisuals';
import { BLOCK } from '../world/BlockRegistry';
import { type RayHit, createRayHit, raycast } from '../world/Raycast';
import type { AudioEngine } from './Audio';
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
const tmpAim = { x: 0, y: 0, z: 0 };
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

  readonly info: MatchInfo;
  readonly teams: boolean;
  /** The game type's rules as data (HUD widgets, respawn rule, loadout rule). */
  readonly def: GameTypeDef;
  /** Objective HUD (zones, flags, rounds, ladder) and the flags/zone rings in the world. */
  readonly modeHud: ModeHud;
  readonly modeVisuals = new ModeVisuals();
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
  private primary = DEFAULT_PRIMARY;
  private pendingPrimary = '';
  private secondary = DEFAULT_SECONDARY;
  private pendingSecondary = '';
  private slot: Slot = 0;
  private prevSlot: Slot = 1;
  private readonly weaponIds: [string, string, string] = [DEFAULT_PRIMARY, DEFAULT_SECONDARY, 'knife'];
  private readonly ammo: AmmoState[] = [0, 1, 2].map(() => ({ mag: 0, reloading: false, since: 0 }));
  private pending = 0;
  private readonly trigger = new FireControl();
  private ads = 0;
  private kick = 0;
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
    this.players.set(d.selfId, { name: d.selfName, team: '' });
    this.hud.onLoadout = (id, secondary) => this.selectLoadout(id, secondary);
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
  }

  removePlayer(id: number): void {
    this.players.delete(id);
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
        if (msg.reloading && !a.reloading) a.since = now;
        if (msg.reloading && !a.reloading) this.d.audio.playReload(weaponDef(this.weaponIds[msg.slot])?.reloadSec ?? 1);
        a.mag = msg.mag;
        a.reloading = msg.reloading;
        if (msg.slot === this.slot) this.pending = 0;
        break;
      }
      case 'shot': this.onShot(msg); break;
      case 'hit':
        this.hud.showHit(msg.killed ? 'kill' : msg.head ? 'head' : 'hit');
        if (msg.killed) this.d.audio.playKillDing();
        else this.d.audio.playHitMarker(msg.head);
        this.d.feedback?.haptic(msg.killed ? 0.4 : 0, msg.killed ? 0.6 : 0.35, msg.killed ? 120 : 45);
        break;
      case 'damaged': {
        this.hud.addDamage(msg.dx, msg.dz, now);
        this.hurt = 1;
        this.hurtSide = Math.sin(Math.atan2(msg.dx, msg.dz) - this.d.player.yaw) >= 0 ? 1 : -1;
        this.d.audio.playHurt();
        this.d.feedback?.haptic(0.7, 0.5, 200);
        break;
      }
      case 'kill': this.onKill(msg, now); break;
      case 'matchend': this.onMatchEnd(msg, now); break;
      case 'holds': this.d.remote.setWeapon(msg.id, msg.weapon); break;
      case 'gear': this.onGear(msg); break;
      case 'mode': this.onMode(msg.state); break;
      case 'event': this.onEvent(msg, now); break;
      default: break;
    }
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
    this.phase = msg.phase;
    this.matchText = msg.text ?? '';
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
    this.leader = best ? `Leader: ${best.name}${this.def.ladder ? ` (level ${(best.pts ?? 0) + 1})` : ''}` : '';
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
    this.primary = weaponDef(msg.primary) ? msg.primary : DEFAULT_PRIMARY;
    this.pendingPrimary = '';
    this.pendingSecondary = '';
    this.secondary = msg.secondary && weaponDef(msg.secondary) ? msg.secondary : DEFAULT_SECONDARY;
    this.weaponIds[0] = this.primary;
    this.weaponIds[1] = this.secondary;
    this.health = msg.health;
    this.hud.setHealth(this.health);
    this.protect = SPAWN_PROTECTION;
    this.fillAmmo();
    this.equipSlot(0, false);
    this.viewmodel.visible = true;
    this.hurt = 0;
    this.kick = 0;
    this.trigger.reset();
    if (this.ended && this.phase !== 'ended') {
      this.ended = false;
      this.hud.setMatchEnd(null);
    }
    this.d.audio.playSpawn();
    this.lastNow = now;
  }

  /** The mode swapped our weapons while we live (gun game level): new primary/secondary, full magazines, primary in hand. */
  private onGear(msg: Extract<ServerMessage, { t: 'gear' }>): void {
    if (weaponDef(msg.primary)) { this.primary = msg.primary; this.weaponIds[0] = msg.primary; }
    if (msg.secondary && weaponDef(msg.secondary)) { this.secondary = msg.secondary; this.weaponIds[1] = msg.secondary; }
    this.fillAmmo();
    this.equipSlot(0, false);
    this.d.audio.playSpawn();
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
    const who = msg.id ? (msg.id === this.d.selfId ? 'You' : this.nameOf(msg.id)) : '';
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
    this.hud.setSpectating('', '');
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
      this.hud.setSpectating('', '');
      return;
    }
    this.hud.setSpectating(this.nameOf(this.watchId), this.candidates.length > 1 ? 'Left click: next player   Right click: previous' : '');
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
    let title = 'Draw';
    let color = '#ffffff';
    if (msg.winnerTeam) {
      title = `${msg.winnerTeam === 'red' ? 'Red' : 'Blue'} team wins!`;
      color = TEAM_COLORS[msg.winnerTeam];
    } else if (msg.winnerId) {
      title = msg.winnerId === this.d.selfId ? 'You win!' : `${this.nameOf(msg.winnerId)} wins!`;
      color = msg.winnerId === this.d.selfId ? '#ffd23f' : '#ffffff';
    }
    // The final kill may have been yours: the end screen replaces the death screen and spectating.
    this.d.remote.setSpectated(0);
    this.hud.setDeath(null);
    this.endTitle = { title, color };
    this.hud.setMatchEnd({ title, color, roster: this.roster, ctx: this.boardContext() });
  }

  private onShot(msg: Extract<ServerMessage, { t: 'shot' }>): void {
    const p = this.d.player;
    // Own shots are drawn the moment they are fired; the server's echo would double them.
    if (msg.id === this.d.selfId) return;
    const dist = Math.hypot(msg.ox - p.x, msg.oy - p.eyeY, msg.oz - p.z);
    gunAt.x = msg.ox; gunAt.y = msg.oy; gunAt.z = msg.oz;
    this.d.audio.playGun(msg.weapon, 1, gunAt);
    if (dist < 60) this.d.feedback?.caption(msg.weapon === 'knife' ? 'Knife swings' : 'Gunshot', msg.ox, msg.oz);
    if (msg.weapon === 'knife') return;
    // Muzzle of the shooter: ahead of the eye, a bit to the right and down.
    let dx = msg.ex - msg.ox, dy = msg.ey - msg.oy, dz = msg.ez - msg.oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const rx = -dz, rz = dx;
    const rl = Math.hypot(rx, rz) || 1;
    const sx = msg.ox + dx * 0.8 + (rx / rl) * 0.22, sy = msg.oy + dy * 0.8 - 0.28, sz = msg.oz + dz * 0.8 + (rz / rl) * 0.22;
    this.tracers.spawn(sx, sy, sz, msg.ex, msg.ey, msg.ez);
    this.impact(msg.ex, msg.ey, msg.ez, dx, dy, dz, dist);
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
      this.d.audio.playBulletImpact(1 - listenerDistance / 40, gunAt);
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
    this.viewmodel.setWeapon(w);
    this.hud.setWeapon(w);
    this.refreshSlots();
    this.pending = 0;
    this.trigger.delay(this.lastNow, 0.28);
    if (announce) this.d.send({ t: 'weapon', slot });
  }

  /** Slot names for the HUD; the primary shows the weapon you carry (or will carry next life). */
  private slotNames(): string[] {
    return this.weaponIds.map((id) => weaponDef(id)?.name ?? id);
  }

  /** Chooses the weapons for the next life: a primary, and optionally a secondary (class presets). */
  selectLoadout(id: string, secondary?: string): void {
    if (!PRIMARY_WEAPONS.includes(id)) return;
    this.pendingPrimary = id;
    if (secondary !== undefined && SECONDARY_WEAPONS.includes(secondary)) {
      this.pendingSecondary = secondary;
      this.d.send({ t: 'loadout', primary: id, secondary });
    } else this.d.send({ t: 'loadout', primary: id });
    this.hud.markLoadout(id, this.pendingSecondary || this.secondary);
  }

  selectPrimary(id: string): void {
    this.selectLoadout(id);
  }

  openLoadout(): void {
    if (this.def.loadout === 'ladder') return; // gun game: the ladder chooses
    this.loadoutOpen = true;
    this.hud.showLoadout(this.pendingPrimary || this.primary, !this.dead, this.pendingSecondary || this.secondary);
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
    this.d.send({ t: 'reload', slot: this.slot });
    this.d.audio.playReload(w.reloadSec);
  }

  /** Aim direction from the view angles, written into `out`. */
  private aim(out: { x: number; y: number; z: number }): void {
    const p = this.d.player;
    const c = Math.cos(p.pitch);
    out.x = -Math.sin(p.yaw) * c;
    out.y = Math.sin(p.pitch);
    out.z = -Math.cos(p.yaw) * c;
  }

  private shoot(): void {
    const w = this.weapon;
    const p = this.d.player;
    this.aim(tmpAim);
    const ox = p.x, oy = p.eyeY, oz = p.z;
    this.d.send({ t: 'fire', slot: this.slot, ox, oy, oz, dx: tmpAim.x, dy: tmpAim.y, dz: tmpAim.z, ads: this.ads > 0.5 });
    this.pending++;
    // Predicted effects.
    this.d.audio.playGun(w.id, 1);
    this.viewmodel.fire();
    this.kick = Math.min(0.12, this.kick + (w.recoil * Math.PI) / 180 * 0.8);
    const spread = currentSpread(w, this.ads, Math.hypot(p.vx, p.vz) > 0.5, !p.onGround);
    const pellets = Math.min(w.pellets, 5);
    // Muzzle in the world: the weapon model's muzzle transformed by the view model's pose is close
    // enough to a fixed offset from the camera.
    const cam = this.d.cam.camera;
    const model = WEAPON_MODELS[w.id];
    const e = this.ads * this.ads * (3 - 2 * this.ads);
    // The weapon is drawn with its own 62° camera: scale the sideways offsets to the main camera's field of view.
    const k = 0.6009 / Math.tan((cam.fov * Math.PI) / 360);
    tmpV.set((0.18 * (1 - e) + model.muzzle[0] * 0.85) * k, (-0.18 * (1 - e) - model.sightY * e * 0.85 + model.muzzle[1] * 0.85) * k, -0.62 * (1 - e) + this.viewmodel.adsZ() * e + model.muzzle[2] * 0.85);
    cam.localToWorld(tmpV);
    const sx = tmpV.x, sy = tmpV.y, sz = tmpV.z;
    for (let i = 0; i < pellets; i++) {
      let dx = tmpAim.x, dy = tmpAim.y, dz = tmpAim.z;
      if (spread > 0.3 || w.pellets > 1) {
        const t = Math.tan((spread * Math.PI) / 180);
        const r = Math.sqrt(Math.random()) * t, ang = Math.random() * Math.PI * 2;
        const jx = Math.cos(ang) * r, jy = Math.sin(ang) * r;
        // Right and up of the view.
        const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
        dx += rx * jx; dz += rz * jx; dy += jy;
        const l = Math.hypot(dx, dy, dz);
        dx /= l; dy /= l; dz /= l;
      }
      const hit = raycast(this.d.getBlock, ox, oy, oz, dx, dy, dz, Math.min(w.maxRange, 160), this.ray);
      const dist = hit.hit ? hit.distance : Math.min(w.maxRange, 160);
      this.tracers.spawn(sx, sy, sz, ox + dx * dist, oy + dy * dist, oz + dz * dist);
      if (hit.hit) {
        this.d.particles.spawnFace(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, hit.id, this.d.getLight(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz), 3);
      }
    }
  }

  private melee(): void {
    const p = this.d.player;
    this.aim(tmpAim);
    this.d.send({ t: 'fire', slot: this.slot, ox: p.x, oy: p.eyeY, oz: p.z, dx: tmpAim.x, dy: tmpAim.y, dz: tmpAim.z, ads: false });
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
      // On the death screen the number keys pick the next weapon (the loadout menu is B).
      for (let i = 0; i < LOADOUT_PRESETS.length; i++) if (input.wasPressed(`Digit${i + 1}`)) this.selectLoadout(LOADOUT_PRESETS[i].primary, LOADOUT_PRESETS[i].secondary);
    }

    const w = this.weapon;
    if (canAct) {
      if (w.slot === 'melee') {
        if (this.trigger.tryFire(now, fireInterval(w), false, input.leftDown, input.leftClicked)) this.melee();
      } else if (!ammo.reloading) {
        const mag = ammo.mag - this.pending;
        if (mag <= 0) {
          if (input.leftClicked) this.d.audio.playEmpty();
          if (input.leftDown) this.requestReload(now);
        } else if (w.burst && w.burstCycleSec) {
          if (this.trigger.tryBurst(now, fireInterval(w), w.burst, w.burstCycleSec, input.leftClicked)) this.shoot();
        } else if (this.trigger.tryFire(now, fireInterval(w), w.auto, input.leftDown, input.leftClicked)) {
          this.shoot();
        }
      }
    }

    // Aim down the sights.
    const wantAds = canAct && input.rightDown && w.zoom < 1 && !ammo.reloading;
    this.ads += ((wantAds ? 1 : 0) - this.ads) * Math.min(1, dt * 12);
    if (this.ads < 0.001 && !wantAds) this.ads = 0;
    const cam = this.d.cam;
    cam.zoom = 1 + (w.zoom - 1) * this.ads * this.ads * (3 - 2 * this.ads);
    this.kick *= Math.exp(-9 * dt);
    cam.kick = this.kick;
    this.hurt = Math.max(0, this.hurt - dt * 2);
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
    const scoped = WEAPON_MODELS[w.id].scope && this.ads > 0.92;
    hud.setScope(scoped);
    const spread = w.magazine === 0 ? 0.5 : currentSpread(w, this.ads, Math.hypot(p.vx, p.vz) > 0.5, !p.onGround);
    hud.setCrosshair(2 + spreadPixels(spread, this.d.cam.camera.fov, window.innerHeight), !scoped && !this.dead);
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
      c.scoreLimit = this.info.scoreLimit; c.selfKills = this.selfKills; c.leader = this.leader;
      c.text = this.matchText;
      const ladder = this.def.ladder;
      c.selfScore = ladder ? `${Math.min(this.selfPts + 1, ladder.length)}/${ladder.length}` : undefined;
      hud.setMatch(this.phase, left, c);
      const round = this.modeState?.kind === 'rounds' ? this.modeState.round : 1;
      hud.setBanner(this.phase === 'warmup' ? `Warm-up: match starts in ${Math.max(0, sec)}` : phaseBanner(this.phase, left, round));
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
      hud.setRespawn(wait, this.primary, this.pendingPrimary, this.secondary, this.pendingSecondary, this.def.loadout !== 'ladder');
      if (!this.ended) this.updateSpectate(f, input);
    }
    if (this.ended) hud.setNextMatch(this.endAt - now);
  }

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
    this.modeVisuals.dispose();
    this.tracers.clear();
    this.d.cam.kick = 0;
    this.d.cam.zoom = 1;
    this.d.cam.sprintFov = true;
    this.d.player.speedMultiplier = 1;
    this.d.player.airAccel = PHYSICS.AIR_ACCEL;
    this.d.remote.reviveAll();
    this.d.remote.setTagOcclusion(null);
  }
}

function keyLabel(code: string): string {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  return m ? m[1] : code === '' ? '-' : code.slice(0, 3);
}
