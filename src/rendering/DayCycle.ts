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

/** Minecraft's moon cycle: phase 0 is the full moon, 4 the new moon; one phase per day. */
export const MOON_PHASE_NAMES = [
  'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
  'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
];

export function moonPhaseOf(day: number): number {
  return ((Math.floor(day) % 8) + 8) % 8;
}

function desaturate(c: THREE.Color, k: number): void {
  const l = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  c.r += (l - c.r) * k;
  c.g += (l - c.g) * k;
  c.b += (l - c.b) * k;
}

/**
 * Time of day: 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
 * Produces every colour the sky, fog and world shaders need.
 */
export class DayCycle {
  time = 0.08;
  /** Whole days since the world began (the moon phase follows it). */
  day = 0;
  /** Weather inputs, set by the game before `compute()`: 0..1. */
  rain = 0;
  thunder = 0;
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
    const t = this.time + dt / DAY_LENGTH;
    if (t >= 1) this.day += Math.floor(t);
    this.time = t % 1;
    this.compute();
  }

  /** 0 = full moon … 4 = new moon … 7 = waxing gibbous. */
  get moonPhase(): number {
    return moonPhaseOf(this.day);
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

    const w = this.rain, th = this.thunder;
    if (w > 0.001) {
      // Overcast: grey, darker sky and fog; the sun, stars and sunset colours vanish behind the clouds.
      desaturate(this.zenith, w);
      desaturate(this.horizon, w);
      this.zenith.multiplyScalar(1 - 0.12 * w - 0.35 * th);
      this.horizon.multiplyScalar(1 - 0.1 * w - 0.3 * th);
      desaturate(this.skyLight, 0.4 * w);
      // Minecraft: sky brightness × (1 − 5/16 rain) × (1 − 5/16 thunder).
      this.daylight *= (1 - 0.3125 * w) * (1 - 0.3125 * th);
      this.sunsetAmount *= 1 - w;
      this.starAmount *= 1 - w;
    }
  }

  /** Human readable clock (Minecraft-style, 06:00 at sunrise). */
  clock(): string {
    const minutes = Math.floor(((this.time * 24 + 6) % 24) * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
}
