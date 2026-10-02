import * as THREE from 'three';
import { FOG_GLSL, LIGHT_GLSL, type WorldUniforms } from '../rendering/Materials';
import type { World } from '../world/World';
import type { Mob } from './Mob';
import { MOB_TYPES, type MobKind, type ModelBox, type ModelPart, type PartAnim } from './MobTypes';

const MAX_PER_TYPE = 48;
const TEX_W = 128;
const TEX_H = 64;

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
}

const tmpM = new THREE.Matrix4();
const tmpBase = new THREE.Matrix4();
const tmpPivot = new THREE.Matrix4();
const tmpRot = new THREE.Matrix4();
const tmpEuler = new THREE.Euler();
const tmpScale = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

/**
 * Renders all mobs with one InstancedMesh per model part (≈6 draw calls per mob type,
 * independent of how many mobs exist). Parts are posed on the CPU each frame.
 */
export class MobRenderer {
  readonly group = new THREE.Group();
  private readonly types = new Map<MobKind, PartMesh[]>();
  /** Flat list of all part meshes (iterating the map each frame would allocate iterators). */
  private readonly all: PartMesh[] = [];

  private frame = 0;
  /** Mobs further than the fog end are invisible anyway: skip their posing and instances. */
  private readonly fogFar: { value: number };

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
        const mesh = new THREE.InstancedMesh(geo, material, MAX_PER_TYPE);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.group.add(mesh);
        const pm = { part, mesh, data };
        this.all.push(pm);
        return pm;
      });
      this.types.set(type.kind, parts);
    }
  }

  update(mobs: Mob[], alpha: number, world: World, cam: THREE.Vector3): void {
    const all = this.all;
    this.frame++;
    const cullR = this.fogFar.value + 8;
    const cull2 = cullR * cullR;
    for (let i = 0; i < all.length; i++) all[i].mesh.count = 0;
    for (let mi = 0; mi < mobs.length; mi++) {
      const m = mobs[mi];
      const cdx = m.x - cam.x, cdz = m.z - cam.z;
      if (cdx * cdx + cdz * cdz > cull2) continue;
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

      // Creeper swelling (scale up and flash white) before it explodes.
      const swell = 1 + Math.sin(fuse * 100) * fuse * 0.01 + fuse * fuse * 0.35;
      tmpScale.set(swell * (1 + fuse * 0.1), swell, swell * (1 + fuse * 0.1));
      tmpPos.set(x, y, z);
      // Death: roll onto the side over 20 ticks.
      const death = m.dead ? Math.min(1, Math.sqrt((m.deathTime + alpha) / 20)) * (Math.PI / 2) : 0;
      tmpQuat.setFromEuler(tmpEuler.set(0, yaw, death, 'YXZ'));
      tmpBase.compose(tmpPos, tmpQuat, tmpScale);

      const light = m.lightAt(world, this.frame, x, y + m.height * 0.6, z);
      const hurt = m.hurtTime > 0 || m.dead ? 1 : m.burning > 0 ? 0.5 : 0;
      const flash = fuse > 0 && Math.floor(fuse * 30 / 4) % 2 === 0 ? fuse : 0;

      for (let pi = 0; pi < parts.length; pi++) {
        const pm = parts[pi];
        const rot = this.partRotation(pm.part, swing, amount, m, alpha);
        const pivot = pm.part.pivot;
        const px = pivot[0], py = pivot[1], pz = pivot[2];
        tmpPivot.makeTranslation(px / 16, py / 16, pz / 16);
        tmpRot.makeRotationFromEuler(rot);
        tmpM.copy(tmpBase).multiply(tmpPivot).multiply(tmpRot);
        tmpPivot.makeTranslation(-px / 16, -py / 16, -pz / 16);
        tmpM.multiply(tmpPivot);
        pm.mesh.setMatrixAt(index, tmpM);
        const d = pm.data.array as Float32Array;
        d[index * 4] = (light >> 4) / 15;
        d[index * 4 + 1] = (light & 15) / 15;
        d[index * 4 + 2] = hurt;
        d[index * 4 + 3] = flash;
        pm.mesh.count = index + 1;
      }
    }
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      // Types without any mob cost no draw call.
      p.mesh.visible = p.mesh.count > 0;
      if (p.mesh.count === 0) continue;
      p.mesh.instanceMatrix.needsUpdate = true;
      p.data.needsUpdate = true;
    }
  }

  private partRotation(part: ModelPart, swing: number, amount: number, m: Mob, alpha: number): THREE.Euler {
    const anim: PartAnim = part.anim;
    const legSwing = Math.cos(swing * 0.6662) * 1.4 * amount;
    switch (anim) {
      case 'spiderA':
      case 'spiderB': {
        // Minecraft's spider gait: legs sweep forward/back and lift, alternating sets.
        const phase = anim === 'spiderA' ? 0 : Math.PI;
        const sweep = Math.cos(swing * 0.6662 * 2 + phase) * 0.4 * amount;
        const lift = Math.abs(Math.sin(swing * 0.6662 + phase)) * 0.4 * amount;
        const rest = part.rest;
        const rx = rest ? rest[0] : 0, ry = rest ? rest[1] : 0, rz = rest ? rest[2] : 0;
        const side = rz > 0 ? 1 : -1;
        return tmpEuler.set(rx, ry + sweep * side, rz - lift * side, 'YXZ');
      }
      case 'head': return tmpEuler.set(-m.headPitch, m.headYaw, 0, 'YXZ');
      case 'legA': return tmpEuler.set(legSwing, 0, 0);
      case 'legB': return tmpEuler.set(-legSwing, 0, 0);
      case 'armL':
      case 'armR': {
        // Armed arcade players aim: the right arm points along the view, the left supports it.
        if (m.holding) {
          const pitch = -m.headPitch; // positive = aiming up
          return anim === 'armR' ? tmpEuler.set(Math.PI / 2 + pitch, 0, 0, 'YXZ') : tmpEuler.set(Math.PI / 2 + pitch - 0.25, -0.5, 0, 'YXZ');
        }
        const phase = swing * 0.6662 + (anim === 'armL' ? 0 : Math.PI);
        // Zombies hold their arms forward; players swing them opposite to the legs.
        if (m.type.armsForward) return tmpEuler.set(Math.PI / 2 + Math.cos(phase) * 0.2 * amount, 0, 0);
        return tmpEuler.set(Math.cos(phase) * amount, 0, 0);
      }
      case 'wingL':
      case 'wingR': {
        // Chickens flap while airborne.
        const flap = m.onGround ? 0 : (Math.sin((m.age + alpha) * 1.6) + 1) * 0.7;
        return tmpEuler.set(0, 0, anim === 'wingL' ? -flap : flap);
      }
      default: return tmpEuler.set(0, 0, 0);
    }
  }
}

function createMobMaterial(u: WorldUniforms, map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uMap: { value: map } },
    vertexShader: /* glsl */ `
      attribute vec4 iData;
      varying vec2 vUv;
      varying vec4 vData;
      varying float vShade;
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vec3 n = normalize(mat3(instanceMatrix) * normal);
        // Minecraft-like face shading.
        vShade = n.y > 0.5 ? 1.0 : n.y < -0.5 ? 0.5 : abs(n.x) > abs(n.z) ? 0.65 : 0.82;
        vUv = uv;
        vData = iData;
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
      varying float vShade;
      varying vec3 vWorldPos;
      void main() {
        vec4 tex = texture2D(uMap, vUv);
        if (tex.a < 0.5) discard;
        vec3 light = combineLight(vData.x, vData.y, 1.0);
        vec3 c = tex.rgb * light * vShade;
        c = mix(c, vec3(1.0, 0.15, 0.1) * max(light.r, 0.3), vData.z * 0.5);
        c = mix(c, vec3(1.0), vData.w * 0.7);
        gl_FragColor = vec4(applyFog(c, vWorldPos), 1.0);
      }
    `,
  });
}
