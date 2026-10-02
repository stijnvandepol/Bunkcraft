import * as THREE from 'three';
import type { DayCycle } from './DayCycle';

/**
 * Sky dome in a single draw call: gradient, sunset glow, square pixel sun and moon
 * and blocky stars, all computed per pixel from the view direction.
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
        uniform float uSunsetAmount, uStars, uUnderwater;
        uniform mat3 uStarRot;
        varying vec3 vDir;

        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        void main() {
          vec3 dir = normalize(vDir);
          if (uUnderwater > 0.5) { gl_FragColor = vec4(vec3(0.06, 0.2, 0.42) * 0.8, 1.0); return; }
          float h = dir.y;
          vec3 col = mix(uHorizon, uZenith, smoothstep(-0.02, 0.5, h));
          col = mix(col, uHorizon * 0.75, smoothstep(0.0, -0.3, h));

          // Sunset / sunrise glow around the sun near the horizon.
          float sd = dot(dir, uSunDir);
          float glow = pow(max(sd, 0.0), 5.0) * uSunsetAmount * (1.0 - smoothstep(0.0, 0.6, abs(h)));
          col = mix(col, uSunset, clamp(glow, 0.0, 1.0));

          // Square pixel sun.
          if (sd > 0.0) {
            vec2 q = vec2(dot(dir, uSunRight), dot(dir, uSunUp)) / sd;
            float m = max(abs(q.x), abs(q.y));
            if (m < 0.075) {
              vec2 cell = floor(q * 80.0);
              float rim = step(0.06, m);
              col = mix(vec3(1.0, 0.98, 0.82), vec3(1.0, 0.86, 0.45), rim * 0.8 + hash(vec3(cell, 1.0)) * 0.05);
            } else {
              col += vec3(1.0, 0.85, 0.6) * 0.22 * exp(-m * 9.0) * (1.0 - uStars * 0.8);
            }
          }
          // Square moon with a few craters.
          float md = -sd;
          if (md > 0.0) {
            vec2 q = vec2(dot(dir, -uSunRight), dot(dir, uSunUp)) / md;
            float m = max(abs(q.x), abs(q.y));
            if (m < 0.05) {
              vec2 cell = floor((q + 0.05) * 80.0);
              float crater = step(0.72, hash(vec3(cell, 7.0)));
              col = mix(vec3(0.86, 0.88, 0.95), vec3(0.62, 0.64, 0.72), crater);
            } else {
              col += vec3(0.5, 0.6, 0.9) * 0.12 * exp(-m * 12.0) * uStars;
            }
          }
          // Blocky stars.
          if (uStars > 0.01 && h > -0.05) {
            vec3 sp = uStarRot * dir * 160.0;
            vec3 cell = floor(sp);
            float r = hash(cell);
            if (r > 0.9975) {
              vec3 f = fract(sp);
              float inside = step(abs(f.x - 0.5), 0.32) * step(abs(f.y - 0.5), 0.32) * step(abs(f.z - 0.5), 0.32);
              col += vec3(0.9, 0.92, 1.0) * inside * uStars * (0.5 + 0.5 * hash(cell + 3.1)) * smoothstep(-0.05, 0.2, h);
            }
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  update(cycle: DayCycle, underwater: boolean): void {
    const u = this.material.uniforms;
    (u.uZenith.value as THREE.Color).copy(cycle.zenith);
    (u.uHorizon.value as THREE.Color).copy(cycle.horizon);
    (u.uSunset.value as THREE.Color).copy(cycle.sunset);
    u.uSunsetAmount.value = cycle.sunsetAmount;
    u.uStars.value = cycle.starAmount;
    u.uUnderwater.value = underwater ? 1 : 0;
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
