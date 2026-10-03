import * as THREE from 'three';

const MAX_BOLTS = 4;
const SEGMENTS = 48;
const TOP = 120;
const LIFE = 0.75;

/**
 * Lightning bolts: a jagged main line from the clouds to the ground plus a few branches,
 * drawn as camera-facing emissive ribbons in one instanced draw call. A strike writes its
 * segments into a preallocated slot (no allocation) and then only a flicker value per bolt
 * is animated. `update()` returns the sky flash (0..1) for the sky and fog.
 */
export class Lightning {
  readonly mesh: THREE.Mesh;
  private readonly iA: THREE.InstancedBufferAttribute;
  private readonly iB: THREE.InstancedBufferAttribute;
  private readonly iInfo: THREE.InstancedBufferAttribute;
  private readonly age = new Float32Array(MAX_BOLTS).fill(LIFE);
  private readonly bx = new Float32Array(MAX_BOLTS);
  private readonly bz = new Float32Array(MAX_BOLTS);
  private readonly by = new Float32Array(MAX_BOLTS);
  private next = 0;
  private readonly uniforms = { uBolt: { value: new Float32Array(MAX_BOLTS) } };
  /** Set by the game from the player's "reduce flashes" setting. */
  reduceFlashes = false;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const n = MAX_BOLTS * SEGMENTS;
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iB = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    // x = bolt index, y = width in blocks
    this.iInfo = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.iA);
    g.setAttribute('iB', this.iB);
    g.setAttribute('iInfo', this.iInfo);
    g.instanceCount = n;

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 iA;
        attribute vec3 iB;
        attribute vec2 iInfo;
        uniform float uBolt[${MAX_BOLTS}];
        varying float vSide;
        varying float vPower;
        void main() {
          float power = uBolt[int(iInfo.x + 0.5)];
          vec3 a = iA, b = iB;
          vec3 mid = (a + b) * 0.5;
          vec3 dir = b - a;
          vec3 toCam = cameraPosition - mid;
          vec3 side = cross(dir, toCam);
          float sl = length(side);
          side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
          // At least ~2 px wide at any distance so far bolts do not shimmer away.
          float width = max(iInfo.y, length(toCam) * 0.007);
          vec3 pos = mix(a, b, position.y) + side * position.x * width;
          vSide = position.x;
          vPower = power;
          if (power <= 0.001 || iInfo.y <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vSide;
        varying float vPower;
        void main() {
          float core = 1.0 - abs(vSide);
          vec3 col = mix(vec3(0.55, 0.62, 1.0), vec3(1.0), smoothstep(0.35, 0.9, core));
          gl_FragColor = vec4(col * (0.35 + core) * vPower, core * vPower);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  /** A new bolt striking the ground at (x, groundY, z). */
  strike(x: number, groundY: number, z: number): void {
    const b = this.next;
    this.next = (this.next + 1) % MAX_BOLTS;
    this.age[b] = 0;
    this.bx[b] = x; this.by[b] = groundY; this.bz[b] = z;
    const A = this.iA.array as Float32Array, B = this.iB.array as Float32Array, I = this.iInfo.array as Float32Array;
    let s = b * SEGMENTS;
    const end = s + SEGMENTS;
    const put = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number) => {
      A[s * 3] = ax; A[s * 3 + 1] = ay; A[s * 3 + 2] = az;
      B[s * 3] = bx; B[s * 3 + 1] = by; B[s * 3 + 2] = bz;
      I[s * 2] = b; I[s * 2 + 1] = w;
      s++;
    };
    // Main line: a random walk pulled back to the strike point.
    const K = 20;
    let ox = (Math.random() - 0.5) * 6, oz = (Math.random() - 0.5) * 6;
    let px = x + ox, py = TOP, pz = z + oz;
    const mids: number[] = [];
    for (let i = 1; i <= K; i++) {
      const t = i / K;
      const pull = 1 - t;
      ox = ox * 0.55 + (Math.random() - 0.5) * 3.2;
      oz = oz * 0.55 + (Math.random() - 0.5) * 3.2;
      const nx = x + ox * pull, nz = z + oz * pull;
      const ny = TOP + (groundY - TOP) * t;
      put(px, py, pz, nx, ny, nz, 0.3);
      if (i > 4 && i < K - 2 && mids.length < 9) mids.push(nx, ny, nz);
      px = nx; py = ny; pz = nz;
    }
    // Two or three branches that peel off sideways and downwards.
    const branches = 2 + Math.floor(Math.random() * 2);
    for (let k = 0; k < branches && s + 9 <= end && mids.length >= 3; k++) {
      const m = Math.floor(Math.random() * (mids.length / 3)) * 3;
      let qx = mids[m], qy = mids[m + 1], qz = mids[m + 2];
      const a = Math.random() * Math.PI * 2;
      const dx = Math.cos(a) * 3.2, dz = Math.sin(a) * 3.2;
      for (let i = 0; i < 8 && s < end; i++) {
        const nx = qx + dx + (Math.random() - 0.5) * 2.4;
        const ny = qy - 2.4 - Math.random() * 3;
        const nz = qz + dz + (Math.random() - 0.5) * 2.4;
        put(qx, qy, qz, nx, ny, nz, 0.15);
        qx = nx; qy = ny; qz = nz;
      }
    }
    while (s < end) put(0, 0, 0, 0, 0, 0, 0); // unused segments draw nothing
    this.iA.needsUpdate = true;
    this.iB.needsUpdate = true;
    this.iInfo.needsUpdate = true;
  }

  /** Advances the flicker; returns the sky flash for the nearest strong bolt (0..1). */
  update(dt: number, camX: number, camY: number, camZ: number): number {
    let flash = 0;
    let any = false;
    const power = this.uniforms.uBolt.value;
    const calm = this.reduceFlashes;
    for (let b = 0; b < MAX_BOLTS; b++) {
      if (this.age[b] >= LIFE) { power[b] = 0; continue; }
      any = true;
      const t = (this.age[b] += dt);
      let p: number;
      if (calm) p = Math.max(0, 1 - t / LIFE) * 0.7;
      else if (t < 0.1) p = 1;
      else if (t < 0.2) p = 0.18;
      else if (t < 0.32) p = 0.95;
      else p = Math.max(0, 1 - (t - 0.32) / (LIFE - 0.32)) * 0.6;
      if (t >= LIFE) p = 0;
      power[b] = p;
      const d = Math.hypot(this.bx[b] - camX, this.by[b] - camY, this.bz[b] - camZ);
      const near = Math.min(1, Math.max(0.15, 1.2 - d / 100));
      flash = Math.max(flash, p * near * (calm ? 0.25 : 1));
    }
    this.mesh.visible = any;
    return flash;
  }
}
