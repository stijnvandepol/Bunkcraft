import * as THREE from 'three';
import { FOG_GLSL, LIGHT_GLSL, type WorldUniforms } from '../rendering/Materials';
import type { XpOrb } from './XpOrb';

const MAX = 192;
const TIERS = 11;

/** Orb sprites of the 11 size tiers side by side (0 smallest .. 10 largest), grey so the shader can colour them. */
function paintOrbs(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16 * TIERS;
  c.height = 16;
  const ctx = c.getContext('2d')!;
  for (let t = 0; t < TIERS; t++) {
    const r = 2.5 + t * 0.5;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = x + 0.5 - 8, dy = y + 0.5 - 8;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        // Bright core, darker rim, a highlight at the top left: the pixel look of Minecraft's orbs.
        const rim = d > r - 1;
        const hi = !rim && dx < -r * 0.2 && dy < -r * 0.2;
        const v = rim ? 0.45 : hi ? 1 : 0.78;
        const c8 = Math.round(255 * v);
        ctx.fillStyle = `rgb(${c8},${c8},${c8})`;
        ctx.fillRect(t * 16 + x, y, 1, 1);
      }
    }
  }
  return c;
}

/**
 * Experience orbs as glowing billboards (one instanced draw call). They ignore world light (they glow) and pulse between
 * green and yellow like Minecraft's; the sprite size follows the value tier.
 */
export class XpOrbRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iData: THREE.InstancedBufferAttribute;
  private readonly time = { value: 0 };

  constructor(uniforms: WorldUniforms) {
    const texture = new THREE.CanvasTexture(paintOrbs());
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iData', this.iData);
    g.instanceCount = 0;
    this.geometry = g;
    const material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uOrbs: { value: texture }, uTime: this.time },
      vertexShader: /* glsl */ `
        attribute vec4 iPos;   // xyz + size
        attribute vec4 iData;  // tier, phase
        varying vec2 vUv;
        varying float vPhase;
        varying vec3 vWorldPos;
        void main() {
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 world = iPos.xyz + (right * position.x + up * position.y) * iPos.w;
          vUv = vec2((iData.x + uv.x) / ${TIERS.toFixed(1)}, uv.y);
          vPhase = iData.y;
          vWorldPos = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${FOG_GLSL}
        uniform sampler2D uOrbs;
        uniform float uTime;
        varying vec2 vUv;
        varying float vPhase;
        varying vec3 vWorldPos;
        void main() {
          vec4 tex = texture2D(uOrbs, vUv);
          if (tex.a < 0.5) discard;
          // Minecraft: red = (sin(t) + 1) / 2, green = 1, blue = (sin(t + 4.19) + 1) / 10.
          float t = uTime * 6.0 + vPhase;
          vec3 pulse = vec3((sin(t) + 1.0) * 0.5, 1.0, (sin(t + 4.18879) + 1.0) * 0.1);
          gl_FragColor = vec4(applyFog(tex.rgb * pulse * 1.15, vWorldPos), 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  update(orbs: XpOrb[], alpha: number, time: number): void {
    const n = Math.min(orbs.length, MAX);
    this.time.value = time;
    const p = this.iPos.array as Float32Array, d = this.iData.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const o = orbs[i];
      const tier = o.tier;
      p[i * 4] = o.prevX + (o.x - o.prevX) * alpha;
      p[i * 4 + 1] = o.prevY + (o.y - o.prevY) * alpha + 0.25;
      p[i * 4 + 2] = o.prevZ + (o.z - o.prevZ) * alpha;
      p[i * 4 + 3] = 0.42;
      d[i * 4] = tier;
      d[i * 4 + 1] = (o.netId % 17) * 0.37;
    }
    this.iPos.needsUpdate = true;
    this.iData.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}
