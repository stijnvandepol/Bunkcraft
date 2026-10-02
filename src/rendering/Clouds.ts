import * as THREE from 'three';
import { SimplexNoise } from '../world/Noise';
import type { DayCycle } from './DayCycle';

const WHITE = new THREE.Color(1, 1, 1);
const GRID = 64;
const CELL = 12;
const SPAN = GRID * CELL;
const HEIGHT = 4;
const ALTITUDE = 112;

/**
 * Minecraft-style blocky clouds: one merged mesh of boxes (internal faces culled)
 * that wraps around the camera in the vertex shader, so the field is infinite
 * while the geometry is built only once. Each vertex carries its cell origin so
 * whole boxes wrap together (no stretched boxes at the seam).
 */
export class Clouds {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private drift = 0;

  constructor(seed = 4242) {
    const noise = new SimplexNoise(seed);
    const filled = new Uint8Array(GRID * GRID);
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        // Tileable noise via sampling on a torus.
        const ax = (x / GRID) * Math.PI * 2, az = (z / GRID) * Math.PI * 2;
        const n = noise.noise3(Math.cos(ax) * 2.2, Math.sin(ax) * 2.2 + Math.cos(az) * 2.2, Math.sin(az) * 2.2)
          + 0.5 * noise.noise3(Math.cos(ax) * 5 + 9, Math.sin(ax) * 5 + Math.cos(az) * 5, Math.sin(az) * 5);
        filled[z * GRID + x] = n > 0.32 ? 1 : 0;
      }
    }
    const at = (x: number, z: number) => filled[((z + GRID) % GRID) * GRID + ((x + GRID) % GRID)];

    const pos: number[] = [];
    const cell: number[] = [];
    const shade: number[] = [];
    const idx: number[] = [];
    const quad = (pts: number[][], cx: number, cz: number, s: number) => {
      const b = pos.length / 3;
      for (const p of pts) { pos.push(p[0], p[1], p[2]); cell.push(cx, cz); shade.push(s); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const C = CELL, H = HEIGHT;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        if (!at(x, z)) continue;
        const cx = x * C, cz = z * C;
        quad([[0, H, C], [C, H, C], [C, H, 0], [0, H, 0]], cx, cz, 1.0);
        quad([[0, 0, 0], [C, 0, 0], [C, 0, C], [0, 0, C]], cx, cz, 0.7);
        if (!at(x + 1, z)) quad([[C, 0, C], [C, 0, 0], [C, H, 0], [C, H, C]], cx, cz, 0.85);
        if (!at(x - 1, z)) quad([[0, 0, 0], [0, 0, C], [0, H, C], [0, H, 0]], cx, cz, 0.85);
        if (!at(x, z + 1)) quad([[0, 0, C], [C, 0, C], [C, H, C], [0, H, C]], cx, cz, 0.9);
        if (!at(x, z - 1)) quad([[C, 0, 0], [0, 0, 0], [0, H, 0], [C, H, 0]], cx, cz, 0.9);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('cell', new THREE.Float32BufferAttribute(cell, 2));
    geo.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
    geo.setIndex(idx);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDrift: { value: 0 },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uFogColor: { value: new THREE.Color() },
      },
      vertexShader: /* glsl */ `
        attribute vec2 cell;
        attribute float shade;
        uniform float uDrift;
        varying float vShade;
        varying float vDist;
        const float SPAN = ${SPAN.toFixed(1)};
        void main() {
          vec2 origin = cell + vec2(uDrift, 0.0);
          vec2 rel = mod(origin - cameraPosition.xz + SPAN * 0.5, SPAN) - SPAN * 0.5;
          vec3 world = vec3(cameraPosition.x + rel.x + position.x, ${ALTITUDE.toFixed(1)} + position.y, cameraPosition.z + rel.y + position.z);
          vShade = shade;
          vDist = length(world.xz - cameraPosition.xz);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uFogColor;
        varying float vShade;
        varying float vDist;
        void main() {
          float f = smoothstep(${(SPAN * 0.22).toFixed(1)}, ${(SPAN * 0.47).toFixed(1)}, vDist);
          gl_FragColor = vec4(mix(uColor * vShade, uFogColor, f), 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  update(dt: number, cycle: DayCycle): void {
    this.drift = (this.drift + dt * 1.6) % SPAN;
    const u = this.material.uniforms;
    u.uDrift.value = this.drift;
    const c = u.uColor.value as THREE.Color;
    c.setRGB(0.55, 0.6, 0.75).lerp(WHITE, cycle.dayFactor).multiplyScalar(0.2 + 0.8 * cycle.dayFactor);
    c.lerp(cycle.sunset, cycle.sunsetAmount * 0.3);
    (u.uFogColor.value as THREE.Color).copy(cycle.horizon);
  }
}
