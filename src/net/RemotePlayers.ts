import * as THREE from 'three';
import { Mob } from '../entities/Mob';
import { MOB_TYPES } from '../entities/MobTypes';
import { h } from '../ui/dom';
import type { SnapshotEntry } from './protocol';

/** Render other players this far in the past so there are always two snapshots to blend. */
const INTERPOLATION_DELAY = 0.1;

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
}

const tmp = new THREE.Vector3();

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

  constructor() {
    this.el = h('div', { class: 'nametags' });
  }

  add(id: number, name: string): void {
    if (this.players.has(id)) return;
    const mob = new Mob(MOB_TYPES.player);
    mob.persistent = true;
    const tag = h('div', { class: 'nametag', text: name });
    this.el.append(tag);
    const r: Remote = { name, mob, buffer: [], tag, tagX: NaN, tagY: NaN, tagShown: true };
    this.players.set(id, r);
    this.list.push(r);
    this.mobs.push(mob);
  }

  remove(id: number): void {
    const r = this.players.get(id);
    if (!r) return;
    r.tag.remove();
    this.players.delete(id);
    this.list.splice(this.list.indexOf(r), 1);
    this.mobs.splice(this.mobs.indexOf(r.mob), 1);
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
      const m = r.mob;
      const px = m.x, pz = m.z;
      m.x = m.prevX = a.x + (c.x - a.x) * f;
      m.y = m.prevY = a.y + (c.y - a.y) * f;
      m.z = m.prevZ = a.z + (c.z - a.z) * f;
      let dyaw = c.yaw - a.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      m.yaw = m.prevYaw = a.yaw + dyaw * f;
      m.headPitch = a.pitch + (c.pitch - a.pitch) * f;
      m.onGround = (c.flags & 4) !== 0;
      // Limb swing from the distance moved this frame (same smoothing as mobs).
      const moved = Math.hypot(m.x - px, m.z - pz);
      m.limbAmount += (Math.min(1, moved * 12) - m.limbAmount) * 0.25;
      m.prevLimbSwing = m.limbSwing;
      m.limbSwing += m.limbAmount * 0.9;

      // Name tag above the head.
      tmp.set(m.x, m.y + 2.15, m.z).project(camera);
      const dx = camera.position.x - m.x, dy = camera.position.y - m.y, dz = camera.position.z - m.z;
      const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2 && dx * dx + dy * dy + dz * dz < 64 * 64;
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

  private showTag(r: Remote, shown: boolean): void {
    if (r.tagShown === shown) return;
    r.tagShown = shown;
    r.tag.style.display = shown ? 'block' : 'none';
  }
}
