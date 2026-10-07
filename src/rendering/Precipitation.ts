import * as THREE from 'three';
import { CHUNK_HEIGHT, blockIndex } from '../world/constants';
import { BLOCK } from '../world/BlockRegistry';
import { Precip, blocksPrecipitation, precipitationFor } from '../world/Weather';
import { FOG_GLSL, LIGHT_GLSL, type WorldUniforms } from './Materials';

/** Columns of the occlusion window around the player (power of two: the shader wraps with & 63). */
const WINDOW = 64;
/** Half size of the particle volume in blocks. */
const RADIUS = 16;
/** Most particles (scaled down by the particle setting). */
export const MAX_PRECIPITATION = 6000;
/** Rows of the window refreshed per frame in steady state / while filling. */
const ROWS_STEADY = 2;
const ROWS_WARM = 8;

export interface PrecipitationWorld {
  chunks: { get(cx: number, cz: number): { blocks: Uint8Array | null; biomes: Uint8Array | null } | undefined };
}

/**
 * Rain and snow as one instanced draw call around the camera, simulated entirely in the
 * vertex shader (nothing is allocated or uploaded per frame except a small occlusion mask).
 *
 * The mask is a 64×64 top-down map of the columns around the player: the height of the
 * highest block that stops rain, the kind of precipitation (rain, snow or none from the
 * biome and altitude) and whether that block is water. A particle only exists above the
 * top of its column, so nothing falls indoors or under trees, drops end exactly on the
 * ground and splash there (ripples on water), and rain turns to slow wobbling snow in
 * cold biomes. The mask refreshes a couple of rows per frame (a full refresh in half a
 * second), so building a roof under the rain takes effect almost immediately.
 */
export class Precipitation {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly mask: THREE.DataTexture;
  private readonly maskData: Uint8Array;
  private readonly uniforms: { [k: string]: THREE.IUniform };
  /** Particle setting factor (1 = all). */
  density = 1;
  private cursor = 0;
  private warmRows = WINDOW;
  private lastX = 0;
  private lastZ = 0;
  private active = false;

  constructor(world: WorldUniforms) {
    const seed = new Float32Array(MAX_PRECIPITATION * 4);
    // A tiny deterministic generator: the look must not change between runs.
    let s = 0x9e3779b9;
    const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296);
    for (let i = 0; i < MAX_PRECIPITATION; i++) {
      seed[i * 4] = rnd();
      seed[i * 4 + 1] = rnd();
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = rnd();
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = 0;
    this.geometry = g;

    this.maskData = new Uint8Array(WINDOW * WINDOW * 4);
    this.mask = new THREE.DataTexture(this.maskData, WINDOW, WINDOW, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.generateMipmaps = false;
    this.mask.needsUpdate = true;

    this.uniforms = {
      ...world,
      uMask: { value: this.mask },
      /** Rain strength 0..1: the share of particles that is visible. */
      uLevel: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // One pass: three would draw a transparent double-sided material twice (back faces, then front faces) and look
      // its program up both times. Thin streaks without depth writes look the same in one pass.
      forceSinglePass: true,
      vertexShader: /* glsl */ `
        attribute vec4 iSeed;
        uniform sampler2D uMask;
        uniform float uTime;
        uniform float uLevel;
        varying vec2 vUv;
        varying float vKind;
        varying float vAlpha;
        varying float vAge;
        varying vec3 vWorldPos;

        const float R = ${RADIUS.toFixed(1)};
        const float H = 26.0;

        void main() {
          // Fixed world position inside the volume, wrapped around the camera.
          vec2 camMin = floor(cameraPosition.xz) - R;
          vec2 w = camMin + mod(iSeed.xy * (2.0 * R) - camMin, 2.0 * R);
          ivec2 texel = ivec2(int(floor(w.x)) & 63, int(floor(w.y)) & 63);
          vec4 m = texelFetch(uMask, texel, 0) * 255.0;
          float type = floor(m.g * 0.01 + 0.5);                 // 0 none, 1 rain, 2 snow
          vec2 off = w - cameraPosition.xz;
          float edge = length(off) / R;
          if (type < 0.5 || iSeed.w > uLevel || edge > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float surface = m.r + (m.b > 128.0 ? 0.88 : 1.0);

          vec3 pos; float alpha;
          if (type < 1.5) {
            // Rain: a streak falls to the surface, then a ripple spreads for a moment.
            float speed = 16.0 + iSeed.z * 5.0;
            float fall = H / speed;
            float period = fall + 0.35;
            float t = fract(iSeed.z * 7.0 - uTime / period) * period;
            vec3 toCam = cameraPosition - vec3(w.x, surface, w.y);
            float dist = length(toCam);
            if (t < fall) {
              float head = surface + (fall - t) * speed;
              float len = 0.55 + speed * 0.025;
              float width = max(0.03, dist * 0.0022);
              vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(toCam.x, 0.0, toCam.z) + 1e-4));
              pos = vec3(w.x, head, w.y) + right * position.x * width + vec3(0.0, position.y * len, 0.0);
              vKind = 0.0;
              alpha = 0.55;
              vAge = 0.0;
            } else {
              float age = (t - fall) / 0.35;
              float size = (m.b > 128.0 ? 0.28 : 0.18) + age * (m.b > 128.0 ? 0.5 : 0.28);
              pos = vec3(w.x + (position.x) * size * 2.0, surface + 0.02, w.y + (position.y - 0.5) * size * 2.0);
              vKind = 1.0;
              alpha = (1.0 - age) * (m.b > 128.0 ? 0.55 : 0.3);
              vAge = age;
            }
          } else {
            // Snow: slow flakes that wobble sideways.
            float speed = 1.9 + iSeed.z * 1.4;
            float period = H / speed;
            float t = fract(iSeed.z * 5.0 - uTime / period);
            float head = surface + t * H;
            float ph = iSeed.x * 40.0 + uTime * (0.7 + iSeed.y);
            vec3 center = vec3(w.x + sin(ph) * 0.45, head, w.y + cos(ph * 0.83) * 0.4);
            vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            float size = max(0.085, length(cameraPosition - center) * 0.004);
            pos = center + (right * (position.x) + up * (position.y - 0.5)) * size;
            vKind = 2.0;
            alpha = 0.95;
            vAge = 0.0;
          }
          // Fade at the edge of the volume and very close to the camera.
          vAlpha = alpha * (1.0 - smoothstep(0.7, 1.0, edge)) * smoothstep(1.0, 3.5, length(cameraPosition - pos));
          vUv = uv;
          vWorldPos = pos;
          gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${FOG_GLSL}
        varying vec2 vUv;
        varying float vKind;
        varying float vAlpha;
        varying float vAge;
        varying vec3 vWorldPos;
        void main() {
          vec3 base; float a = vAlpha;
          if (vKind < 0.5) {
            base = vec3(0.62, 0.72, 0.95);
            a *= 0.45 + 0.55 * vUv.y; // brighter at the head
          } else if (vKind < 1.5) {
            vec2 p = vUv * 2.0 - 1.0;
            float r = max(abs(p.x), abs(p.y));          // square ring, pixel style
            a *= smoothstep(0.55, 0.8, r) * (1.0 - smoothstep(0.88, 1.0, r));
            base = vec3(0.75, 0.82, 1.0);
          } else {
            base = vec3(1.0);
          }
          if (a < 0.01) discard;
          vec3 color = base * combineLight(1.0, 0.0, 1.0);
          gl_FragColor = vec4(applyFog(color, vWorldPos), a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  /** Called every frame with the weather level (0..1); cheap while it is dry. */
  update(world: PrecipitationWorld | null, camX: number, camZ: number, level: number, underwater: boolean): void {
    const on = level > 0.002 && world !== null && !underwater;
    this.mesh.visible = on;
    if (!on) {
      this.active = false;
      return;
    }
    if (!this.active || Math.abs(camX - this.lastX) > 24 || Math.abs(camZ - this.lastZ) > 24) this.warmRows = WINDOW;
    this.active = true;
    this.lastX = camX;
    this.lastZ = camZ;
    this.uniforms.uLevel.value = level;
    this.geometry.instanceCount = Math.floor(MAX_PRECIPITATION * this.density);
    const rows = this.warmRows > 0 ? ROWS_WARM : ROWS_STEADY;
    this.warmRows = Math.max(0, this.warmRows - rows);
    this.refreshRows(world, camX, camZ, rows);
  }

  private refreshRows(world: PrecipitationWorld, camX: number, camZ: number, rows: number): void {
    const baseX = Math.floor(camX) - WINDOW / 2;
    const baseZ = Math.floor(camZ) - WINDOW / 2;
    const data = this.maskData;
    for (let r = 0; r < rows; r++) {
      const z = baseZ + (this.cursor++ % WINDOW);
      const row = (z & (WINDOW - 1)) * WINDOW;
      let chunk: ReturnType<PrecipitationWorld['chunks']['get']> = undefined;
      let ccx = 0x7fffffff;
      for (let i = 0; i < WINDOW; i++) {
        const x = baseX + i;
        const cx = x >> 4;
        if (cx !== ccx) { chunk = world.chunks.get(cx, z >> 4); ccx = cx; }
        const o = (row + (x & (WINDOW - 1))) * 4;
        const blocks = chunk?.blocks;
        if (!blocks) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255; continue; }
        const lx = x & 15, lz = z & 15;
        let y = CHUNK_HEIGHT - 1;
        for (; y > 0; y--) if (blocksPrecipitation(blocks[blockIndex(lx, y, lz)])) break;
        const biome = chunk!.biomes ? chunk!.biomes[lx | (lz << 4)] : 2;
        const kind = precipitationFor(biome, y);
        data[o] = y;
        data[o + 1] = kind === Precip.RAIN ? 100 : kind === Precip.SNOW ? 200 : 0;
        data[o + 2] = blocks[blockIndex(lx, y, lz)] === BLOCK.WATER ? 255 : 0;
        data[o + 3] = 255;
      }
    }
    this.mask.needsUpdate = true;
  }

  /** Active particle count, for the debug screen. */
  get count(): number {
    return this.mesh.visible ? this.geometry.instanceCount : 0;
  }
}
