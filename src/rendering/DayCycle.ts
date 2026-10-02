import * as THREE from 'three';
import { smoothstep } from '../world/Noise';

/** Length of a full day in seconds (Minecraft: 20 minutes). */
export const DAY_LENGTH = 1200;

const DAY_ZENITH = new THREE.Color('#5c8ff0');
const DAY_HORIZON = new THREE.Color('#b4d0f7');
const NIGHT_ZENITH = new THREE.Color('#070c1e');
const NIGHT_HORIZON = new THREE.Color('#18213b');
const SUNSET = new THREE.Color('#f2804a');
const NIGHT_LIGHT = new THREE.Color(0.62, 0.7, 1.0);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Time of day: 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
 * Produces every colour the sky, fog and world shaders need.
 */
export class DayCycle {
  time = 0.08;
  readonly sunDir = new THREE.Vector3();
  readonly zenith = new THREE.Color();
  readonly horizon = new THREE.Color();
  readonly sunset = SUNSET.clone();
  readonly skyLight = new THREE.Color();
  daylight = 1;
  /** 0 at night, 1 during the day. */
  dayFactor = 1;
  sunsetAmount = 0;
  starAmount = 0;

  update(dt: number): void {
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    this.compute();
  }

  compute(): void {
    const a = this.time * Math.PI * 2;
    // Slight tilt so shadows are never exactly axis-aligned.
    this.sunDir.set(Math.cos(a), Math.sin(a), 0.28).normalize();
    const h = this.sunDir.y;
    const day = smoothstep(-0.18, 0.22, h);
    this.dayFactor = day;
    this.daylight = 0.3 + 0.7 * day;
    this.sunsetAmount = Math.exp(-(((h - 0.02) / 0.16) ** 2));
    this.starAmount = 1 - smoothstep(-0.25, 0.05, h);

    this.zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, day);
    this.horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day);
    this.horizon.lerp(SUNSET, this.sunsetAmount * 0.35);
    this.skyLight.copy(NIGHT_LIGHT).lerp(WHITE, day);
    this.skyLight.lerp(SUNSET, this.sunsetAmount * 0.18);
  }

  /** Human readable clock (Minecraft-style, 06:00 at sunrise). */
  clock(): string {
    const minutes = Math.floor(((this.time * 24 + 6) % 24) * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
}
