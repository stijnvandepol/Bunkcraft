import * as THREE from 'three';
import { Mob } from '../entities/Mob';
import { MOB_TYPES } from '../entities/MobTypes';
import { type Team, TEAM_COLORS } from '../modes/GameTypes';
import { RESPAWN_SECONDS } from '../modes/Weapons';
import { createWeaponMaterial, weaponGeometry } from '../rendering/WeaponModels';
import { h } from '../ui/dom';
import type { SnapshotEntry } from './protocol';

/** Render other players this far in the past so there are always two snapshots to blend. */
const INTERPOLATION_DELAY = 0.1;
/** A shot player lies on the ground this long, then is hidden until the respawn. */
const CORPSE_SECONDS = 1.4;

interface State { t: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number }

interface Remote {
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

  constructor() {
    this.el = h('div', { class: 'nametags' });
    this.weaponMaterial.color.setScalar(0.92);
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
      name, mob, buffer: [], tag, tagX: NaN, tagY: NaN, tagShown: true, team: '', weaponId: '', weapon, deadAt: -1, hidden: false,
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

  /** Arcade: the weapon this player holds (a weapon id); unknown ids leave the hands empty. */
  setWeapon(id: number, weaponId: string): void {
    const r = this.players.get(id);
    if (!r || r.weaponId === weaponId) return;
    r.weaponId = weaponId;
    const geo = weaponGeometry(weaponId);
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
      if (!this.mobs.includes(r.mob)) this.mobs.push(r.mob);
    }
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

  snapshot(entries: SnapshotEntry[], selfId: number, now: number): void {
    for (const [id, x, y, z, yaw, pitch, flags] of entries) {
      if (id === selfId) continue;
      const r = this.players.get(id);
      if (!r) continue;
      r.buffer.push({ t: now, x, y, z, yaw, pitch, flags });
      if (r.buffer.length > 30) r.buffer.shift();
    }
  }

  update(now: number, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const renderTime = now - INTERPOLATION_DELAY;
    for (let pi = 0; pi < this.list.length; pi++) {
      const r = this.list[pi];
      const b = r.buffer;
      if (b.length === 0) { this.showTag(r, false); continue; }
      // Find the two snapshots around renderTime; hold the newest if we run out.
      let a = b[0], c = b[b.length - 1];
      for (let i = 0; i < b.length - 1; i++) {
        if (b[i].t <= renderTime && b[i + 1].t >= renderTime) { a = b[i]; c = b[i + 1]; break; }
      }
      const span = c.t - a.t;
      const f = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 1;
      // Arcade: a shot player lies down, is hidden after a moment and returns at the respawn.
      if (r.deadAt >= 0) {
        const since = now - r.deadAt;
        if (since >= RESPAWN_SECONDS) this.revive(r);
        else if (since >= CORPSE_SECONDS && !r.hidden) {
          r.hidden = true;
          const mi = this.mobs.indexOf(r.mob);
          if (mi >= 0) this.mobs.splice(mi, 1);
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
      // Limb swing from the distance moved this frame (same smoothing as mobs).
      const moved = Math.hypot(m.x - px, m.z - pz);
      m.limbAmount += (Math.min(1, moved * 12) - m.limbAmount) * 0.25;
      m.prevLimbSwing = m.limbSwing;
      m.limbSwing += m.limbAmount * 0.9;

      this.placeWeapon(r);

      // Name tag above the head.
      tmp.set(m.x, m.y + 2.15, m.z).project(camera);
      const dx = camera.position.x - m.x, dy = camera.position.y - m.y, dz = camera.position.z - m.z;
      const visible = !r.hidden && tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2 && dx * dx + dy * dy + dz * dz < 64 * 64;
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
    const show = m.holding && !r.hidden && r.weaponId !== '' && !m.dead;
    if (w.visible !== show) w.visible = show;
    if (!show) return;
    tmpPos.set(m.x, m.y, m.z);
    tmpQuat.setFromEuler(tmpEuler.set(0, m.yaw, 0, 'YXZ'));
    tmpBase.compose(tmpPos, tmpQuat, tmpScale);
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
