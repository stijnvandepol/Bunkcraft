import * as THREE from 'three';

const MAX = 64;
/** Blocks per second the bright streak travels along the bullet path, and its length in blocks. */
const SPEED = 180;
const LENGTH = 9;

/**
 * Bullet tracers: short bright streaks that fly from the muzzle to where the bullet stopped.
 * One instanced, camera-facing ribbon per tracer built in the vertex shader; all state lives in
 * preallocated typed arrays, so spawning and updating allocate nothing.
 */
export class Tracers {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  /** start xyz + age */
  private readonly a: THREE.InstancedBufferAttribute;
  /** end xyz + total lifetime */
  private readonly b: THREE.InstancedBufferAttribute;
  private count = 0;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    // x = 0 is the tail and 1 the head of the streak, y = −1/+1 the two sides of the ribbon.
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.a);
    g.setAttribute('iB', this.b);
    g.instanceCount = 0;
    this.geometry = g;

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec4 iA;
        attribute vec4 iB;
        varying float vAlong;
        void main() {
          vec3 dir = iB.xyz - iA.xyz;
          float dist = max(length(dir), 0.001);
          vec3 d = dir / dist;
          float headRaw = iA.w * ${SPEED.toFixed(1)};
          float head = min(dist, headRaw);
          float tail = clamp(headRaw - ${LENGTH.toFixed(1)}, 0.0, dist);
          vec3 mid = iA.xyz + d * mix(tail, head, position.x);
          vec3 toCam = mid - cameraPosition;
          vec3 side = normalize(cross(d, toCam) + vec3(1e-6));
          // Thin close up, widening with distance so it stays visible as a streak.
          float width = 0.012 + 0.0032 * length(toCam);
          vAlong = position.x;
          gl_Position = projectionMatrix * viewMatrix * vec4(mid + side * position.y * width, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlong;
        void main() {
          float a = 0.2 + 0.8 * vAlong * vAlong;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.5) * (0.6 + 0.6 * vAlong), a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  get active(): number {
    return this.count;
  }

  spawn(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    // Full: drop the oldest (it is nearly done anyway).
    if (this.count >= MAX) this.remove(0);
    const i = this.count++;
    const a = this.a.array as Float32Array, b = this.b.array as Float32Array;
    a[i * 4] = sx; a[i * 4 + 1] = sy; a[i * 4 + 2] = sz; a[i * 4 + 3] = 0;
    const dist = Math.hypot(ex - sx, ey - sy, ez - sz);
    b[i * 4] = ex; b[i * 4 + 1] = ey; b[i * 4 + 2] = ez; b[i * 4 + 3] = (dist + LENGTH) / SPEED;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const a = this.a.array as Float32Array, b = this.b.array as Float32Array;
    a.copyWithin(i * 4, last * 4, last * 4 + 4);
    b.copyWithin(i * 4, last * 4, last * 4 + 4);
  }

  update(dt: number): void {
    const a = this.a.array as Float32Array, b = this.b.array as Float32Array;
    let i = 0;
    while (i < this.count) {
      a[i * 4 + 3] += dt;
      if (a[i * 4 + 3] >= b[i * 4 + 3]) this.remove(i);
      else i++;
    }
    const n = this.count;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    this.a.clearUpdateRanges(); this.a.addUpdateRange(0, n * 4); this.a.needsUpdate = true;
    this.b.clearUpdateRanges(); this.b.addUpdateRange(0, n * 4); this.b.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }
}
