import * as THREE from 'three';
import { Mob } from '../entities/Mob';
import { MOB_TYPES } from '../entities/MobTypes';
import { type Team, TEAM_COLORS } from '../modes/GameTypes';
import { type OpticId, RESPAWN_SECONDS } from '../modes/Weapons';
import { createWeaponMaterial, weaponGeometry } from '../rendering/WeaponModels';
import { h } from '../ui/dom';
import { type RayHit, createRayHit, raycast } from '../world/Raycast';
import { SNAP_FLAG_CROUCH, SNAP_FLAG_SLIDE, SNAP_FLAG_STALE, type SnapshotEntry } from './protocol';

/** Render other players this far in the past so there are always two snapshots to blend (20 Hz default; arcade sets its own). */
const INTERPOLATION_DELAY = 0.1;
/** Past the newest snapshot a player keeps moving at its last velocity for at most this long (a late packet), then holds. */
const MAX_EXTRAPOLATE = 0.1;
/** Snapshot clock: how much of each arrival-time error is corrected (the rest is jitter of the page's event loop). */
const CLOCK_GAIN = 0.1;
/** A gap this long (or a clock this far off) restarts the snapshot clock at the arrival time. */
const CLOCK_RESET = 0.5;
/** Arcade culling: a player marked stale (out of view) is hidden this long after the mark... */
const STALE_HIDE = 0.3;
/** ...or when no snapshot mentioned it for this long. */
const ABSENT_HIDE = 0.5;
/** Arcade name tags need a clear line from the camera to the head, re-checked this often per player (s), within this range. */
const LOS_INTERVAL = 0.1;
const ARCADE_TAG_RANGE = 60;
const TAG_RANGE = 64;
/** Seconds for a tag to fade fully in or out. */
const TAG_FADE = 0.18;
/** The ray for the line-of-sight check ends at the head, 1.7 above the feet. */
const HEAD_HEIGHT = 1.7;
/** Body lean (radians) of a sliding (back, legs forward) and a crouching (forward) remote player. */
const POSE_SLIDE_LEAN = 0.6;
const POSE_CROUCH_LEAN = -0.3;
/** A shot player lies on the ground this long, then is hidden until the respawn. */
const CORPSE_SECONDS = 1.4;

interface State { t: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number }

interface Remote {
  id: number;
  name: string;
  mob: Mob;
  buffer: State[];
  tag: HTMLDivElement;
  /** Last written tag position/visibility (skips style writes and string building when unchanged). */
  tagX: number;
  tagY: number;
  tagShown: boolean;
  team: Team | '';
  /** Arcade: the weapon in the hands (third-person model) and its mesh. */
  weaponId: string;
  weapon: THREE.Mesh;
  /** Arcade: time of death (seconds, same clock as `update`), or −1 when alive. */
  deadAt: number;
  /** Corpse hidden, waiting for the respawn. */
  hidden: boolean;
  /** Arcade tags: last line-of-sight result, when it was checked and the current fade (0..1). */
  los: boolean;
  losAt: number;
  tagAlpha: number;
  tagOpacity: number;
  /** Arcade culling: the server marked this player out of view (time of the mark, −1 = in view). */
  staleAt: number;
  /** Time of the last fresh snapshot entry. */
  lastSeen: number;
  /** Hidden because it is out of view (model, weapon and tag). */
  culled: boolean;
}

const tmp = new THREE.Vector3();
const tmpBase = new THREE.Matrix4();
const tmpLocal = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpScale = new THREE.Vector3(1, 1, 1);
const weaponScale = new THREE.Vector3(1.15, 1.15, 1.15);
const ARM_PIVOT = new THREE.Vector3(6 / 16, 22 / 16, 0);

/**
 * Other players: snapshot buffers with ~100 ms interpolation, drawn with the shared
 * mob renderer (player model, limb swing from movement) plus HTML name tags.
 */
export class RemotePlayers {
  private readonly players = new Map<number, Remote>();
  /** Same players as a flat array: iterating the map every frame would allocate an iterator. */
  private readonly list: Remote[] = [];
  readonly el: HTMLDivElement;
  /** Mobs to hand to the MobRenderer. */
  readonly mobs: Mob[] = [];
  /** Third-person weapons in the players' hands (arcade): add to the scene. */
  readonly weapons = new THREE.Group();
  private readonly weaponMaterial = createWeaponMaterial();
  /** Arcade: block lookup for the line-of-sight check; null = every tag is always shown (sandbox). */
  private occluder: ((x: number, y: number, z: number) => number) | null = null;
  private lastUpdate = 0;
  private readonly losRay: RayHit = createRayHit();
  /** Arcade: the player the camera is following after our death (its tag stays hidden), 0 = none. */
  private spectated = 0;
  /** Seconds in the past other players are drawn (two snapshot intervals). */
  interpDelay = INTERPOLATION_DELAY;
  /**
   * Snapshot clock: the server sends snapshots at a steady tick, but the page handles a message only when its event
   * loop gets to it (up to a frame late). Stamping samples with the raw arrival time turns that into speed jitter, so
   * each snapshot is stamped on a steady clock (last stamp + whole tick intervals) that drifts slowly towards arrival.
   */
  private clock = -1;
  private tick = 0.05;
  private lastArrival = -1;

  constructor() {
    this.el = h('div', { class: 'nametags' });
    this.weaponMaterial.color.setScalar(0.92);
  }

  /**
   * Arcade name tags: nobody's tag is drawn through walls. A tag shows only with a clear block line
   * from the camera to the head (teammates included) and fades in and out. Pass null to turn it off.
   */
  setTagOcclusion(getBlock: ((x: number, y: number, z: number) => number) | null): void {
    this.occluder = getBlock;
  }

  add(id: number, name: string, team: Team | '' = ''): void {
    if (this.players.has(id)) return;
    const mob = new Mob(MOB_TYPES.player);
    mob.persistent = true;
    const tag = h('div', { class: 'nametag', text: name });
    this.el.append(tag);
    const weapon = new THREE.Mesh(undefined, this.weaponMaterial);
    weapon.matrixAutoUpdate = false;
    weapon.frustumCulled = false;
    weapon.visible = false;
    this.weapons.add(weapon);
    const r: Remote = {
      id, name, mob, buffer: [], tag, tagX: NaN, tagY: NaN, tagShown: true, team: '', weaponId: '', weapon, deadAt: -1, hidden: false,
      los: true, losAt: -1, tagAlpha: 1, tagOpacity: 1, staleAt: -1, lastSeen: -1e9, culled: false,
    };
    this.players.set(id, r);
    this.list.push(r);
    this.mobs.push(mob);
    if (team) this.setTeam(id, team);
  }

  remove(id: number): void {
    const r = this.players.get(id);
    if (!r) return;
    r.tag.remove();
    r.weapon.removeFromParent();
    this.players.delete(id);
    this.list.splice(this.list.indexOf(r), 1);
    const i = this.mobs.indexOf(r.mob);
    if (i >= 0) this.mobs.splice(i, 1);
  }

  /** Arcade: team shirt and head band on the model, team colour on the name tag. */
  setTeam(id: number, team: Team | ''): void {
    const r = this.players.get(id);
    if (!r || r.team === team) return;
    r.team = team;
    r.tag.style.color = team ? TEAM_COLORS[team] : '';
    // The model type is fixed per Mob: swap in one of the right type and keep the pose state.
    const old = r.mob;
    const mob = new Mob(MOB_TYPES[team === 'red' ? 'player_red' : team === 'blue' ? 'player_blue' : 'player']);
    mob.persistent = true;
    mob.setPosition(old.x, old.y, old.z);
    mob.yaw = mob.prevYaw = old.yaw;
    mob.holding = old.holding;
    mob.limbSwing = mob.prevLimbSwing = old.limbSwing;
    mob.limbAmount = old.limbAmount;
    mob.health = old.health;
    mob.deathTime = old.deathTime;
    r.mob = mob;
    const i = this.mobs.indexOf(old);
    if (i >= 0) this.mobs[i] = mob;
  }

  /** Arcade: the weapon this player holds (a weapon id, its optic, a suppressor); unknown ids leave the hands empty. */
  setWeapon(id: number, weaponId: string, optic: OpticId = 'iron', sup = false): void {
    const r = this.players.get(id);
    const key = `${weaponId}|${optic}|${sup ? 1 : 0}`;
    if (!r || r.weaponId === key) return;
    r.weaponId = key;
    const geo = weaponGeometry(weaponId, optic, sup);
    if (geo) r.weapon.geometry = geo;
    r.mob.holding = geo !== null;
  }

  /** Arcade: this player was shot; the body drops and disappears until the respawn. */
  markDead(id: number, now: number): void {
    const r = this.players.get(id);
    if (!r) return;
    r.deadAt = now;
    r.mob.health = 0;
  }

  /** Arcade: forget deaths and weapons (new match, leaving). */
  reviveAll(): void {
    for (const r of this.list) this.revive(r);
  }

  private revive(r: Remote): void {
    r.deadAt = -1;
    r.mob.health = r.mob.type.health;
    r.mob.deathTime = 0;
    if (r.hidden) {
      r.hidden = false;
      this.syncListed(r);
    }
  }

  /** The model is drawn unless it is a hidden corpse or out of view. */
  private syncListed(r: Remote): void {
    const i = this.mobs.indexOf(r.mob);
    const want = !r.hidden && !r.culled;
    if (want && i < 0) this.mobs.push(r.mob);
    else if (!want && i >= 0) this.mobs.splice(i, 1);
  }

  /** Arcade: the camera follows this player (0 = nobody): their name tag is not drawn. */
  setSpectated(id: number): void {
    this.spectated = id;
  }

  /** Arcade: whether the player is up and has a known position (they can be spectated). */
  isAlive(id: number): boolean {
    const r = this.players.get(id);
    return !!r && r.buffer.length > 0 && r.deadAt < 0 && !r.hidden && !r.culled;
  }

  /** Arcade: the newest snapshot flags of a player (SNAP_FLAG_*), 0 when unknown. */
  flagsOf(id: number): number {
    const r = this.players.get(id);
    return r && r.buffer.length > 0 ? r.buffer[r.buffer.length - 1].flags : 0;
  }

  /** Arcade: interpolated pose of a player (eye at y + 1.62 is up to the caller); false when unknown. */
  pose(id: number, out: { x: number; y: number; z: number; yaw: number; pitch: number }): boolean {
    const r = this.players.get(id);
    if (!r || r.buffer.length === 0) return false;
    out.x = r.mob.x; out.y = r.mob.y; out.z = r.mob.z;
    out.yaw = r.mob.yaw;
    out.pitch = -r.mob.headPitch;
    return true;
  }

  /** Arcade: where a player stands (for sounds and tracers); false when unknown. */
  position(id: number, out: THREE.Vector3): boolean {
    const r = this.players.get(id);
    if (!r || r.buffer.length === 0) return false;
    out.set(r.mob.x, r.mob.y, r.mob.z);
    return true;
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  get count(): number {
    return this.players.size;
  }

  /** The time stamp for a snapshot that arrived at `now` (see `clock`). */
  private stamp(now: number): number {
    const gap = now - this.lastArrival;
    this.lastArrival = now;
    if (this.clock < 0 || gap > CLOCK_RESET) return (this.clock = now);
    // The tick interval is the long-run average gap (one snapshot per server tick; arcade servers tick faster).
    if (gap < 3 * this.tick) this.tick = Math.min(0.2, Math.max(0.004, this.tick + (gap - this.tick) * 0.02));
    // Each snapshot is one tick after the last, however late the page handled it. Far off (the server stalled or
    // skipped, a culled arcade player came back): start again from the arrival time, like the server's own clock.
    const expected = this.clock + this.tick;
    this.clock = Math.abs(now - expected) > 2 * this.tick ? now : expected + (now - expected) * CLOCK_GAIN;
    return this.clock;
  }

  snapshot(entries: SnapshotEntry[], selfId: number, now: number): void {
    now = this.stamp(now);
    for (const [id, x, y, z, yaw, pitch, flags] of entries) {
      if (id === selfId) continue;
      const r = this.players.get(id);
      if (!r) continue;
      if (flags & SNAP_FLAG_STALE) {
        // Out of view (arcade): keep the last position, fade out; no new samples.
        if (r.staleAt < 0) r.staleAt = now;
        continue;
      }
      // Back in view after a gap: start a fresh buffer instead of gliding through the wall.
      if (r.staleAt >= 0 || now - r.lastSeen > ABSENT_HIDE) r.buffer.length = 0;
      r.staleAt = -1;
      r.lastSeen = now;
      if (r.culled) { r.culled = false; this.syncListed(r); }
      r.buffer.push({ t: now, x, y, z, yaw, pitch, flags });
      if (r.buffer.length > 30) r.buffer.shift();
    }
  }

  update(now: number, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const renderTime = now - this.interpDelay;
    const dtTag = Math.min(0.25, Math.max(0, now - this.lastUpdate));
    this.lastUpdate = now;
    for (let pi = 0; pi < this.list.length; pi++) {
      const r = this.list[pi];
      const b = r.buffer;
      if (b.length === 0) { this.showTag(r, false); continue; }
      // Arcade culling: hide players the server no longer shows us.
      const culled = this.occluder !== null && ((r.staleAt >= 0 && now - r.staleAt >= STALE_HIDE) || now - r.lastSeen > ABSENT_HIDE);
      if (culled !== r.culled) { r.culled = culled; this.syncListed(r); }
      // Find the two snapshots around renderTime. Past the newest one (a late packet) keep going along the last two
      // for a moment instead of freezing, then hold; before the oldest, hold the oldest.
      let a = b[0], c = b[b.length - 1];
      let f = 1;
      if (b.length >= 2 && renderTime > c.t) {
        a = b[b.length - 2];
        const span = c.t - a.t;
        f = span > 0 ? 1 + Math.min(renderTime - c.t, MAX_EXTRAPOLATE) / span : 1;
        // Not across a teleport or respawn.
        if (Math.abs(c.x - a.x) + Math.abs(c.z - a.z) > 8) f = 1;
      } else {
        for (let i = 0; i < b.length - 1; i++) {
          if (b[i].t <= renderTime && b[i + 1].t >= renderTime) { a = b[i]; c = b[i + 1]; break; }
        }
        const span = c.t - a.t;
        f = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 1;
      }
      // Arcade: a shot player lies down, is hidden after a moment and returns at the respawn.
      if (r.deadAt >= 0) {
        const since = now - r.deadAt;
        if (since >= RESPAWN_SECONDS) this.revive(r);
        else if (since >= CORPSE_SECONDS && !r.hidden) {
          r.hidden = true;
          this.syncListed(r);
        }
        r.mob.deathTime = Math.min(20, since * 20);
      }
      const m = r.mob;
      const px = m.x, pz = m.z;
      m.x = m.prevX = a.x + (c.x - a.x) * f;
      m.y = m.prevY = a.y + (c.y - a.y) * f;
      m.z = m.prevZ = a.z + (c.z - a.z) * f;
      let dyaw = c.yaw - a.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      m.yaw = m.prevYaw = a.yaw + dyaw * f;
      // The mob model tilts its head by −headPitch (positive = looking down); player pitch is positive when looking up.
      m.headPitch = -(a.pitch + (c.pitch - a.pitch) * f);
      m.onGround = (c.flags & 4) !== 0;
      // Arcade crouch and slide (the pose the server believes): ease the body into it.
      const slide = (c.flags & SNAP_FLAG_SLIDE) !== 0, crouch = !slide && (c.flags & SNAP_FLAG_CROUCH) !== 0;
      const ease = 1 - Math.exp(-14 * dtTag);
      m.lean += ((slide ? POSE_SLIDE_LEAN : crouch ? POSE_CROUCH_LEAN : 0) - m.lean) * ease;
      m.drop += ((slide ? 0.3 : crouch ? 0.2 : 0) - m.drop) * ease;
      m.legLean += ((slide ? -1.0 : crouch ? -POSE_CROUCH_LEAN : 0) - m.legLean) * ease;
      // Limb swing from the distance moved this frame (same smoothing as mobs).
      const moved = Math.hypot(m.x - px, m.z - pz);
      m.limbAmount += (Math.min(1, moved * 12) - m.limbAmount) * 0.25;
      m.prevLimbSwing = m.limbSwing;
      m.limbSwing += m.limbAmount * 0.9;

      this.placeWeapon(r);

      // Name tag above the head.
      tmp.set(m.x, m.y + 2.15 * Math.cos(m.lean) - m.drop, m.z).project(camera);
      const dx = camera.position.x - m.x, dy = camera.position.y - m.y, dz = camera.position.z - m.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const arcade = this.occluder !== null;
      const range = arcade ? ARCADE_TAG_RANGE : TAG_RANGE;
      let visible = !r.hidden && !r.culled && r.staleAt < 0 && r.id !== this.spectated && tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2 && d2 < range * range;
      if (arcade) {
        // Throttled line of sight, then a fade towards the result.
        if (visible && now - r.losAt >= LOS_INTERVAL) {
          r.losAt = now;
          const dist = Math.sqrt(d2) || 1;
          const hit = raycast(this.occluder!, camera.position.x, camera.position.y, camera.position.z,
            (m.x - camera.position.x) / dist, (m.y + HEAD_HEIGHT - camera.position.y) / dist, (m.z - camera.position.z) / dist, dist, this.losRay);
          r.los = !hit.hit || hit.distance >= dist - 0.3;
        }
        const target = visible && r.los ? 1 : 0;
        const step = dtTag / TAG_FADE;
        r.tagAlpha = target > r.tagAlpha ? Math.min(1, r.tagAlpha + step) : Math.max(0, r.tagAlpha - step);
        visible = visible && r.tagAlpha > 0;
        if (Math.abs(r.tagAlpha - r.tagOpacity) >= 0.02 || (r.tagAlpha !== r.tagOpacity && (r.tagAlpha === 0 || r.tagAlpha === 1))) {
          r.tagOpacity = r.tagAlpha;
          r.tag.style.opacity = r.tagAlpha === 1 ? '' : String(Math.round(r.tagAlpha * 100) / 100);
        }
      } else if (r.tagOpacity !== 1) {
        r.tagOpacity = r.tagAlpha = 1;
        r.tag.style.opacity = '';
      }
      this.showTag(r, visible);
      if (visible) {
        const sx = Math.round(((tmp.x + 1) / 2) * width), sy = Math.round(((1 - tmp.y) / 2) * height);
        if (sx !== r.tagX || sy !== r.tagY) {
          r.tagX = sx; r.tagY = sy;
          r.tag.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
        }
      }
    }
  }

  /** Puts the weapon mesh into the right hand: at the end of the (raised) arm, barrel along it. */
  private placeWeapon(r: Remote): void {
    const m = r.mob, w = r.weapon;
    const show = m.holding && !r.hidden && !r.culled && r.weaponId !== '' && !m.dead;
    if (w.visible !== show) w.visible = show;
    if (!show) return;
    tmpPos.set(m.x, m.y, m.z);
    tmpQuat.setFromEuler(tmpEuler.set(0, m.yaw, 0, 'YXZ'));
    tmpBase.compose(tmpPos, tmpQuat, tmpScale);
    // Crouch and slide lean the body (same transform as the model, see MobRenderer).
    if (m.lean !== 0 || m.drop !== 0) {
      tmpLocal.makeTranslation(0, -m.drop, -0.9 * Math.sin(m.lean));
      tmpBase.multiply(tmpLocal);
      tmpLocal.makeRotationX(m.lean);
      tmpBase.multiply(tmpLocal);
    }
    // Weapon frame: shoulder pivot, rotated so −Z runs along the arm, then out to the hand.
    tmpLocal.makeRotationX(-m.headPitch);
    tmpLocal.setPosition(ARM_PIVOT);
    tmpBase.multiply(tmpLocal);
    tmpLocal.makeTranslation(-0.1, 0.2, -0.38).scale(weaponScale);
    tmpBase.multiply(tmpLocal);
    w.matrix.copy(tmpBase);
    w.matrixWorldNeedsUpdate = true;
  }

  private showTag(r: Remote, shown: boolean): void {
    if (r.tagShown === shown) return;
    r.tagShown = shown;
    r.tag.style.display = shown ? 'block' : 'none';
  }
}
