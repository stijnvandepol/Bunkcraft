import { Arrow } from '../entities/Arrow';
import type { EntityManager } from '../entities/EntityManager';
import { ItemEntity } from '../entities/ItemEntity';
import { Mob } from '../entities/Mob';
import { MOB_TYPES } from '../entities/MobTypes';
import { PrimedTnt } from '../entities/PrimedTnt';
import { MOB_FLAG, NET_MOB_KINDS, type ServerMessage } from './protocol';

/** Entities are drawn this far in the past so two 10 Hz snapshots always bracket the frame. */
const INTERPOLATION_DELAY = 0.15;
/** Minimum time between pickup requests for one item (it may still be inside its pickup delay). */
const TAKE_INTERVAL = 0.3;

interface State { t: number; x: number; y: number; z: number; yaw: number }

interface Track<T> {
  entity: T;
  buffer: State[];
  lastTake: number;
}

type EntMessage = Extract<ServerMessage, { t: 'ent' }>;

/**
 * Mirrors the server's mobs, dropped items, arrows and lit TNT as `remote` entities inside the
 * local EntityManager, so raycasts, collision checks and every renderer treat them like local
 * ones. The 10 Hz snapshots are interpolated per frame; nothing here simulates anything.
 */
export class NetEntities {
  private readonly mobs = new Map<number, Track<Mob>>();
  private readonly items = new Map<number, Track<ItemEntity>>();
  private readonly arrows = new Map<number, Track<Arrow>>();
  private readonly tnt = new Map<number, Track<PrimedTnt>>();

  constructor(private readonly entities: EntityManager) {}

  /** The latest snapshot replaces what the client knows: unlisted entities are gone. */
  apply(msg: EntMessage, now: number): void {
    const seen = new Set<number>();
    for (const [id, kind, x, y, z, yaw, headYaw, headPitch, flags, hurtTime, fuse, deathTime] of msg.m) {
      seen.add(id);
      let tr = this.mobs.get(id);
      if (!tr) {
        const type = MOB_TYPES[NET_MOB_KINDS[kind]];
        if (!type) continue;
        const mob = new Mob(type);
        mob.remote = true;
        mob.persistent = true;
        mob.netId = id;
        mob.setPosition(x, y, z);
        this.entities.mobs.push(mob);
        tr = { entity: mob, buffer: [], lastTake: 0 };
        this.mobs.set(id, tr);
      }
      const m = tr.entity;
      m.headYaw = headYaw;
      m.headPitch = headPitch;
      m.onGround = (flags & MOB_FLAG.GROUND) !== 0;
      m.burning = flags & MOB_FLAG.BURNING ? 20 : 0;
      m.health = flags & MOB_FLAG.DEAD ? 0 : m.type.health;
      m.hurtTime = hurtTime;
      m.deathTime = deathTime;
      m.sitting = (flags & MOB_FLAG.SITTING) !== 0;
      m.ownerId = flags & MOB_FLAG.TAMED ? 0 : -1;
      m.angryTicks = flags & MOB_FLAG.ANGRY ? 1 : 0;
      m.busy = flags & MOB_FLAG.BUSY ? 20 : 0;
      const baby = (flags & MOB_FLAG.BABY) !== 0;
      if (m.type.kind === 'creeper') m.prevFuse = m.fuse = fuse;
      else applyVariant(m, fuse);
      if (baby !== m.baby) m.setBaby(baby);
      this.push(tr, now, x, y, z, yaw);
    }
    this.prune(this.mobs, seen, (m) => { m.removed = true; });

    seen.clear();
    for (const [id, itemId, count, x, y, z] of msg.i) {
      seen.add(id);
      let tr = this.items.get(id);
      if (!tr) {
        const item = new ItemEntity({ id: itemId, count }, 0);
        item.remote = true;
        item.netId = id;
        item.setPosition(x, y, z);
        this.entities.items.push(item);
        tr = { entity: item, buffer: [], lastTake: 0 };
        this.items.set(id, tr);
      }
      tr.entity.stack.count = count;
      this.push(tr, now, x, y, z, 0);
    }
    this.prune(this.items, seen, (e) => { e.removed = true; });

    seen.clear();
    for (const [id, x, y, z, yaw, pitch, inGround] of msg.a) {
      seen.add(id);
      let tr = this.arrows.get(id);
      if (!tr) {
        const arrow = new Arrow(null, false, false, false);
        arrow.remote = true;
        arrow.netId = id;
        arrow.setPosition(x, y, z);
        this.entities.arrows.push(arrow);
        tr = { entity: arrow, buffer: [], lastTake: 0 };
        this.arrows.set(id, tr);
      }
      tr.entity.yaw = yaw;
      tr.entity.pitch = pitch;
      tr.entity.inGround = inGround === 1;
      this.push(tr, now, x, y, z, yaw);
    }
    this.prune(this.arrows, seen, (e) => { e.removed = true; });

    seen.clear();
    for (const [id, x, y, z, fuse] of msg.b) {
      seen.add(id);
      let tr = this.tnt.get(id);
      if (!tr) {
        const t = new PrimedTnt(fuse);
        t.remote = true;
        t.netId = id;
        t.setPosition(x, y, z);
        this.entities.tnt.push(t);
        tr = { entity: t, buffer: [], lastTake: 0 };
        this.tnt.set(id, tr);
      }
      tr.entity.fuse = fuse;
      this.push(tr, now, x, y, z, 0);
    }
    this.prune(this.tnt, seen, (e) => { e.removed = true; });
  }

  private push<T>(tr: Track<T>, now: number, x: number, y: number, z: number, yaw: number): void {
    tr.buffer.push({ t: now, x, y, z, yaw });
    if (tr.buffer.length > 6) tr.buffer.shift();
  }

  private prune<T>(map: Map<number, Track<T>>, seen: Set<number>, remove: (e: T) => void): void {
    for (const [id, tr] of map) {
      if (seen.has(id)) continue;
      remove(tr.entity);
      map.delete(id);
    }
  }

  /** Once per frame: place every mirrored entity at its interpolated position. */
  update(now: number, dt: number): void {
    const renderTime = now - INTERPOLATION_DELAY;
    for (const tr of this.mobs.values()) {
      const m = tr.entity;
      const px = m.x, pz = m.z;
      const s = this.sample(tr.buffer, renderTime);
      if (!s) continue;
      m.x = m.prevX = s.x; m.y = m.prevY = s.y; m.z = m.prevZ = s.z;
      m.yaw = m.prevYaw = s.yaw;
      // Limb swing from the distance moved this frame (same smoothing as RemotePlayers).
      const moved = Math.hypot(m.x - px, m.z - pz);
      m.limbAmount += (Math.min(1, moved * 12) - m.limbAmount) * 0.25;
      m.prevLimbSwing = m.limbSwing;
      m.limbSwing += m.limbAmount * 0.9;
      m.age += dt * 20;
    }
    for (const tr of this.items.values()) {
      const s = this.sample(tr.buffer, renderTime);
      if (!s) continue;
      const e = tr.entity;
      e.x = e.prevX = s.x; e.y = e.prevY = s.y; e.z = e.prevZ = s.z;
      e.age += dt * 20;
    }
    for (const tr of this.arrows.values()) {
      const s = this.sample(tr.buffer, renderTime);
      if (!s) continue;
      const a = tr.entity;
      a.x = a.prevX = s.x; a.y = a.prevY = s.y; a.z = a.prevZ = s.z;
    }
    for (const tr of this.tnt.values()) {
      const s = this.sample(tr.buffer, renderTime);
      if (!s) continue;
      const t = tr.entity;
      t.x = t.prevX = s.x; t.y = t.prevY = s.y; t.z = t.prevZ = s.z;
    }
  }

  private readonly out: State = { t: 0, x: 0, y: 0, z: 0, yaw: 0 };

  /** Position between the two snapshots around `time`; holds the newest one when we run out. */
  private sample(b: State[], time: number): State | null {
    if (b.length === 0) return null;
    let a = b[0], c = b[b.length - 1];
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].t <= time && b[i + 1].t >= time) { a = b[i]; c = b[i + 1]; break; }
    }
    const span = c.t - a.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (time - a.t) / span)) : 1;
    const o = this.out;
    o.x = a.x + (c.x - a.x) * f;
    o.y = a.y + (c.y - a.y) * f;
    o.z = a.z + (c.z - a.z) * f;
    let dyaw = c.yaw - a.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    o.yaw = a.yaw + dyaw * f;
    return o;
  }

  /** Throttled pickup request; returns true when one should be sent now. */
  shouldTake(item: ItemEntity, now: number): boolean {
    const tr = this.items.get(item.netId);
    if (!tr || now - tr.lastTake < TAKE_INTERVAL) return false;
    tr.lastTake = now;
    return true;
  }

  /** The server handed this item over: drop the mirror right away. */
  taken(id: number): void {
    const tr = this.items.get(id);
    if (!tr) return;
    tr.entity.removed = true;
    this.items.delete(id);
  }

  clear(): void {
    for (const map of [this.mobs, this.items, this.arrows, this.tnt] as Map<number, Track<{ removed?: boolean }>>[]) {
      for (const tr of map.values()) tr.entity.removed = true;
      map.clear();
    }
  }
}

/** The variant byte of a mirrored mob (see MobEntry): sheep colour, slime size, collar, horse coat and saddle. */
function applyVariant(m: Mob, v: number): void {
  if (m.type.kind === 'slime') {
    if (m.size !== v && v > 0) { m.size = v; m.refreshSize(); }
    return;
  }
  if (m.type.kind === 'horse') { m.variant = v & 15; m.saddled = (v & 16) !== 0; return; }
  m.variant = v;
}
