import * as THREE from 'three';
import { PHYSICS, approach } from '../player/Physics';
import type { Player } from '../player/Player';

/**
 * First-person camera: interpolated player position, subtle head bob that follows
 * the actual distance walked, a small landing dip and a smooth sprint FOV kick.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  baseFov = 70;
  /** Bow draw 0..1 (FOV zoom). */
  bowPull = 0;
  viewBobbing = true;
  private bobAmount = 0;
  private fov = 70;
  private landDip = 0;
  private lastStepIndex = 0;
  /** Set when a footstep should be played this frame. */
  stepped = false;
  /** Hurt camera: 0..1 (1 = just hit) and the side the hit came from (−1 left, 1 right). */
  hurt = 0;
  hurtSide = 1;
  /** Walk phase and bob strength, exposed for the first-person hand. */
  bobPhase = 0;
  bobStrength = 0;
  /** Arcade: vertical recoil kick in radians (visual only, aim is unaffected). */
  kick = 0;
  /** Arcade: field-of-view multiplier while aiming down the sights (1 = none). */
  zoom = 1;
  /** Sprinting widens the field of view; arcade games sprint all the time and turn this off. */
  sprintFov = true;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);
    this.camera.rotation.order = 'YXZ';
  }

  update(p: Player, alpha: number, dt: number): void {
    const x = p.prevX + (p.x - p.prevX) * alpha;
    const y = p.prevY + (p.y - p.prevY) * alpha;
    const z = p.prevZ + (p.z - p.prevZ) * alpha;

    const hSpeed = Math.hypot(p.vx, p.vz);
    const target = p.onGround && !p.flying ? Math.min(hSpeed / PHYSICS.WALK_SPEED, 1.3) : 0;
    this.bobAmount = approach(this.bobAmount, target, 10, dt);

    if (p.landingImpact > 0) {
      this.landDip = Math.min(0.18, p.landingImpact * 0.012);
      p.landingImpact = 0;
    }
    this.landDip = approach(this.landDip, 0, 9, dt);

    const phase = (p.walkDistance * Math.PI) / 1.45;
    const stepIndex = Math.floor(phase / Math.PI);
    this.stepped = stepIndex !== this.lastStepIndex && p.onGround;
    this.lastStepIndex = stepIndex;

    const amt = this.viewBobbing ? this.bobAmount : 0;
    const bobY = Math.abs(Math.sin(phase)) * 0.055 * amt - 0.02 * amt;
    const bobSide = Math.cos(phase) * 0.028 * amt;
    // Minecraft hurt cam: a quick tilt towards the side of the hit.
    const hurtRoll = this.hurt > 0 ? -Math.sin(this.hurt ** 4 * Math.PI) * 0.24 * this.hurtSide : 0;
    const roll = Math.cos(phase) * 0.0045 * amt + hurtRoll;
    this.bobPhase = phase;
    this.bobStrength = amt;

    const cam = this.camera;
    cam.rotation.set(p.pitch + this.kick, p.yaw, roll, 'YXZ');
    const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
    cam.position.set(x + cos * bobSide, y + PHYSICS.EYE_HEIGHT + bobY - this.landDip, z - sin * bobSide);

    let fovTarget = this.baseFov;
    if (p.sprinting && this.sprintFov) fovTarget *= p.flying ? 1.18 : 1.12;
    if (p.headInWater) fovTarget *= 0.9;
    // Drawing a bow zooms in (Minecraft: up to 15% at full draw).
    if (this.bowPull > 0) fovTarget *= 1 - this.bowPull * this.bowPull * 0.15;
    fovTarget *= this.zoom;
    this.fov = approach(this.fov, fovTarget, 8, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Slowly orbiting panorama camera for the main menu. */
  orbit(cx: number, cy: number, cz: number, t: number): void {
    const cam = this.camera;
    cam.position.set(cx, cy, cz);
    cam.rotation.set(-0.12 + Math.sin(t * 0.05) * 0.05, t * 0.035, 0, 'YXZ');
    if (cam.fov !== 75) {
      cam.fov = this.fov = 75;
      cam.updateProjectionMatrix();
    }
  }
}
