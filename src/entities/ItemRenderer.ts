import * as THREE from 'three';
import type { WorldUniforms } from '../rendering/Materials';
import type { BlockIcons } from '../ui/BlockIcons';
import type { World } from '../world/World';
import type { ItemEntity } from './ItemEntity';

const MAX = 192;
const ATLAS = 1024;
const CELL = 64;
const PER_ROW = ATLAS / CELL;

/**
 * Dropped items as bobbing billboards (one instanced draw call). Icons are copied on
 * demand into a single atlas texture from the same icons the inventory shows.
 */
export class ItemRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iData: THREE.InstancedBufferAttribute;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly cells = new Map<number, number>();
  private iconVersion = -1;

  constructor(uniforms: WorldUniforms, private readonly icons: BlockIcons) {
    this.canvas.width = this.canvas.height = ATLAS;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iData', this.iData);
    g.instanceCount = 0;
    this.geometry = g;

    const material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uIcons: { value: this.texture } },
      vertexShader: /* glsl */ `
        attribute vec4 iPos;   // xyz + size
        attribute vec4 iData;  // atlas cell x, y, sky, block
        varying vec2 vUv;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 world = iPos.xyz + right * position.x * iPos.w + vec3(0.0, position.y * iPos.w, 0.0);
          vUv = (iData.xy + uv) / ${PER_ROW.toFixed(1)};
          vUv.y = 1.0 - ((iData.y + 1.0 - uv.y) / ${PER_ROW.toFixed(1)});
          vLight = iData.zw;
          vWorldPos = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uIcons;
        uniform float uDaylight;
        uniform vec3 uSkyLightColor;
        uniform vec3 uFogColor;
        uniform float uFogNear, uFogFar;
        varying vec2 vUv;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          vec4 tex = texture2D(uIcons, vUv);
          if (tex.a < 0.5) discard;
          vec3 light = max(uSkyLightColor * vLight.x * uDaylight, vec3(1.0, 0.86, 0.66) * vLight.y);
          vec3 c = tex.rgb * max(light, vec3(0.08));
          float f = smoothstep(uFogNear, uFogFar, length(vWorldPos.xz - cameraPosition.xz));
          gl_FragColor = vec4(mix(c, uFogColor, f), 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  private cellFor(id: number): number {
    if (this.icons.version !== this.iconVersion) {
      this.iconVersion = this.icons.version;
      this.cells.clear();
      this.ctx.clearRect(0, 0, ATLAS, ATLAS);
    }
    let cell = this.cells.get(id);
    if (cell === undefined) {
      cell = this.cells.size % (PER_ROW * PER_ROW);
      this.cells.set(id, cell);
      const x = (cell % PER_ROW) * CELL, y = Math.floor(cell / PER_ROW) * CELL;
      this.ctx.clearRect(x, y, CELL, CELL);
      this.ctx.drawImage(this.icons.canvas(id), x, y, CELL, CELL);
      this.texture.needsUpdate = true;
    }
    return cell;
  }

  update(items: ItemEntity[], alpha: number, time: number, world: World): void {
    const n = Math.min(items.length, MAX);
    const p = this.iPos.array as Float32Array, d = this.iData.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const x = it.prevX + (it.x - it.prevX) * alpha;
      const y = it.prevY + (it.y - it.prevY) * alpha;
      const z = it.prevZ + (it.z - it.prevZ) * alpha;
      // Bob up and down like Minecraft's dropped items.
      const bob = Math.sin((it.age + alpha) / 10 + i) * 0.08 + 0.1;
      p[i * 4] = x; p[i * 4 + 1] = y + bob; p[i * 4 + 2] = z;
      p[i * 4 + 3] = it.stack.count > 1 ? 0.42 : 0.36;
      const cell = this.cellFor(it.stack.id);
      const light = world.getLight(Math.floor(x), Math.floor(y + 0.2), Math.floor(z));
      d[i * 4] = cell % PER_ROW;
      d[i * 4 + 1] = Math.floor(cell / PER_ROW);
      d[i * 4 + 2] = (light >> 4) / 15;
      d[i * 4 + 3] = (light & 15) / 15;
    }
    void time;
    this.iPos.needsUpdate = true;
    this.iData.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}
