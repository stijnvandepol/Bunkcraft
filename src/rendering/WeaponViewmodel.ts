import * as THREE from 'three';
import { type OpticId, type WeaponDef } from '../modes/Weapons';
import {
  type Box, OPTIC_MODELS, WEAPON_MODELS, buildBoxGeometry, createWeaponMaterial, muzzleFor, sightYFor, weaponFrontGeometry, weaponGeometry,
} from './WeaponModels';

const SKIN = '#c99a7a';
/** z of the supporting (left) hand along the weapon; weapons without an entry are held one-handed. */
const LEFT_HAND_Z: Record<string, number> = {
  rifle: -0.4, smg: -0.22, shotgun: -0.38, sniper: -0.45, lmg: -0.4, burst: -0.36, dmr: -0.42, semisniper: -0.44, mpistol: -0.13,
};
const BOLT_TIME = 0.55;
const tmpMuzzle: [number, number, number] = [0, 0, 0];

/** Reticle textures (drawn once): a red dot, and a holographic ring with a dot. */
function reticleTexture(kind: 'reddot' | 'holo'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, kind === 'reddot' ? 30 : 8);
  glow.addColorStop(0, 'rgba(255,90,70,1)');
  glow.addColorStop(0.35, 'rgba(255,40,30,0.9)');
  glow.addColorStop(1, 'rgba(255,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  if (kind === 'holo') {
    ctx.strokeStyle = 'rgba(255,60,50,0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,60,50,0.95)';
    for (const [x, y, w, hgt] of [[30, 2, 4, 8], [30, 54, 4, 8], [2, 30, 8, 4], [54, 30, 8, 4]]) ctx.fillRect(x, y, w, hgt);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Distance in front of the camera (view space z) of the weapon origin while aiming. */
const ADS_Z = -0.5;
const FLASH_TIME = 0.055;
const SWING_TIME = 0.28;
const EQUIP_TIME = 0.28;

function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Soft star for the muzzle flash. */
function flashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,230,1)');
  grad.addColorStop(0.25, 'rgba(255,200,90,0.9)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  // Four spikes.
  ctx.fillStyle = 'rgba(255,230,160,0.9)';
  ctx.fillRect(30, 2, 4, 60);
  ctx.fillRect(2, 30, 60, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * First-person weapon (arcade): the weapon and two hands in their own pass after the world, like
 * the Minecraft hand. Handles sway while moving and looking, recoil kick, muzzle flash, reload,
 * switching, melee swing and the move to the screen centre when aiming.
 */
export class WeaponViewmodel {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  private readonly root = new THREE.Group();
  private readonly weaponMesh = new THREE.Mesh(undefined, createWeaponMaterial());
  private readonly armsMesh: THREE.Mesh;
  private readonly flash: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly armGeometries = new Map<string, THREE.BufferGeometry>();
  private weaponId = '';
  private optic: OpticId = 'iron';
  private sup = false;
  private sightY = 0;
  private sleeve = '#4f5a3a';
  private def: WeaponDef | null = null;
  /** Red dot / holo reticles: one plane per kind, shown on the sight line while aiming. */
  private readonly reticles: Record<'reddot' | 'holo', THREE.Mesh>;
  private reticle: THREE.Mesh | null = null;
  /** Bolt-action cycle 0..1 (1 = idle) and how long a weapon takes to come up (Quickdraw). */
  private bolt = 1;
  private equipTime = EQUIP_TIME;
  /** Visual kick 0..1+ (position back and rotation up), decays quickly. */
  private kick = 0;
  private flashLeft = 0;
  private swing = 1;
  private equip = 1;
  private swayX = 0;
  private swayY = 0;
  private time = 0;
  visible = true;

  constructor() {
    this.material = this.weaponMesh.material as THREE.MeshBasicMaterial;
    this.armsMesh = new THREE.Mesh(undefined, this.material);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({
      map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.flash.visible = false;
    const reticle = (kind: 'reddot' | 'holo', size: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
        map: reticleTexture(kind), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
      }));
      m.renderOrder = 10;
      m.visible = false;
      this.root.add(m);
      return m;
    };
    this.reticles = { reddot: reticle('reddot', 0.014), holo: reticle('holo', 0.05) };
    this.root.add(this.weaponMesh, this.armsMesh, this.flash);
    this.scene.add(this.root);
  }

  /** Seconds the weapon takes to come up after a switch (Quickdraw halves it). */
  setEquipTime(sec: number): void {
    this.equipTime = Math.max(0.05, sec);
  }

  /** Work the bolt (bolt-action rifles, after every shot). */
  cycleBolt(): void {
    this.bolt = 0;
  }

  /** Height of the current sight line above the weapon origin (iron sights or the optic's reticle). */
  get sightLine(): number {
    return this.sightY;
  }

  /** Whether the optic is a scope (the HUD overlay takes over when fully aimed). */
  get scoped(): boolean {
    return this.optic === 'scope';
  }

  /** Where the weapon sits (z in view space) when fully aimed. */
  adsZ(): number {
    return ADS_Z;
  }

  /** Arm sleeve colour (team colour); rebuilds the hands on the next weapon change. */
  setSleeve(hex: string): void {
    if (hex === this.sleeve) return;
    this.sleeve = hex;
    this.armGeometries.clear();
    if (this.weaponId) this.apply(this.weaponId);
  }

  /** The weapon in hand with its optic and suppressor (the optic only counts for primaries). */
  setWeapon(def: WeaponDef, optic: OpticId = 'iron', sup = false): void {
    this.def = def;
    const o: OpticId = def.optics.includes(optic) ? optic : def.optics[0];
    const s = sup && def.slot !== 'melee';
    if (def.id === this.weaponId && o === this.optic && s === this.sup) return;
    if (def.id !== this.weaponId) this.equip = 0;
    this.weaponId = def.id;
    this.optic = o;
    this.sup = s;
    this.bolt = 1;
    this.apply(def.id);
  }

  private apply(id: string): void {
    const geo = weaponGeometry(id, this.optic, this.sup);
    if (!geo) return;
    this.weaponMesh.geometry = geo;
    let arms = this.armGeometries.get(id);
    if (!arms) {
      const left = LEFT_HAND_Z[id];
      const boxes: Box[] = [
        [-0.027, -0.16, 0.025, 0.027, -0.035, 0.1, SKIN], // right hand around the grip
        [-0.032, -0.4, 0.04, 0.036, -0.15, 0.13, this.sleeve], // right forearm coming up from below
      ];
      if (left !== undefined) {
        boxes.push([-0.032, -0.075, left - 0.04, 0.032, -0.012, left + 0.04, SKIN]); // left hand under the handguard
        boxes.push([-0.034, -0.4, left - 0.02, 0.03, -0.07, left + 0.05, this.sleeve]); // left forearm coming up from below
      }
      arms = buildBoxGeometry(boxes);
      this.armGeometries.set(id, arms);
    }
    this.armsMesh.geometry = arms;
    const m = WEAPON_MODELS[id];
    muzzleFor(id, this.sup, tmpMuzzle);
    this.flash.position.set(tmpMuzzle[0], tmpMuzzle[1], tmpMuzzle[2] - 0.04);
    this.flash.visible = false;
    this.sightY = sightYFor(id, this.optic);
    for (const r of Object.values(this.reticles)) r.visible = false;
    this.reticle = this.optic === 'reddot' || this.optic === 'holo' ? this.reticles[this.optic] : null;
    if (this.reticle) this.reticle.position.set(0, this.sightY, m.rail[1] + OPTIC_MODELS[this.optic as 'reddot' | 'holo'].windowZ);
  }

  /** A shot went out: kick and muzzle flash. */
  fire(): void {
    if (!this.def) return;
    this.kick = Math.min(1.6, this.kick + 0.45 + this.def.recoil * 0.18);
    // A suppressor hides most of the flash.
    this.flashLeft = this.sup ? FLASH_TIME * 0.5 : FLASH_TIME;
    this.flash.rotation.z = Math.random() * Math.PI;
    const id = this.def.id;
    const s = (id === 'shotgun' ? 1.8 : id === 'sniper' || id === 'semisniper' ? 1.5 : id === 'pistol' || id === 'mpistol' ? 0.8 : 1) * (this.sup ? 0.35 : 1);
    this.flash.scale.setScalar(s * (0.8 + Math.random() * 0.4));
  }

  /** Start a knife swing. */
  swingKnife(): void {
    this.swing = 0;
  }

  /**
   * @param ads      aim blend 0..1
   * @param reload   reload progress 0..1, or −1 when not reloading
   * @param bob      walk phase / strength from the camera
   * @param lookX    mouse movement this frame (pixels)
   * @param light    brightness scale 0..1 from the world light at the player
   */
  update(dt: number, ads: number, reload: number, bobPhase: number, bobAmount: number, lookX: number, lookY: number, light: number, aspect: number): void {
    const def = this.def;
    if (!def) return;
    this.time += dt;
    this.kick = approach(this.kick, 0, 16, dt);
    this.swing = Math.min(1, this.swing + dt / SWING_TIME);
    this.equip = Math.min(1, this.equip + dt / this.equipTime);
    this.bolt = Math.min(1, this.bolt + dt / BOLT_TIME);
    this.flashLeft = Math.max(0, this.flashLeft - dt);
    this.flash.visible = this.flashLeft > 0;
    if (Math.abs(this.camera.aspect - aspect) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    // Weapon sways against the look direction, then settles.
    this.swayX = approach(this.swayX, Math.max(-1, Math.min(1, lookX * 0.02)), 9, dt);
    this.swayY = approach(this.swayY, Math.max(-1, Math.min(1, lookY * 0.02)), 9, dt);

    const model = WEAPON_MODELS[def.id];
    const e = ads * ads * (3 - 2 * ads);
    const calm = 1 - e * 0.85;
    const bx = Math.cos(bobPhase) * 0.012 * bobAmount * calm;
    const by = -Math.abs(Math.sin(bobPhase)) * 0.018 * bobAmount * calm;
    const breathe = Math.sin(this.time * 1.7) * 0.0025 * calm;
    const equipDrop = (1 - this.equip) * (1 - this.equip);
    const reloadT = reload >= 0 ? Math.sin(Math.min(1, reload) * Math.PI) : 0;
    // Bolt: the weapon dips and rolls while the hand works the bolt (only from the hip; scoped it is hidden).
    const boltT = this.bolt < 1 ? Math.sin(this.bolt * Math.PI) : 0;
    const sw = Math.sin(Math.sqrt(this.swing) * Math.PI);

    // Hip and aim poses; aiming puts the sight line on the screen centre.
    const hipX = 0.18, hipY = -0.18, hipZ = -0.62;
    // Aiming: sight line on the centre.
    const adsX = 0, adsY = -this.sightY * 0.85 - 0.003, adsZ = ADS_Z;
    const r = this.root;
    r.position.set(
      hipX + (adsX - hipX) * e + bx - 0.2 * sw,
      hipY + (adsY - hipY) * e + by + breathe - equipDrop * 0.5 - reloadT * 0.16 - boltT * 0.05 - this.swayY * 0.012,
      hipZ + (adsZ - hipZ) * e + this.kick * 0.045 + 0.05 * reloadT,
    );
    // Aiming slims the weapon so the receiver does not fill the screen next to the sight line.
    // (Not with an optic: its housing frames the reticle.)
    r.scale.set(0.85 * (1 - (this.optic === 'iron' ? 0.55 : 0.1) * e), 0.85, 0.85);
    r.rotation.set(
      this.kick * 0.1 + equipDrop * 0.6 - reloadT * 0.2 - sw * 0.5 + this.swayY * 0.03,
      -this.swayX * 0.035 + sw * 0.5 + reloadT * 0.25,
      reloadT * 0.9 - this.swayX * 0.015 - sw * 0.7 + boltT * 0.35,
      'YXZ',
    );
    void model;
    this.material.color.setScalar(light * (this.flashLeft > 0 ? 1.5 : 1));
    // A scoped weapon disappears behind the scope overlay when fully aimed.
    this.weaponMesh.visible = !(this.optic === 'scope' && ads > 0.92);
    // Aiming: no stock and no hands in the way of the sights.
    const geo = (ads > 0.5 ? weaponFrontGeometry(def.id, this.optic, this.sup) : weaponGeometry(def.id, this.optic, this.sup)) ?? this.weaponMesh.geometry;
    if (this.weaponMesh.geometry !== geo) this.weaponMesh.geometry = geo;
    this.armsMesh.visible = this.weaponMesh.visible && ads < 0.5;
    const ret = this.reticle;
    if (ret) {
      ret.visible = ads > 0.35;
      // Undo the root's sideways slimming so the dot stays round.
      ret.scale.x = 1 / (1 - 0.1 * e);
      (ret.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (ads - 0.35) * 3);
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.visible || !this.def) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
