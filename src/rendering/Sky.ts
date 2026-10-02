import * as THREE from 'three';
import type { DayCycle } from './DayCycle';

/**
 * Sky dome in a single draw call: gradient, sunset glow, square pixel sun, a moon with
 * its eight phases and twinkling blocky stars, all computed per pixel from the view
 * direction. Below the horizon (and at it) the colour equals the world fog exactly, so
 * the far terrain melts into the sky without a seam.
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunset: { value: new THREE.Color() },
        uSunsetAmount: { value: 0 },
        uSunDir: { value: new THREE.Vector3() },
        uSunRight: { value: new THREE.Vector3() },
        uSunUp: { value: new THREE.Vector3() },
        uStars: { value: 0 },
        uStarRot: { value: new THREE.Matrix3() },
        uUnderwater: { value: 0 },
        uTime: { value: 0 },
        uMoonPhase: { value: 0 },
        /** Overcast amount 0..1: hides sun, moon and stars. */
        uRain: { value: 0 },
        /** Lightning flash 0..1. */
        uFlash: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uHorizon, uSunset, uSunDir, uSunRight, uSunUp;
        uniform float uSunsetAmount, uStars, uUnderwater, uTime, uMoonPhase, uRain, uFlash;
        uniform mat3 uStarRot;
        varying vec3 vDir;

        const float SUN_SIZE = 0.095;
        const float MOON_SIZE = 0.075;

        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        void main() {
          vec3 dir = normalize(vDir);
          if (uUnderwater > 0.5) { gl_FragColor = vec4(vec3(0.06, 0.2, 0.42) * 0.8, 1.0); return; }
          float h = dir.y;
          float sd = dot(dir, uSunDir);
          float cover = 1.0 - uRain * 0.92; // how much of the sky bodies shows through the overcast

          // The colour of the distance fog in this direction (same formula as FOG_GLSL).
          vec3 hdir = normalize(vec3(dir.x, 0.0, dir.z) + 1e-5);
          vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-5);
          float az = max(dot(hdir, sunH), 0.0);
          vec3 fogCol = mix(uHorizon, uSunset, pow(az, 6.0) * uSunsetAmount);

          // Gradient with a broad warm band along the horizon on the sun side, a tight glow
          // around the sun and a dusty purple band on the opposite side.
          vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 0.62, h), 0.85));
          float band = 1.0 - smoothstep(0.0, 0.5, h);
          col = mix(col, uSunset, clamp(pow(az, 2.0) * uSunsetAmount * band * 0.6, 0.0, 1.0));
          col = mix(col, uSunset * vec3(1.0, 0.92, 0.72), clamp(pow(max(sd, 0.0), 14.0) * uSunsetAmount * 0.8, 0.0, 1.0));
          float opp = pow(max(dot(hdir, -sunH), 0.0), 2.0) * uSunsetAmount * (1.0 - smoothstep(0.0, 0.32, h));
          col = mix(col, vec3(0.5, 0.38, 0.6) * (0.55 + 0.45 * length(uHorizon)), opp * 0.28);
          col = mix(fogCol, col, smoothstep(0.0, 0.14, h));

          // Blocky stars: dim ones plus a few big bright ones, all twinkling.
          if (uStars > 0.01 && h > -0.05) {
            vec3 sp = uStarRot * dir * 160.0;
            vec3 cell = floor(sp);
            float r = hash(cell);
            float fade = uStars * smoothstep(-0.05, 0.2, h) * cover;
            if (r > 0.9975) {
              vec3 f = fract(sp);
              float inside = step(abs(f.x - 0.5), 0.32) * step(abs(f.y - 0.5), 0.32) * step(abs(f.z - 0.5), 0.32);
              float tw = 0.72 + 0.28 * sin(uTime * (1.2 + r * 3.0) + r * 400.0);
              col += vec3(0.9, 0.92, 1.0) * inside * fade * (0.5 + 0.5 * hash(cell + 3.1)) * tw;
            }
            vec3 sp2 = uStarRot * dir * 64.0;
            vec3 cell2 = floor(sp2);
            float r2 = hash(cell2 + 11.0);
            if (r2 > 0.9975) {
              vec3 f = fract(sp2);
              float inside = step(abs(f.x - 0.5), 0.3) * step(abs(f.y - 0.5), 0.3) * step(abs(f.z - 0.5), 0.3);
              float tw = 0.6 + 0.4 * sin(uTime * (0.8 + r2 * 2.0) + r2 * 900.0);
              vec3 tint = mix(vec3(1.0, 0.85, 0.65), vec3(0.7, 0.8, 1.0), hash(cell2 + 5.0));
              col += tint * inside * fade * tw * 1.1;
            }
          }

          // Square pixel sun, 16 x 16 pixels with a brighter core and an orange rim.
          if (sd > 0.0) {
            vec2 q = vec2(dot(dir, uSunRight), dot(dir, uSunUp)) / sd;
            float m = max(abs(q.x), abs(q.y));
            if (m < SUN_SIZE) {
              vec2 cell = floor(q / SUN_SIZE * 8.0);
              float rel = m / SUN_SIZE;
              float rim = smoothstep(0.62, 0.9, rel);
              vec3 core = mix(vec3(1.0, 0.99, 0.88), vec3(1.0, 0.8, 0.36), rim * 0.9 + hash(vec3(cell, 1.0)) * 0.06);
              core = mix(core, vec3(1.0, 0.6, 0.28), uSunsetAmount * 0.55);
              col = mix(col, core, cover);
            } else {
              float rr = length(q);
              float halo = exp(-(rr - SUN_SIZE) * 7.5) * 0.3 + exp(-rr * 3.0) * 0.07;
              col += mix(vec3(1.0, 0.85, 0.6), vec3(1.0, 0.62, 0.38), uSunsetAmount) * halo * (1.0 - uStars * 0.8) * cover;
            }
          }

          // Moon: a pixel-art sphere lit from the side the phase says. Phase 0 = full, 4 = new.
          float md = -sd;
          if (md > 0.0) {
            vec2 q = vec2(dot(dir, -uSunRight), dot(dir, uSunUp)) / md / MOON_SIZE;
            vec2 c = (floor(q * 8.0) + 0.5) / 8.0;
            float r2 = dot(c, c);
            float a = uMoonPhase * 0.7853982;
            if (max(abs(q.x), abs(q.y)) < 1.0 && r2 < 1.0) {
              vec3 n = vec3(c, sqrt(1.0 - r2));
              float lit = dot(n, vec3(-sin(a), 0.0, cos(a)));
              float crater = step(0.84, hash(vec3(floor(q * 8.0), 7.0))) * 0.8 + step(0.7, hash(vec3(floor(q * 4.0), 3.0))) * 0.35;
              vec3 lightSide = mix(vec3(0.92, 0.94, 1.0), vec3(0.62, 0.65, 0.76), clamp(crater, 0.0, 1.0));
              vec3 darkSide = vec3(0.035, 0.05, 0.1);
              vec3 moon = mix(darkSide, lightSide, step(0.0, lit));
              col = mix(col, moon, cover * (0.55 + 0.45 * step(0.0, lit)));
            } else {
              float illum = 0.5 + 0.5 * cos(a);
              col += vec3(0.5, 0.6, 0.9) * 0.16 * exp(-length(q) * 1.6) * uStars * illum * cover;
            }
          }
          col = mix(col, vec3(0.78, 0.82, 1.0), uFlash * 0.7);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  update(cycle: DayCycle, underwater: boolean, time = 0, flash = 0): void {
    const u = this.material.uniforms;
    (u.uZenith.value as THREE.Color).copy(cycle.zenith);
    (u.uHorizon.value as THREE.Color).copy(cycle.horizon);
    (u.uSunset.value as THREE.Color).copy(cycle.sunset);
    u.uSunsetAmount.value = cycle.sunsetAmount;
    u.uStars.value = cycle.starAmount;
    u.uUnderwater.value = underwater ? 1 : 0;
    u.uTime.value = time;
    u.uMoonPhase.value = cycle.moonPhase;
    u.uRain.value = cycle.rain;
    u.uFlash.value = flash;
    const sun = u.uSunDir.value as THREE.Vector3;
    sun.copy(cycle.sunDir);
    const right = u.uSunRight.value as THREE.Vector3;
    right.set(0, 0, 1).cross(sun).normalize();
    (u.uSunUp.value as THREE.Vector3).copy(sun).cross(right).normalize();
    const angle = cycle.time * Math.PI * 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    (u.uStarRot.value as THREE.Matrix3).set(c, s, 0, -s, c, 0, 0, 0, 1);
  }
}
