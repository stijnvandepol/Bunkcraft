import * as THREE from 'three';
import { FOG_GLSL, LIGHT_GLSL, type WorldUniforms } from '../rendering/Materials';
import type { BlockIcons } from '../ui/BlockIcons';
import type { World } from '../world/World';
import type { ItemEntity } from './ItemEntity';
import { hasEnchants } from '../items/EnchantRules';
import { ITEM } from '../items/ItemRegistry';

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
  private readonly time = { value: 0 };
  private frame = 0;

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
      uniforms: { ...uniforms, uIcons: { value: this.texture }, uTime: this.time },
      vertexShader: /* glsl */ `
        attribute vec4 iPos;   // xyz + size
        attribute vec4 iData;  // atlas cell x (+32 = enchanted), y, sky, block
        varying vec2 vUv;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        varying float vGlint;
        varying vec2 vLocal;
        void main() {
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 world = iPos.xyz + right * position.x * iPos.w + vec3(0.0, position.y * iPos.w, 0.0);
          vGlint = step(31.5, iData.x);
          float cx = iData.x - 32.0 * vGlint;
          vLocal = uv;
          vUv = (vec2(cx, iData.y) + uv) / ${PER_ROW.toFixed(1)};
          vUv.y = 1.0 - ((iData.y + 1.0 - uv.y) / ${PER_ROW.toFixed(1)});
          vLight = iData.zw;
          vWorldPos = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${FOG_GLSL}
        uniform sampler2D uIcons;
        uniform float uTime;
        varying vec2 vUv;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        varying float vGlint;
        varying vec2 vLocal;
        void main() {
          vec4 tex = texture2D(uIcons, vUv);
          if (tex.a < 0.5) discard;
          vec3 c = tex.rgb * combineLight(vLight.x, vLight.y, 1.0);
          // Enchanted items shimmer purple (the same sliding band as the held item).
          float a = fract((vLocal.x + vLocal.y * 0.6) * 1.2 - uTime * 0.45);
          c += vGlint * vec3(0.5, 0.25, 0.95) * (0.3 + 0.7 * smoothstep(0.0, 0.18, a) * (1.0 - smoothstep(0.18, 0.36, a)));
          gl_FragColor = vec4(applyFog(c, vWorldPos), 1.0);
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
    this.frame++;
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
      const light = it.lightAt(world, this.frame, x, y + 0.2, z);
      const glint = it.stack.id === ITEM.ENCHANTED_BOOK || hasEnchants(it.stack.data);
      d[i * 4] = (cell % PER_ROW) + (glint ? 32 : 0);
      d[i * 4 + 1] = Math.floor(cell / PER_ROW);
      d[i * 4 + 2] = (light >> 4) / 15;
      d[i * 4 + 3] = (light & 15) / 15;
    }
    this.time.value = time;
    this.iPos.needsUpdate = true;
    this.iData.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}
