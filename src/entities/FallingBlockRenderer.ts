import * as THREE from 'three';
import { COMMON_FRAGMENT, type WorldUniforms } from '../rendering/Materials';
import { FACE_LAYER } from '../world/BlockRegistry';
import type { FallingBlock } from '../world/BlockUpdates';
import type { World } from '../world/World';

const MAX = 128;
// Minecraft face shading per face (+X −X +Y −Y +Z −Z).
const SHADE = [0.6, 0.6, 1, 0.5, 0.8, 0.8];

/**
 * Falling sand and gravel (one instanced draw call), textured from the block texture array. The gravity blocks have
 * one texture for every face, so the layer is a per-instance value.
 */
export class FallingBlockRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iData: THREE.InstancedBufferAttribute;
  private frame = 0;

  constructor(uniforms: WorldUniforms) {
    const positions: number[] = [], shades: number[] = [], index: number[] = [], uvs: number[] = [];
    const corners = [
      [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
      [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]],
      [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
      [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
      [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]],
      [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    ];
    corners.forEach((quad, f) => {
      const base = positions.length / 3;
      for (const [x, y, z] of quad) {
        positions.push(x - 0.5, y, z - 0.5);
        shades.push(SHADE[f]);
      }
      uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('shade', new THREE.Float32BufferAttribute(shades, 1));
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
        attribute float shade;
        attribute vec4 iPos;  // xyz
        attribute vec4 iData; // sky, block, texture layer
        varying vec2 vUv;
        flat varying float vLayer;
        varying float vShade;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          vec3 world = iPos.xyz + position;
          vUv = uv;
          vLayer = iData.z;
          vShade = shade;
          vLight = iData.xy;
          vWorldPos = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_FRAGMENT}
        varying vec2 vUv;
        flat varying float vLayer;
        varying float vShade;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          vec3 tex = texture(uAtlas, vec3(vUv, vLayer)).rgb;
          gl_FragColor = vec4(applyFog(tex * combineLight(vLight.x, vLight.y, vShade), vWorldPos), 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  update(list: readonly FallingBlock[], alpha: number, world: World): void {
    const n = Math.min(list.length, MAX);
    this.frame++;
    const p = this.iPos.array as Float32Array, d = this.iData.array as Float32Array;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const f = list[i];
      if (f.removed) continue;
      const x = f.prevX + (f.x - f.prevX) * alpha;
      const y = f.prevY + (f.y - f.prevY) * alpha;
      const z = f.prevZ + (f.z - f.prevZ) * alpha;
      p[k * 4] = x; p[k * 4 + 1] = y; p[k * 4 + 2] = z; p[k * 4 + 3] = 1;
      const light = (this.frame & 3) === 0 || d[k * 4 + 3] === 0
        ? world.getLight(Math.floor(x), Math.floor(y + 0.5), Math.floor(z)) : d[k * 4 + 3] - 1;
      d[k * 4] = (light >> 4) / 15;
      d[k * 4 + 1] = (light & 15) / 15;
      d[k * 4 + 2] = FACE_LAYER[f.id * 6 + 2];
      d[k * 4 + 3] = light + 1; // cached light (+1 so 0 means "not sampled yet")
      k++;
    }
    this.iPos.needsUpdate = true;
    this.iData.needsUpdate = true;
    this.geometry.instanceCount = k;
    this.mesh.visible = k > 0;
  }
}
