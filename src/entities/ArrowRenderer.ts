import * as THREE from 'three';
import { FOG_GLSL, LIGHT_GLSL, type WorldUniforms } from '../rendering/Materials';
import type { World } from '../world/World';
import type { Arrow } from './Arrow';

const MAX = 128;

/** Box from (x0,y0,z0) to (x1,y1,z1) in one flat colour, appended to the buffers. */
function box(p: number[], c: number[], idx: number[], b: number[], col: [number, number, number]): void {
  const [x0, y0, z0, x1, y1, z1] = b;
  const faces = [
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 0.6],
    [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], 0.6],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], 1.0],
    [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], 0.5],
    [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], 0.8],
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], 0.8],
  ] as const;
  for (const f of faces) {
    const base = p.length / 3;
    for (let k = 0; k < 4; k++) {
      const v = f[k] as readonly number[];
      p.push(v[0], v[1], v[2]);
      c.push(col[0] * (f[4] as number), col[1] * (f[4] as number), col[2] * (f[4] as number));
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * Arrows as small instanced box models (shaft, flint head, feather fletching), oriented
 * along their flight direction and lit by the world light at their position.
 */
export class ArrowRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(uniforms: WorldUniforms) {
    const p: number[] = [], c: number[] = [], idx: number[] = [];
    const t = 0.025;
    box(p, c, idx, [-t, -t, -0.25, t, t, 0.2], [0.45, 0.32, 0.18]);          // shaft
    box(p, c, idx, [-0.045, -0.045, 0.2, 0.045, 0.045, 0.28], [0.42, 0.42, 0.42]); // head
    box(p, c, idx, [-0.07, -0.01, -0.3, 0.07, 0.01, -0.16], [0.92, 0.92, 0.92]);  // fletching
    box(p, c, idx, [-0.01, -0.07, -0.3, 0.01, 0.07, -0.16], [0.92, 0.92, 0.92]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    g.setIndex(idx);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iLight', this.data);

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute vec2 iLight;
        varying vec3 vColor;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vColor = color;
          vLight = iLight;
          vWorldPos = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${FOG_GLSL}
        varying vec3 vColor;
        varying vec2 vLight;
        varying vec3 vWorldPos;
        void main() {
          gl_FragColor = vec4(applyFog(vColor * combineLight(vLight.x, vLight.y, 1.0), vWorldPos), 1.0);
        }
      `,
    });
    this.mesh = new THREE.InstancedMesh(g, material, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  update(arrows: Arrow[], alpha: number, world: World): void {
    const n = Math.min(arrows.length, MAX);
    const d = this.data.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const a = arrows[i];
      this.pos.set(a.prevX + (a.x - a.prevX) * alpha, a.prevY + (a.y - a.prevY) * alpha, a.prevZ + (a.z - a.prevZ) * alpha);
      this.q.setFromEuler(this.e.set(-a.pitch, a.yaw, 0, 'YXZ'));
      this.m.compose(this.pos, this.q, this.one);
      this.mesh.setMatrixAt(i, this.m);
      // Sample behind the tip: a stuck arrow's tip is inside an unlit solid block.
      const cp = Math.cos(a.pitch) * 0.4;
      const light = world.getLight(Math.floor(this.pos.x - Math.sin(a.yaw) * cp), Math.floor(this.pos.y - Math.sin(a.pitch) * 0.4),
        Math.floor(this.pos.z - Math.cos(a.yaw) * cp));
      d[i * 2] = (light >> 4) / 15;
      d[i * 2 + 1] = (light & 15) / 15;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.data.needsUpdate = true;
    }
  }
}
