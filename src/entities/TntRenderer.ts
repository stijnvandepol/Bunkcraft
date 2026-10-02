import * as THREE from 'three';
import { COMMON_FRAGMENT, type WorldUniforms } from '../rendering/Materials';
import { FACE_LAYER, BLOCK } from '../world/BlockRegistry';
import type { World } from '../world/World';
import type { PrimedTnt } from './PrimedTnt';

const MAX = 64;
// Minecraft face shading per face (+X −X +Y −Y +Z −Z).
const SHADE = [0.6, 0.6, 1, 0.5, 0.8, 0.8];

/**
 * Lit TNT blocks (one instanced draw call), textured from the block texture array.
 * Like Minecraft they flash white every few ticks and swell during the last half second.
 */
export class TntRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iData: THREE.InstancedBufferAttribute;

  constructor(uniforms: WorldUniforms) {
    const positions: number[] = [], faces: number[] = [], index: number[] = [];
    const corners = [
      [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
      [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]],
      [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
      [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
      [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]],
      [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    ];
    const uvs: number[] = [];
    corners.forEach((quad, f) => {
      const base = positions.length / 3;
      for (const [x, y, z] of quad) {
        positions.push(x - 0.5, y, z - 0.5);
        faces.push(FACE_LAYER[BLOCK.TNT * 6 + f], SHADE[f]);
      }
      uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('face', new THREE.Float32BufferAttribute(faces, 2));
    g.setIndex(index);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iData', this.iData);
    g.instanceCount = 0;
    this.geometry = g;

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 face;  // texture layer, face shade
        attribute vec4 iPos;  // xyz + scale
        attribute vec4 iData; // sky, block, flash
        varying vec2 vUv;
        flat varying float vLayer;
        varying float vShade;
        varying vec3 vData;
        varying vec3 vWorldPos;
        void main() {
          vec3 world = iPos.xyz + vec3(0.0, 0.5, 0.0) + (position - vec3(0.0, 0.5, 0.0)) * iPos.w;
          vUv = uv;
          vLayer = face.x;
          vShade = face.y;
          vData = iData.xyz;
          vWorldPos = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_FRAGMENT}
        varying vec2 vUv;
        flat varying float vLayer;
        varying float vShade;
        varying vec3 vData;
        varying vec3 vWorldPos;
        void main() {
          vec3 tex = texture(uAtlas, vec3(vUv, vLayer)).rgb;
          vec3 color = tex * combineLight(vData.x, vData.y, vShade);
          color = mix(color, vec3(1.0), vData.z * 0.8);
          gl_FragColor = vec4(applyFog(color, vWorldPos), 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private frame = 0;

  update(list: PrimedTnt[], alpha: number, world: World): void {
    const n = Math.min(list.length, MAX);
    this.frame++;
    const p = this.iPos.array as Float32Array, d = this.iData.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const t = list[i];
      const x = t.prevX + (t.x - t.prevX) * alpha;
      const y = t.prevY + (t.y - t.prevY) * alpha;
      const z = t.prevZ + (t.z - t.prevZ) * alpha;
      // Swell during the last 10 ticks, flash white every 5 ticks (Minecraft's TntRenderer).
      const fuse = t.fuse - alpha + 1;
      let scale = 1;
      if (fuse < 10) {
        const s = Math.min(1, Math.max(0, 1 - fuse / 10)) ** 4;
        scale = 1 + s * 0.3;
      }
      p[i * 4] = x; p[i * 4 + 1] = y; p[i * 4 + 2] = z; p[i * 4 + 3] = scale;
      const light = t.lightAt(world, this.frame, x, y + 0.5, z);
      d[i * 4] = (light >> 4) / 15;
      d[i * 4 + 1] = (light & 15) / 15;
      d[i * 4 + 2] = Math.floor(t.fuse / 5) % 2 === 0 ? 1 : 0;
    }
    this.iPos.needsUpdate = true;
    this.iData.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}
