import * as THREE from 'three';
import { FOG_GLSL, LIGHT_GLSL, type WorldUniforms } from '../rendering/Materials';
import { DYES } from '../world/Content';
import { SOLID } from '../world/BlockRegistry';
import type { World } from '../world/World';
import type { Mob, MobFx } from './Mob';
import { HORSE_COATS, MOB_TYPES, type MobKind, type ModelBox, type ModelPart, type PartAnim } from './MobTypes';

const MAX_PER_TYPE = 48;
const TEX_W = 128;
const TEX_H = 64;
const MAX_SHADOWS = 160;
const MAX_EMOTES = 96;

interface Region { u: number; v: number; w: number; h: number; d: number }

/** Shelf-packs Minecraft box-UV regions (2·(w+d) × (d+h)) into one texture per mob type. */
function packRegions(boxes: ModelBox[]): Region[] {
  let u = 0, v = 0, rowH = 0;
  return boxes.map((b) => {
    const w = Math.ceil(b.to[0] - b.from[0]), h = Math.ceil(b.to[1] - b.from[1]), d = Math.ceil(b.to[2] - b.from[2]);
    const rw = 2 * (w + d), rh = d + h;
    if (u + rw > TEX_W) { u = 0; v += rowH; rowH = 0; }
    const r = { u, v, w, h, d };
    u += rw;
    rowH = Math.max(rowH, rh);
    if (v + rowH > TEX_H) console.warn('Mob texture overflow: a box does not fit in the atlas');
    return r;
  });
}

function paintTexture(boxes: ModelBox[], regions: Region[]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const ctx = c.getContext('2d')!;
  boxes.forEach((b, i) => {
    const r = regions[i];
    for (let y = 0; y < r.d + r.h; y++) {
      for (let x = 0; x < 2 * (r.w + r.d); x++) {
        // Base colour most of the time, with sparse variation pixels (Minecraft-like noise).
        const roll = Math.random();
        const idx = roll < 0.6 ? 0 : 1 + Math.floor(Math.random() * Math.max(1, b.colors.length - 1));
        ctx.fillStyle = b.colors[Math.min(idx, b.colors.length - 1)];
        ctx.fillRect(r.u + x, r.v + y, 1, 1);
      }
    }
    if (b.patches) {
      // A few large irregular blobs across the whole region (cow hide).
      ctx.fillStyle = b.patches;
      const rw = 2 * (r.w + r.d), rh = r.d + r.h;
      for (let k = 0; k < Math.max(3, Math.floor((rw * rh) / 90)); k++) {
        const cx = r.u + Math.random() * rw, cy = r.v + Math.random() * rh, rad = 2 + Math.random() * 3.5;
        for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) {
          if (x * x + y * y * 1.3 > rad * rad || Math.random() < 0.08) continue;
          const px = Math.floor(cx + x), py = Math.floor(cy + y);
          if (px >= r.u && px < r.u + rw && py >= r.v && py < r.v + rh) ctx.fillRect(px, py, 1, 1);
        }
      }
    }
    if (b.face) {
      const fx = r.u + r.d, fy = r.v + r.d;
      b.face((x, y, col) => {
        if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
        ctx.fillStyle = col;
        ctx.fillRect(fx + x, fy + y, 1, 1);
      }, r.w, r.h);
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Box geometry in block units with Minecraft box-UV mapping (front = −Z). */
function boxGeometry(b: ModelBox, r: Region, positions: number[], normals: number[], uvs: number[], indices: number[]): void {
  const [x0, y0, z0] = b.from.map((v) => v / 16);
  const [x1, y1, z1] = b.to.map((v) => v / 16);
  const U = (px: number) => px / TEX_W, V = (py: number) => 1 - py / TEX_H;
  const face = (pts: number[][], n: number[], ru: number, rv: number, rw: number, rh: number) => {
    const base = positions.length / 3;
    // pts order: top-left, top-right, bottom-right, bottom-left (as seen in the texture).
    const uv = [[ru, rv], [ru + rw, rv], [ru + rw, rv + rh], [ru, rv + rh]];
    for (let k = 0; k < 4; k++) {
      positions.push(...pts[k]);
      normals.push(...n);
      uvs.push(U(uv[k][0]), V(uv[k][1]));
    }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const { u, v, w, h, d } = r;
  face([[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]], [0, 0, -1], u + d, v + d, w, h); // front (−Z)
  face([[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]], [0, 0, 1], u + 2 * d + w, v + d, w, h); // back
  face([[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]], [1, 0, 0], u, v + d, d, h); // +X side
  face([[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]], [-1, 0, 0], u + d + w, v + d, d, h); // −X side
  face([[x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0]], [0, 1, 0], u + d, v, w, d); // top
  face([[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]], [0, -1, 0], u + d + w, v, w, d); // bottom
}

interface PartMesh {
  part: ModelPart;
  mesh: THREE.InstancedMesh;
  data: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
}

const tmpM = new THREE.Matrix4();
const tmpBase = new THREE.Matrix4();
const tmpPivot = new THREE.Matrix4();
const tmpRot = new THREE.Matrix4();
const tmpScaleM = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpEuler = new THREE.Euler();
const tmpScale = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

/** Dye colours as linear-ish 0..1 triples (sheep wool, wolf collars) and the horse coats. */
const DYE_RGB = DYES.map((d) => [(d.rgb >> 16 & 255) / 255, (d.rgb >> 8 & 255) / 255, (d.rgb & 255) / 255]);
const COAT_RGB = HORSE_COATS.map((c) => [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]);

/** Emote sprites: 0 heart, 1 smoke puff, 2 angry cloud, 3 purple poof. */
const EMOTE_KIND: Record<MobFx, number> = { love: 0, tame: 0, smoke: 1, angry: 2, poof: 3 };

/**
 * Renders all mobs with one InstancedMesh per model part (≈6 draw calls per mob type,
 * independent of how many mobs exist). Parts are posed on the CPU each frame. Also draws a soft blob shadow under
 * every mob (one instanced draw) and the floating emotes (hearts, smoke; one instanced draw).
 */
export class MobRenderer {
  readonly group = new THREE.Group();
  private readonly types = new Map<MobKind, PartMesh[]>();
  /** Flat list of all part meshes (iterating the map each frame would allocate iterators). */
  private readonly all: PartMesh[] = [];

  private frame = 0;
  /** Mobs further than the fog end are invisible anyway: skip their posing and instances. */
  private readonly fogFar: { value: number };
  private readonly shadows: THREE.InstancedMesh;
  private readonly shadowData: THREE.InstancedBufferAttribute;
  private readonly emotes: THREE.InstancedMesh;
  private readonly emoteData: THREE.InstancedBufferAttribute;
  private readonly emotePos = new Float32Array(MAX_EMOTES * 3);
  private readonly emoteLife = new Float32Array(MAX_EMOTES);
  private readonly emoteKind = new Uint8Array(MAX_EMOTES);
  private emoteNext = 0;
  private lastTime = 0;

  constructor(uniforms: WorldUniforms) {
    this.fogFar = uniforms.uFogFar;
    for (const type of Object.values(MOB_TYPES)) {
      const boxes = type.parts.flatMap((p) => p.boxes);
      const regions = packRegions(boxes);
      const texture = paintTexture(boxes, regions);
      const material = createMobMaterial(uniforms, texture);
      let bi = 0;
      const parts: PartMesh[] = type.parts.map((part) => {
        const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
        for (const box of part.boxes) boxGeometry(box, regions[bi++], positions, normals, uvs, indices);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        const data = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 4), 4).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('iData', data);
        const tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 4).fill(1), 4).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('iTint', tint);
        const mesh = new THREE.InstancedMesh(geo, material, MAX_PER_TYPE);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.group.add(mesh);
        const pm = { part, mesh, data, tint };
        this.all.push(pm);
        return pm;
      });
      this.types.set(type.kind, parts);
    }

    // Blob shadows: a dark disc on the ground under each mob.
    const sg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadowData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHADOWS), 1).setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('iAlpha', this.shadowData);
    this.shadows = new THREE.InstancedMesh(sg, createShadowMaterial(uniforms), MAX_SHADOWS);
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.count = 0;
    this.shadows.renderOrder = 1;
    this.group.add(this.shadows);

    // Emotes: camera-facing sprites from a tiny procedural sheet.
    const eg = new THREE.PlaneGeometry(1, 1);
    this.emoteData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EMOTES * 4), 4).setUsage(THREE.DynamicDrawUsage);
    eg.setAttribute('iEmote', this.emoteData);
    this.emotes = new THREE.InstancedMesh(eg, createEmoteMaterial(uniforms, paintEmotes()), MAX_EMOTES);
    this.emotes.frustumCulled = false;
    this.emotes.count = 0;
    this.group.add(this.emotes);
  }

  /** Spawns emote sprites (hearts for love and taming, smoke for a failed taming...) around a mob. */
  emote(kind: MobFx, x: number, y: number, z: number, width = 0.6): void {
    const n = kind === 'tame' ? 7 : kind === 'poof' ? 6 : kind === 'love' ? 1 : 5;
    for (let k = 0; k < n; k++) {
      const i = this.emoteNext;
      this.emoteNext = (this.emoteNext + 1) % MAX_EMOTES;
      this.emotePos[i * 3] = x + (Math.random() - 0.5) * width * 1.6;
      this.emotePos[i * 3 + 1] = y + Math.random() * 0.5;
      this.emotePos[i * 3 + 2] = z + (Math.random() - 0.5) * width * 1.6;
      this.emoteLife[i] = 1;
      this.emoteKind[i] = EMOTE_KIND[kind];
    }
  }

  update(mobs: Mob[], alpha: number, world: World, cam: THREE.Vector3): void {
    const all = this.all;
    this.frame++;
    const now = performance.now() / 1000;
    const dt = this.lastTime ? Math.min(0.1, now - this.lastTime) : 0;
    this.lastTime = now;
    const cullR = this.fogFar.value + 8;
    const cull2 = cullR * cullR;
    const shadowR2 = Math.min(cull2, 48 * 48);
    let shadows = 0;
    const sd = this.shadowData.array as Float32Array;
    for (let i = 0; i < all.length; i++) all[i].mesh.count = 0;
    for (let mi = 0; mi < mobs.length; mi++) {
      const m = mobs[mi];
      const cdx = m.x - cam.x, cdz = m.z - cam.z;
      const camD2 = cdx * cdx + cdz * cdz;
      if (camD2 > cull2) continue;
      const parts = this.types.get(m.type.kind)!;
      const index = parts[0].mesh.count;
      if (index >= MAX_PER_TYPE) continue;
      const x = m.prevX + (m.x - m.prevX) * alpha;
      const y = m.prevY + (m.y - m.prevY) * alpha;
      const z = m.prevZ + (m.z - m.prevZ) * alpha;
      let dyaw = m.yaw - m.prevYaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const yaw = m.prevYaw + dyaw * alpha;
      const swing = m.prevLimbSwing + (m.limbSwing - m.prevLimbSwing) * alpha;
      const amount = m.limbAmount;
      const fuse = (m.prevFuse + (m.fuse - m.prevFuse) * alpha) / 30;
      const s = m.renderScale;

      // Creeper swelling (scale up and flash white) before it explodes.
      const swell = 1 + Math.sin(fuse * 100) * fuse * 0.01 + fuse * fuse * 0.35;
      // Slimes squash on landing and stretch in the air.
      const squish = m.type.kind === 'slime' ? (m.onGround ? 1 : 1.15) : 1;
      tmpScale.set(s * swell * (1 + fuse * 0.1) / Math.sqrt(squish), s * swell * squish, s * swell * (1 + fuse * 0.1) / Math.sqrt(squish));
      tmpPos.set(x, y, z);
      // Death: roll onto the side over 20 ticks.
      const death = m.dead ? Math.min(1, Math.sqrt((m.deathTime + alpha) / 20)) * (Math.PI / 2) : 0;
      tmpQuat.setFromEuler(tmpEuler.set(0, yaw, death, 'YXZ'));
      tmpBase.compose(tmpPos, tmpQuat, tmpScale);
      // A sitting wolf: the body tilts up around its hind legs.
      const sit = m.sitting && m.type.kind === 'wolf';
      if (sit) {
        tmpPivot.makeTranslation(0, 0, 5 / 16);
        tmpRot.makeRotationX(0.75);
        tmpM.makeTranslation(0, 0, -5 / 16);
        tmpBase.multiply(tmpPivot).multiply(tmpRot).multiply(tmpM);
      }

      const light = m.lightAt(world, this.frame, x, y + m.height * 0.6, z);
      const hurt = m.hurtTime > 0 || m.dead ? 1 : m.burning > 0 ? 0.5 : 0;
      const flash = fuse > 0 && Math.floor(fuse * 30 / 4) % 2 === 0 ? fuse : 0;
      const dye = DYE_RGB[m.variant & 15], coat = COAT_RGB[(m.variant & 15) % COAT_RGB.length];

      for (let pi = 0; pi < parts.length; pi++) {
        const pm = parts[pi];
        const part = pm.part;
        if (this.hidden(part, m)) {
          pm.mesh.setMatrixAt(index, ZERO);
          pm.mesh.count = index + 1;
          continue;
        }
        const rot = this.partRotation(part, swing, amount, m, alpha);
        if (sit && part.anim === 'head') rot.x -= 0.75;
        if (sit && (part.anim === 'legA' || part.anim === 'legB') && part.pivot[2] > 0) rot.x -= 1.4;
        const pivot = part.pivot;
        const px = pivot[0], py = pivot[1], pz = pivot[2];
        tmpPivot.makeTranslation(px / 16, py / 16, pz / 16);
        tmpRot.makeRotationFromEuler(rot);
        tmpM.copy(tmpBase).multiply(tmpPivot).multiply(tmpRot);
        // Babies have big heads (Minecraft scales the baby body to half but the head only to three quarters).
        if (m.baby && part.anim === 'head') tmpM.multiply(tmpScaleM.makeScale(1.5, 1.5, 1.5));
        tmpPivot.makeTranslation(-px / 16, -py / 16, -pz / 16);
        tmpM.multiply(tmpPivot);
        pm.mesh.setMatrixAt(index, tmpM);
        const d = pm.data.array as Float32Array;
        d[index * 4] = (light >> 4) / 15;
        d[index * 4 + 1] = (light & 15) / 15;
        d[index * 4 + 2] = hurt;
        d[index * 4 + 3] = flash;
        const t = pm.tint.array as Float32Array;
        const c = part.tint === 'dye' ? dye : part.tint === 'coat' ? coat : null;
        t[index * 4] = c ? c[0] : 1;
        t[index * 4 + 1] = c ? c[1] : 1;
        t[index * 4 + 2] = c ? c[2] : 1;
        pm.mesh.count = index + 1;
      }

      // Blob shadow on the ground below (searching down a few blocks while the mob is in the air).
      if (shadows < MAX_SHADOWS && camD2 < shadowR2 && !m.dead) {
        let gy = y;
        if (!m.onGround) {
          const bx = Math.floor(x), bz = Math.floor(z);
          let by = Math.floor(y);
          for (let k = 0; k < 4 && by > 0 && !SOLID[world.getBlock(bx, by - 1, bz)]; k++) by--;
          gy = by;
        }
        const fade = Math.max(0, 1 - (y - gy) / 4) * (1 - Math.sqrt(camD2) / 48);
        if (fade > 0.02) {
          const r = Math.max(m.width, 0.3) * 1.1;
          tmpPos.set(x, gy + 0.02, z);
          tmpScale.set(r, 1, r);
          tmpQuat.identity();
          this.shadows.setMatrixAt(shadows, tmpM.compose(tmpPos, tmpQuat, tmpScale));
          sd[shadows] = fade * Math.min(1, (light >> 4) / 15 + (light & 15) / 15 + 0.3) * 0.45;
          shadows++;
        }
      }
    }
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      // Types without any mob cost no draw call.
      p.mesh.visible = p.mesh.count > 0;
      if (p.mesh.count === 0) continue;
      p.mesh.instanceMatrix.needsUpdate = true;
      p.data.needsUpdate = true;
      p.tint.needsUpdate = true;
    }
    this.shadows.count = shadows;
    this.shadows.visible = shadows > 0;
    if (shadows > 0) { this.shadows.instanceMatrix.needsUpdate = true; this.shadowData.needsUpdate = true; }
    this.updateEmotes(dt);
  }

  private updateEmotes(dt: number): void {
    const ed = this.emoteData.array as Float32Array;
    let n = 0;
    for (let i = 0; i < MAX_EMOTES; i++) {
      if (this.emoteLife[i] <= 0) continue;
      this.emoteLife[i] -= dt / 1.2;
      if (this.emoteLife[i] <= 0) continue;
      this.emotePos[i * 3 + 1] += dt * 0.6;
      ed[n * 4] = this.emotePos[i * 3];
      ed[n * 4 + 1] = this.emotePos[i * 3 + 1];
      ed[n * 4 + 2] = this.emotePos[i * 3 + 2];
      ed[n * 4 + 3] = this.emoteKind[i] + Math.min(1, this.emoteLife[i] * 3) * 0.99;
      n++;
    }
    this.emotes.count = n;
    this.emotes.visible = n > 0;
    if (n > 0) this.emoteData.needsUpdate = true;
  }

  private hidden(part: ModelPart, m: Mob): boolean {
    if (part.only === 'tamed') return !m.tamed;
    if (part.only === 'saddled') return !m.saddled;
    // A shorn sheep shows its skin.
    return part.tint === 'dye' && m.type.kind === 'sheep' && (m.variant & 16) !== 0;
  }

  private partRotation(part: ModelPart, swing: number, amount: number, m: Mob, alpha: number): THREE.Euler {
    const anim: PartAnim = part.anim;
    const legSwing = Math.cos(swing * 0.6662) * 1.4 * amount;
    const rest = part.rest;
    const rx = rest ? rest[0] : 0, ry = rest ? rest[1] : 0, rz = rest ? rest[2] : 0;
    switch (anim) {
      case 'spiderA':
      case 'spiderB': {
        // Minecraft's spider gait: legs sweep forward/back and lift, alternating sets.
        const phase = anim === 'spiderA' ? 0 : Math.PI;
        const sweep = Math.cos(swing * 0.6662 * 2 + phase) * 0.4 * amount;
        const lift = Math.abs(Math.sin(swing * 0.6662 + phase)) * 0.4 * amount;
        const side = rz > 0 ? 1 : -1;
        return tmpEuler.set(rx, ry + sweep * side, rz - lift * side, 'YXZ');
      }
      case 'head': {
        // Grazing sheep lower their head to the grass.
        const graze = m.type.kind === 'sheep' && m.busy > 0 ? 1.1 * Math.min(1, Math.min(m.busy, 40 - m.busy) / 4) : 0;
        return tmpEuler.set(-m.headPitch + graze + rx, m.headYaw + ry, rz, 'YXZ');
      }
      case 'tail': {
        // Wolves wag (tamed ones higher), horses swish.
        const wag = Math.sin((m.age + alpha) * (m.type.kind === 'wolf' ? 0.6 : 0.12)) * (m.type.kind === 'wolf' ? 0.45 : 0.15);
        const lift = m.type.kind === 'wolf' && (m.tamed || m.angryTicks > 0) ? -0.5 : 0;
        return tmpEuler.set(rx + lift + amount * 0.3 * (m.type.kind === 'horse' ? -1 : 0), ry, rz + wag, 'YXZ');
      }
      case 'legA': return tmpEuler.set(legSwing + rx, ry, rz);
      case 'legB': return tmpEuler.set(-legSwing + rx, ry, rz);
      case 'armL':
      case 'armR': {
        // Armed arcade players aim: the right arm points along the view, the left supports it.
        if (m.holding) {
          const pitch = -m.headPitch; // positive = aiming up
          return anim === 'armR' ? tmpEuler.set(Math.PI / 2 + pitch, 0, 0, 'YXZ') : tmpEuler.set(Math.PI / 2 + pitch - 0.25, -0.5, 0, 'YXZ');
        }
        const phase = swing * 0.6662 + (anim === 'armL' ? 0 : Math.PI);
        // Zombies hold their arms forward (an angry enderman too); players swing them opposite to the legs.
        if (m.type.armsForward || (m.type.kind === 'enderman' && m.angryTicks > 0)) return tmpEuler.set(Math.PI / 2 + Math.cos(phase) * 0.2 * amount, 0, 0);
        // Long limbs (endermen) swing less.
        const k = m.type.kind === 'enderman' ? 0.4 : 1;
        return tmpEuler.set(Math.cos(phase) * amount * k, 0, 0);
      }
      case 'wingL':
      case 'wingR': {
        // Chickens flap while airborne.
        const flap = m.onGround ? 0 : (Math.sin((m.age + alpha) * 1.6) + 1) * 0.7;
        return tmpEuler.set(0, 0, anim === 'wingL' ? -flap : flap);
      }
      default: return tmpEuler.set(rx, ry, rz);
    }
  }
}

/** 4 emote sprites of 8×8 px side by side: heart, smoke puff, angry cloud, purple poof. */
function paintEmotes(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 8;
  const ctx = c.getContext('2d')!;
  const px = (x: number, y: number, col: string) => { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); };
  const heart = ['.XX.XX..', 'XRRXRRX.', 'XRWRRRX.', 'XRRRRRX.', '.XRRRX..', '..XRX...', '...X....', '........'];
  heart.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === 'X') px(x, y, '#5a0d0d'); else if (ch === 'R') px(x, y, '#e8262a'); else if (ch === 'W') px(x, y, '#ffb4b4');
  }));
  const puff = (ox: number, light: string, dark: string) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const d = Math.hypot(x - 3.5, y - 3.5);
      if (d < 3.6) px(ox + x, y, d < 2 ? light : dark);
    }
  };
  puff(8, '#d8d8d8', '#9a9a9a');
  puff(16, '#4a4a4a', '#2a2a2a');
  for (const [x, y] of [[2, 3], [3, 2], [4, 3], [3, 4]]) px(16 + x, y, '#c41414');
  puff(24, '#d27cf2', '#8a2ab0');
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function createEmoteMaterial(u: WorldUniforms, map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uMap: { value: map } },
    vertexShader: /* glsl */ `
      attribute vec4 iEmote;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float kind = floor(iEmote.w);
        float size = 0.32 * fract(iEmote.w) + 0.02;
        vec3 world = iEmote.xyz + (right * position.x + up * position.y) * size;
        vUv = vec2((kind + uv.x) / 4.0, uv.y);
        vWorldPos = world;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      ${FOG_GLSL}
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vec4 tex = texture2D(uMap, vUv);
        if (tex.a < 0.5) discard;
        gl_FragColor = vec4(applyFog(tex.rgb, vWorldPos), 1.0);
      }
    `,
  });
}

function createShadowMaterial(u: WorldUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute float iAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vUv = uv;
        vAlpha = iAlpha;
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vWorldPos;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.55, 1.0, d)) * vAlpha;
        if (a < 0.01) discard;
        // Fade out with the fog like everything else.
        float fogAmount = smoothstep(uFogNear, uFogFar, length((vWorldPos - cameraPosition).xz));
        gl_FragColor = vec4(0.0, 0.0, 0.0, a * (1.0 - fogAmount));
      }
    `,
  });
}

function createMobMaterial(u: WorldUniforms, map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uMap: { value: map } },
    vertexShader: /* glsl */ `
      attribute vec4 iData;
      attribute vec4 iTint;
      varying vec2 vUv;
      varying vec4 vData;
      varying vec3 vTint;
      varying float vShade;
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vec3 n = normalize(mat3(instanceMatrix) * normal);
        // Minecraft-like face shading.
        vShade = n.y > 0.5 ? 1.0 : n.y < -0.5 ? 0.5 : abs(n.x) > abs(n.z) ? 0.65 : 0.82;
        vUv = uv;
        vData = iData;
        vTint = iTint.rgb;
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      ${FOG_GLSL}
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec4 vData;
      varying vec3 vTint;
      varying float vShade;
      varying vec3 vWorldPos;
      void main() {
        vec4 tex = texture2D(uMap, vUv);
        if (tex.a < 0.5) discard;
        vec3 light = combineLight(vData.x, vData.y, 1.0);
        vec3 c = tex.rgb * vTint * light * vShade;
        c = mix(c, vec3(1.0, 0.15, 0.1) * max(light.r, 0.3), vData.z * 0.5);
        c = mix(c, vec3(1.0), vData.w * 0.7);
        gl_FragColor = vec4(applyFog(c, vWorldPos), 1.0);
      }
    `,
  });
}
