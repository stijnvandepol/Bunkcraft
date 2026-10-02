import * as THREE from 'three';
import { SimplexNoise } from '../world/Noise';
import type { DayCycle } from './DayCycle';

const WHITE = new THREE.Color(1, 1, 1);
const GREY = new THREE.Color();
const CLEAR_THRESHOLD = 0.32;
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
    // Per cell the noise value; cells above the clear-sky threshold are always there, cells in
    // the band below it only grow while it rains (the overcast gets denser and thicker).
    const value = new Float32Array(GRID * GRID);
    const RAIN_MIN = 0.02;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        // Tileable noise via sampling on a torus.
        const ax = (x / GRID) * Math.PI * 2, az = (z / GRID) * Math.PI * 2;
        value[z * GRID + x] = noise.noise3(Math.cos(ax) * 2.2, Math.sin(ax) * 2.2 + Math.cos(az) * 2.2, Math.sin(az) * 2.2)
          + 0.5 * noise.noise3(Math.cos(ax) * 5 + 9, Math.sin(ax) * 5 + Math.cos(az) * 5, Math.sin(az) * 5);
      }
    }
    const val = (x: number, z: number) => value[((z + GRID) % GRID) * GRID + ((x + GRID) % GRID)];
    /** 0 = always there, 0..1 = appears when the rain level passes it, -1 = never. */
    const needOf = (n: number) => (n > CLEAR_THRESHOLD ? 0 : n > RAIN_MIN ? 0.15 + 0.85 * ((CLEAR_THRESHOLD - n) / (CLEAR_THRESHOLD - RAIN_MIN)) : -1);

    const pos: number[] = [];
    const cell: number[] = [];
    const shade: number[] = [];
    const needs: number[] = [];
    const idx: number[] = [];
    const quad = (pts: number[][], cx: number, cz: number, s: number, need: number) => {
      const b = pos.length / 3;
      for (const p of pts) { pos.push(p[0], p[1], p[2]); cell.push(cx, cz); shade.push(s); needs.push(need); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const C = CELL, H = HEIGHT;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        const need = needOf(val(x, z));
        if (need < 0) continue;
        // A side face is hidden only if the neighbour is there whenever this cell is.
        const open = (nx: number, nz: number) => { const nn = needOf(val(nx, nz)); return nn < 0 || nn > need; };
        const cx = x * C, cz = z * C;
        quad([[0, H, C], [C, H, C], [C, H, 0], [0, H, 0]], cx, cz, 1.0, need);
        quad([[0, 0, 0], [C, 0, 0], [C, 0, C], [0, 0, C]], cx, cz, 0.7, need);
        if (open(x + 1, z)) quad([[C, 0, C], [C, 0, 0], [C, H, 0], [C, H, C]], cx, cz, 0.85, need);
        if (open(x - 1, z)) quad([[0, 0, 0], [0, 0, C], [0, H, C], [0, H, 0]], cx, cz, 0.85, need);
        if (open(x, z + 1)) quad([[0, 0, C], [C, 0, C], [C, H, C], [0, H, C]], cx, cz, 0.9, need);
        if (open(x, z - 1)) quad([[C, 0, 0], [0, 0, 0], [0, H, 0], [C, H, 0]], cx, cz, 0.9, need);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('cell', new THREE.Float32BufferAttribute(cell, 2));
    geo.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
    geo.setAttribute('need', new THREE.Float32BufferAttribute(needs, 1));
    geo.setIndex(idx);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDrift: { value: 0 },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uFogColor: { value: new THREE.Color() },
        uRain: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec2 cell;
        attribute float shade;
        attribute float need;
        uniform float uDrift;
        uniform float uRain;
        varying float vShade;
        varying float vDist;
        const float SPAN = ${SPAN.toFixed(1)};
        void main() {
          vec2 origin = cell + vec2(uDrift, 0.0);
          vec2 rel = mod(origin - cameraPosition.xz + SPAN * 0.5, SPAN) - SPAN * 0.5;
          // Rain cells grow out of the flat (collapsed boxes draw nothing); every cloud thickens and sinks a little.
          float grow = need <= 0.0 ? 1.0 : clamp((uRain - need * 0.85) * 5.0, 0.0, 1.0);
          float y = ${ALTITUDE.toFixed(1)} - uRain * 5.0 + position.y * grow * (1.0 + uRain * 0.9);
          vec3 world = vec3(cameraPosition.x + rel.x + position.x, y, cameraPosition.z + rel.y + position.z);
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
    // Rain clouds: grey and dark, darker still in a thunderstorm.
    const rain = cycle.rain;
    if (rain > 0.001) {
      const g = (c.r + c.g + c.b) / 3;
      c.lerp(GREY.setRGB(g, g, g), 0.75 * rain).multiplyScalar(1 - 0.42 * rain - 0.25 * cycle.thunder);
    }
    u.uRain.value = rain;
    (u.uFogColor.value as THREE.Color).copy(cycle.horizon);
  }
}
