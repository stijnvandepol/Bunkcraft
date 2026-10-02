import * as THREE from 'three';
import { FACE_LAYER, OPAQUE, SOLID } from '../world/BlockRegistry';
import type { WorldUniforms } from './Materials';

const MAX = 1024;

export interface BlockQuery {
  getBlock(x: number, y: number, z: number): number;
  getLight(x: number, y: number, z: number): number;
}

/**
 * Block-fragment particles. All particles live in preallocated typed arrays and are
 * drawn as one instanced billboard quad (a single draw call); nothing is allocated
 * while playing.
 */
export class Particles {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iData: THREE.InstancedBufferAttribute;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly data = new Float32Array(MAX * 4); // layer, u, v, size
  private readonly light = new Float32Array(MAX * 2);
  private readonly iLight: THREE.InstancedBufferAttribute;
  private readonly iTint: THREE.InstancedBufferAttribute;
  /** rgb biome tint + mode (1 = tint whole texture, 0 = alpha-masked like opaque blocks). */
  private readonly tint = new Float32Array(MAX * 4);
  private count = 0;
  /** Spawn multiplier from settings (1 = all, 0.4 = decreased, 0.12 = minimal). */
  density = 1;

  constructor(uniforms: WorldUniforms) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iLight = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iData', this.iData);
    g.setAttribute('iLight', this.iLight);
    this.iTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iTint', this.iTint);
    g.instanceCount = 0;
    this.geometry = g;

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec4 iData;
        attribute vec2 iLight;
        attribute vec4 iTint;
        varying vec4 vTint;
        varying vec2 vUv;
        flat varying float vLayer;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 world = iPos + (right * position.x + up * position.y) * iData.w;
          // A random 4×4 texel window of the block texture, like Minecraft's break particles.
          vUv = iData.yz + uv * 0.25;
          vLayer = iData.x;
          vLight = iLight;
          vTint = iTint;
          vWorldPos = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        uniform float uDaylight;
        uniform vec3 uSkyLightColor;
        uniform vec3 uFogColor;
        uniform float uFogNear, uFogFar;
        varying vec2 vUv;
        flat varying float vLayer;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        varying vec4 vTint;
        void main() {
          vec4 tex = textureLod(uAtlas, vec3(vUv, vLayer), 0.0);
          if (tex.a < 0.4) discard;
          float m = vTint.a > 0.5 ? 1.0 : clamp((1.0 - tex.a) * 2.0, 0.0, 1.0);
          tex.rgb *= mix(vec3(1.0), vTint.rgb, m);
          vec3 l = max(uSkyLightColor * vLight.x * uDaylight, vec3(1.0, 0.86, 0.66) * vLight.y);
          vec3 c = tex.rgb * max(l, vec3(0.06));
          float f = smoothstep(uFogNear, uFogFar, length(vWorldPos.xz - cameraPosition.xz));
          gl_FragColor = vec4(mix(c, uFogColor, f), 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  get active(): number {
    return this.count;
  }

  /** Burst of fragments filling the block volume (break). */
  spawnBreak(x: number, y: number, z: number, blockId: number, light: number, tint = 0xffffff): void {
    const n = Math.max(2, Math.round(4 * this.density));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const px = x + (i + 0.5) / n, py = y + (j + 0.5) / n, pz = z + (k + 0.5) / n;
      const face = Math.random() < 0.3 ? 2 : 0;
      this.emit(px, py, pz, (px - x - 0.5) * 3 + (Math.random() - 0.5), (py - y - 0.5) * 3 + 2 + Math.random() * 2,
        (pz - z - 0.5) * 3 + (Math.random() - 0.5), blockId, face, light, 0.6 + Math.random() * 0.6, tint);
    }
  }

  /** A few fragments on the face being mined or where a block was placed. */
  spawnFace(x: number, y: number, z: number, nx: number, ny: number, nz: number, blockId: number, light: number, amount: number, tint = 0xffffff): void {
    const n = Math.max(1, Math.round(amount * this.density));
    for (let i = 0; i < n; i++) {
      const px = x + 0.5 + nx * 0.52 + (nx === 0 ? Math.random() - 0.5 : 0);
      const py = y + 0.5 + ny * 0.52 + (ny === 0 ? Math.random() - 0.5 : 0);
      const pz = z + 0.5 + nz * 0.52 + (nz === 0 ? Math.random() - 0.5 : 0);
      this.emit(px, py, pz, nx * 1.5 + (Math.random() - 0.5) * 1.5, ny * 1.5 + 1 + Math.random(),
        nz * 1.5 + (Math.random() - 0.5) * 1.5, blockId, 0, light, 0.35 + Math.random() * 0.4, tint);
    }
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, blockId: number, face: number, light: number, life: number, tint: number): void {
    if (this.count >= MAX) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.data[i * 4] = FACE_LAYER[blockId * 6 + face];
    this.data[i * 4 + 1] = Math.floor(Math.random() * 12) / 16;
    this.data[i * 4 + 2] = Math.floor(Math.random() * 12) / 16;
    this.data[i * 4 + 3] = 0.09 + Math.random() * 0.07;
    this.light[i * 2] = (light >> 4) / 15;
    this.light[i * 2 + 1] = (light & 15) / 15;
    this.tint[i * 4] = (tint >> 16) / 255;
    this.tint[i * 4 + 1] = ((tint >> 8) & 255) / 255;
    this.tint[i * 4 + 2] = (tint & 255) / 255;
    this.tint[i * 4 + 3] = OPAQUE[blockId] ? 0 : 1;
  }

  update(dt: number, world: BlockQuery): void {
    const p = this.pos, v = this.vel;
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove keeps the active range dense.
        const last = --this.count;
        if (i !== last) {
          p.copyWithin(i * 3, last * 3, last * 3 + 3);
          v.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.data.copyWithin(i * 4, last * 4, last * 4 + 4);
          this.light.copyWithin(i * 2, last * 2, last * 2 + 2);
          this.tint.copyWithin(i * 4, last * 4, last * 4 + 4);
          this.life[i] = this.life[last];
        }
        continue;
      }
      v[i * 3 + 1] -= 18 * dt;
      const nx = p[i * 3] + v[i * 3] * dt;
      const ny = p[i * 3 + 1] + v[i * 3 + 1] * dt;
      const nz = p[i * 3 + 2] + v[i * 3 + 2] * dt;
      if (SOLID[world.getBlock(Math.floor(nx), Math.floor(ny - 0.05), Math.floor(nz))] && v[i * 3 + 1] < 0) {
        v[i * 3 + 1] = 0;
        v[i * 3] *= 0.6; v[i * 3 + 2] *= 0.6;
        p[i * 3] += v[i * 3] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
      } else {
        p[i * 3] = nx; p[i * 3 + 1] = ny; p[i * 3 + 2] = nz;
      }
      i++;
    }
    const n = this.count;
    (this.iPos.array as Float32Array).set(p.subarray(0, n * 3));
    (this.iData.array as Float32Array).set(this.data.subarray(0, n * 4));
    (this.iLight.array as Float32Array).set(this.light.subarray(0, n * 2));
    (this.iTint.array as Float32Array).set(this.tint.subarray(0, n * 4));
    this.iPos.clearUpdateRanges(); this.iPos.addUpdateRange(0, n * 3); this.iPos.needsUpdate = true;
    this.iData.clearUpdateRanges(); this.iData.addUpdateRange(0, n * 4); this.iData.needsUpdate = true;
    this.iLight.clearUpdateRanges(); this.iLight.addUpdateRange(0, n * 2); this.iLight.needsUpdate = true;
    this.iTint.clearUpdateRanges(); this.iTint.addUpdateRange(0, n * 4); this.iTint.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }
}
