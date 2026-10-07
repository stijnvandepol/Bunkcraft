import { BLOCK, PARTIAL, SHAPE, SHAPE_BOX, SHAPE_CUBE, SOLID, getBlockDef } from '../world/BlockRegistry';
import { collisionBoxes } from '../world/BlockShapes';
import { type WeaponDef } from './Weapons';
import { currentSpread } from './ArcadeLogic';

/**
 * Hitscan geometry shared by the server (authoritative) and the client (tracers, impacts and its own
 * prediction), DOM-free:
 *  - player hitboxes that follow the drawn model (head, torso, raised arms, legs; turned with the yaw and,
 *    for head and arms, the pitch),
 *  - the bullet's path through the voxels with materials (one window or hedge: glass, panes and leaves let it
 *    through at a damage cost; slabs, stairs, fences, bars and walls stop it only where their shape is),
 *  - seeded spread, so the tracer you see is the bullet the server tests.
 */

// ---------------------------------------------------------------- player model and hitboxes

/**
 * Render scale of the player model: the Minecraft model is 32 px = 2 blocks tall, drawn at 0.9 it is exactly the
 * 1.8 block collision height, with the eye (1.62) inside the head (1.35-1.8).
 */
export const PLAYER_MODEL_SCALE = 0.9;
/** One model pixel in blocks. */
const PX = PLAYER_MODEL_SCALE / 16;

export type HitPart = 'head' | 'body' | 'legs';

/**
 * A hitbox: a model part's box in its own frame (model pixels in blocks, relative to the part's pivot), placed like
 * MobRenderer draws it: turned by Ry(yaw)·Rx(pitch · pitchMul + pitchOff) about the pivot (player frame: x right,
 * y up from the feet, −z where they look).
 */
interface Box {
  part: HitPart;
  min: [number, number, number]; max: [number, number, number];
  pivot: [number, number, number];
  yaw: number; pitchMul: number; pitchOff: number;
}

/** Margin around the drawn model: voxel models are small, a shot on the edge of the drawn pixel should count. */
const M = 0.04;
const HALF_PI = Math.PI / 2;
/**
 * The boxes, from the MobTypes player model at PLAYER_MODEL_SCALE: head 8 px cube on the neck (24-32 px), torso
 * 8×12×4 px, arms 4×12×4 px raised along the view from the shoulders (22 px; the left one angled in towards the
 * gun, as MobRenderer poses an armed player), legs 4×12×4 px each.
 */
const BOXES: readonly Box[] = [
  { part: 'head', min: [-4 * PX, 0, -4 * PX], max: [4 * PX, 8 * PX, 4 * PX], pivot: [0, 24 * PX, 0], yaw: 0, pitchMul: 1, pitchOff: 0 },
  { part: 'body', min: [-4 * PX, 12 * PX, -2 * PX], max: [4 * PX, 24 * PX, 2 * PX], pivot: [0, 0, 0], yaw: 0, pitchMul: 0, pitchOff: 0 },
  { part: 'body', min: [-2 * PX, -10 * PX, -2 * PX], max: [2 * PX, 2 * PX, 2 * PX], pivot: [6 * PX, 22 * PX, 0], yaw: 0, pitchMul: 1, pitchOff: HALF_PI },
  { part: 'body', min: [-2 * PX, -10 * PX, -2 * PX], max: [2 * PX, 2 * PX, 2 * PX], pivot: [-6 * PX, 22 * PX, 0], yaw: -0.5, pitchMul: 1, pitchOff: HALF_PI - 0.25 },
  // Legs: running swings them up to ±80°, the feet 11 px forward and back; the box covers most of the sweep.
  { part: 'legs', min: [-4 * PX, 0, -6 * PX], max: [4 * PX, 12 * PX, 6 * PX], pivot: [0, 0, 0], yaw: 0, pitchMul: 0, pitchOff: 0 },
];
const BOX_YAW_COS = BOXES.map((b) => Math.cos(b.yaw));
const BOX_YAW_SIN = BOXES.map((b) => Math.sin(b.yaw));

/** Total height of a standing player's hitbox (the drawn model). */
export const PLAYER_HEIGHT = 32 * PX;

export interface PlayerHit { t: number; part: HitPart }

/** Entry distance of a ray into a box, or −1 on a miss (a ray starting inside returns 0). */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
  let tMin = 0, tMax = Infinity;
  // Slab test per axis (written out: no closure, this runs per pellet and target).
  if (Math.abs(dx) < 1e-12) { if (ox < minX || ox > maxX) return -1; } else {
    let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  if (Math.abs(dy) < 1e-12) { if (oy < minY || oy > maxY) return -1; } else {
    let t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  if (Math.abs(dz) < 1e-12) { if (oz < minZ || oz > maxZ) return -1; } else {
    let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  return tMin;
}

/**
 * Ray against a player standing at (x, y, z) (feet), turned by `yaw` and looking up by `pitch` (radians,
 * positive = up, the camera's convention), crouched or sliding when `heightScale` < 1 (the model squashed from the
 * feet: 1.5 / 1.8 crouching, 1.15 / 1.8 sliding): the nearest hitbox, or null. Allocation-free.
 */
export function rayPlayer(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x: number, y: number, z: number, yaw: number, pitch: number, heightScale = 1,
): PlayerHit | null {
  // Into the player's frame: undo the yaw (the model is turned by Ry(yaw)).
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rx = ox - x, ry = (oy - y) / heightScale, rz = oz - z;
  const lox = rx * c - rz * s, loz = rx * s + rz * c;
  let ldx = dx * c - dz * s, ldz = dx * s + dz * c;
  let ldy = dy / heightScale;
  // Distances along the scaled ray differ from world distances: keep the scale to convert back.
  const k = Math.hypot(ldx, ldy, ldz);
  ldx /= k; ldy /= k; ldz /= k;
  // Every box is tested with the margin (what counts as a hit) and without (who is really in front where two
  // margins overlap, e.g. the raised right arm next to the face).
  let best = Infinity, bestExact = Infinity;
  let part: HitPart = 'body';
  let other = Infinity, otherExact = Infinity;
  let otherPart: HitPart = 'body';
  for (let i = 0; i < BOXES.length; i++) {
    const b = BOXES[i];
    // Into the part's frame: about its pivot, undo the yaw, then the pitch.
    let px = lox - b.pivot[0], py = ry - b.pivot[1], pz = loz - b.pivot[2];
    let qx = ldx, qy = ldy, qz = ldz;
    if (b.yaw !== 0) {
      const c2 = BOX_YAW_COS[i], s2 = BOX_YAW_SIN[i];
      const x1 = px * c2 - pz * s2, z1 = px * s2 + pz * c2;
      px = x1; pz = z1;
      const x2 = qx * c2 - qz * s2, z2 = qx * s2 + qz * c2;
      qx = x2; qz = z2;
    }
    const ang = pitch * b.pitchMul + b.pitchOff;
    if (ang !== 0) {
      const cp = Math.cos(ang), sp = Math.sin(ang);
      const y1 = py * cp + pz * sp, z1 = -py * sp + pz * cp;
      py = y1; pz = z1;
      const y2 = qy * cp + qz * sp, z2 = -qy * sp + qz * cp;
      qy = y2; qz = z2;
    }
    const lo = b.min, hi = b.max;
    const t = rayBox(px, py, pz, qx, qy, qz, lo[0] - M, lo[1] - M, lo[2] - M, hi[0] + M, hi[1] + M, hi[2] + M);
    if (t < 0) continue;
    const exact = rayBox(px, py, pz, qx, qy, qz, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    const te = exact < 0 ? Infinity : exact;
    const sameKind = (b.part === 'head') === (part === 'head');
    if (best === Infinity || sameKind) {
      if (t < best) { best = t; part = b.part; }
      if (te < bestExact) bestExact = te;
    } else if (t < best) {
      // A box of the other kind (head vs the rest) is nearer: the old best becomes the competitor.
      other = best; otherExact = bestExact; otherPart = part;
      best = t; bestExact = te; part = b.part;
    } else {
      if (t < other) { other = t; otherPart = b.part; }
      if (te < otherExact) otherExact = te;
    }
  }
  if (best === Infinity) return null;
  // Overlapping margins: the box the ray really meets first decides head or not.
  if (other - best < 2 * M && otherExact < bestExact) part = otherPart;
  // Back to world distance: the local direction had length k before normalising, the world one 1.
  return { t: best / k, part };
}

// ---------------------------------------------------------------- bullets through the voxels

/** How a block treats a bullet. */
const PASS = 0, STOP = 1, THIN = 2, SHAPED = 3;
/** Per block id: PASS, STOP, THIN (see-through: passes at a damage cost) or SHAPED (test its collision boxes). */
export const BULLET = new Uint8Array(256);
/**
 * Damage kept per see-through block (THIN): glass 0.8, leaves 0.9 (once per window: two glass cells in a row are one
 * pane). Fences and walls are SHAPED: a bullet stops on their posts and rails (their collision boxes), so a railing
 * is still cover; iron bars stop it like a block.
 */
export const BULLET_KEEP = new Float32Array(256);
/** A bullet stops after this many see-through cells (a wall of glass is still a wall)... */
export const MAX_THIN = 4;
/**
 * ...and at the second window or hedge: shooting into or out of a house works, through two of them (spawn to spawn
 * across a street of houses) does not. The maps' spawn sight-line tests rely on it.
 */
export const MAX_PANES = 1;

/**
 * Whether bullets pass windows and hedges (glass, panes, leaves). OFF for now: the maps use glass and leaves as spawn
 * cover (tests/spawnExposure.test.ts: suburb, quarter, atomic, plaza and mall get lines into the spawns through
 * windows). Turn on once those spawns are screened with solid blocks; client and server read the same constant.
 */
export const GLASS_PASSES_DEFAULT = false;

/** Fills BULLET / BULLET_KEEP; `glassPasses` false makes see-through blocks stop bullets like any full block. */
export function setGlassPasses(glassPasses: boolean): void {
  for (let id = 0; id < 256; id++) {
    const def = getBlockDef(id);
    BULLET_KEEP[id] = 0;
    if (!def || id === BLOCK.AIR) { BULLET[id] = PASS; continue; }
    const glass = def.name.includes('glass');
    const leaves = def.name.endsWith('leaves');
    const thinBox = SHAPE[id] === SHAPE_BOX && def.name.includes('pane');
    if ((glass && (SHAPE[id] === SHAPE_CUBE || SHAPE[id] === SHAPE_BOX)) || leaves || thinBox) {
      BULLET[id] = glassPasses ? THIN : STOP;
      BULLET_KEEP[id] = glass ? 0.8 : 0.9;
    } else if (!SOLID[id]) BULLET[id] = PASS;
    // Iron bars stop bullets like a block (a lone bar's shape is a thin post the maps use as a screen).
    else if (def.name.includes('bars')) BULLET[id] = STOP;
    else if (PARTIAL[id] || SHAPE[id] === SHAPE_BOX) BULLET[id] = SHAPED;
    else BULLET[id] = STOP;
  }
  BULLET[BLOCK.UNLOADED] = STOP;
}
setGlassPasses(GLASS_PASSES_DEFAULT);

export interface BlockQuery {
  getBlock(x: number, y: number, z: number): number;
  /** State bits (slab half, stair facing); absent = 0. */
  getMeta?(x: number, y: number, z: number): number;
}

/** Result of `traceBullet` (reused, no allocation per shot). */
export interface BulletTrace {
  /** Distance to where the bullet stopped (or the range). */
  t: number;
  /** True when a block stopped it (not the range). */
  blocked: boolean;
  /** The block that stopped it and the face normal there. */
  x: number; y: number; z: number; id: number;
  nx: number; ny: number; nz: number;
  /** Damage kept after the see-through blocks on the way (1 = none). */
  keep: number;
  /**
   * See-through blocks passed: count, and their cells and ids (first MAX_THIN), with the distance to each and the
   * damage kept by it (`thinMul`: a window two cells across costs once, the second cell of a run keeps 1).
   */
  thin: number;
  thinX: Int32Array; thinY: Int32Array; thinZ: Int32Array; thinId: Uint8Array; thinT: Float32Array; thinMul: Float32Array;
}

export function createBulletTrace(): BulletTrace {
  return {
    t: 0, blocked: false, x: 0, y: 0, z: 0, id: 0, nx: 0, ny: 0, nz: 0, keep: 1, thin: 0,
    thinX: new Int32Array(MAX_THIN), thinY: new Int32Array(MAX_THIN), thinZ: new Int32Array(MAX_THIN), thinId: new Uint8Array(MAX_THIN), thinT: new Float32Array(MAX_THIN),
    thinMul: new Float32Array(MAX_THIN),
  };
}

const shapeBoxes = new Float64Array(64);
/** The world of the trace in progress (shape lookups need block and state getters; no closure per call). */
let cur: BlockQuery = { getBlock: () => 0 };
const curBlock = (x: number, y: number, z: number): number => cur.getBlock(x, y, z);
const curMeta = (x: number, y: number, z: number): number => (cur.getMeta ? cur.getMeta(x, y, z) : 0);

/** Entry distance of the ray into the bullet shape of a partial block (its collision boxes, capped at the cell top), −1 = through. */
function shapeHit(world: BlockQuery, id: number, x: number, y: number, z: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  cur = world;
  const n = collisionBoxes(id, curMeta(x, y, z), curBlock, curMeta, x, y, z, shapeBoxes);
  let best = -1;
  for (let k = 0; k < n; k++) {
    const o = k * 6;
    const t = rayBox(ox, oy, oz, dx, dy, dz, x + shapeBoxes[o], y + shapeBoxes[o + 1], z + shapeBoxes[o + 2],
      x + shapeBoxes[o + 3], y + Math.min(1, shapeBoxes[o + 4]), z + shapeBoxes[o + 5]);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/**
 * The bullet's path from (ox, oy, oz) along the normalised (dx, dy, dz) up to `maxDist`: where it stops and
 * which see-through blocks it passed (Amanatides & Woo; the origin cell never blocks).
 */
export function traceBullet(
  world: BlockQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: BulletTrace,
): BulletTrace {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = dx === 0 ? Infinity : (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY;
  let tMaxZ = dz === 0 ? Infinity : (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ;
  out.keep = 1; out.thin = 0; out.blocked = false; out.id = 0;
  let t = 0;
  let axis = 0;
  /** The previous cell was a see-through block (the same window continues). */
  let inRun = false;
  let panes = 0;
  while (t <= maxDist) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { t = tMaxX; x += stepX; tMaxX += tDeltaX; axis = 0; }
    else if (tMaxY < tMaxZ) { t = tMaxY; y += stepY; tMaxY += tDeltaY; axis = 1; }
    else { t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; axis = 2; }
    if (t > maxDist) break;
    const id = world.getBlock(x, y, z);
    const kind = BULLET[id];
    if (kind !== THIN) inRun = false;
    if (kind === PASS) continue;
    if (kind === THIN) {
      if (!inRun) panes++;
      if (out.thin < MAX_THIN && panes <= MAX_PANES) {
        const i = out.thin;
        out.thinX[i] = x; out.thinY[i] = y; out.thinZ[i] = z; out.thinId[i] = id; out.thinT[i] = t;
        const mul = inRun ? 1 : BULLET_KEEP[id];
        out.thinMul[i] = mul;
        out.thin++;
        out.keep *= mul;
        inRun = true;
        continue;
      }
    } else if (kind === SHAPED) {
      const ts = shapeHit(world, id, x, y, z, ox, oy, oz, dx, dy, dz);
      if (ts < 0 || ts > maxDist) continue;
      out.t = ts; out.blocked = true; out.x = x; out.y = y; out.z = z; out.id = id;
      faceNormal(out, ox + dx * ts - x, oy + dy * ts - y, oz + dz * ts - z, dx, dy, dz);
      return out;
    }
    out.t = t; out.blocked = true; out.x = x; out.y = y; out.z = z; out.id = id;
    out.nx = axis === 0 ? -stepX : 0; out.ny = axis === 1 ? -stepY : 0; out.nz = axis === 2 ? -stepZ : 0;
    return out;
  }
  out.t = maxDist;
  return out;
}

/** The face of a partial block's box the bullet entered: the axis where the hit point sits on a box face, against the ray. */
function faceNormal(out: BulletTrace, lx: number, ly: number, lz: number, dx: number, dy: number, dz: number): void {
  out.nx = out.ny = out.nz = 0;
  // The component whose ray direction is largest wins a tie; good enough for a puff of particles.
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  void lx; void ly; void lz;
  if (ax >= ay && ax >= az) out.nx = dx > 0 ? -1 : 1;
  else if (ay >= az) out.ny = dy > 0 ? -1 : 1;
  else out.nz = dz > 0 ? -1 : 1;
}

const scratch = createBulletTrace();

/** Distance to the first block that stops a bullet, or `maxDist` (line of sight for the lag compensation). */
export function traceBlocks(world: BlockQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
  return traceBullet(world, ox, oy, oz, dx, dy, dz, maxDist, scratch).t;
}

// ---------------------------------------------------------------- spread

/**
 * The spread cone (half-angle, degrees) of a shot: aimed (`ads`) or from the hip, with the penalties for
 * moving and for being in the air. One function for the client's tracer and the server's verdict.
 */
export function shotSpread(w: WeaponDef, ads: boolean, moving: boolean, airborne: boolean): number {
  if (w.slot === 'melee') return 0;
  return currentSpread(w, ads ? 1 : 0, moving, airborne);
}

/** A well-mixed 32-bit hash of four integers (spread seeds). */
function mix(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(b + 0x632be5ab, 0xc2b2ae35); h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (c * 0x27d4eb2f), 0x165667b1); h ^= h >>> 15;
  h = Math.imul(h + d, 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The two random numbers in [0, 1) for pellet `pellet` of shot `n` of a life with spread seed `seed`. The server
 * deals the seed at the spawn; client and server derive the same numbers, so the tracer is the bullet.
 */
export function spreadRandom(seed: number, n: number, pellet: number, out: [number, number]): [number, number] {
  // Seed 0 is "no spread": a host without randomness (the tests' fake clock host) gets dead-centre shots.
  if (seed === 0) { out[0] = out[1] = 0; return out; }
  out[0] = mix(seed, n, pellet, 1) / 4294967296;
  out[1] = mix(seed, n, pellet, 2) / 4294967296;
  return out;
}

/**
 * A direction inside a cone of `degrees` half-angle around (dx, dy, dz) (normalised), uniform over
 * the cone's disc. `r1` and `r2` are random numbers in [0, 1).
 */
export function spreadDirection(
  dx: number, dy: number, dz: number, degrees: number, r1: number, r2: number, out: [number, number, number],
): [number, number, number] {
  if (degrees <= 0) { out[0] = dx; out[1] = dy; out[2] = dz; return out; }
  const angle = (degrees * Math.PI / 180) * Math.sqrt(r1);
  const az = r2 * Math.PI * 2;
  // Orthonormal basis (u, v) perpendicular to the aim.
  let ux: number, uy: number, uz: number;
  if (Math.abs(dy) < 0.99) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const s = Math.sin(angle), c = Math.cos(angle), ca = Math.cos(az) * s, sa = Math.sin(az) * s;
  out[0] = dx * c + ux * ca + vx * sa;
  out[1] = dy * c + uy * ca + vy * sa;
  out[2] = dz * c + uz * ca + vz * sa;
  return out;
}
