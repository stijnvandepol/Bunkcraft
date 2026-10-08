import * as THREE from 'three';
import { type OpticId, type WeaponDef, isMagnified } from '../modes/Weapons';
import {
  type Box, OPTIC_MODELS, WEAPON_MODELS, buildBoxGeometry, createWeaponMaterial, muzzleFor, sightYFor, sightZFor, weaponFrontGeometry, weaponGeometry,
} from './WeaponModels';

const SKIN = '#c99a7a';
/** z of the supporting (left) hand along the weapon; weapons without an entry are held one-handed. */
const LEFT_HAND_Z: Record<string, number> = {
  rifle: -0.4, smg: -0.22, shotgun: -0.38, sniper: -0.45, lmg: -0.4, burst: -0.36, dmr: -0.42, semisniper: -0.44, mpistol: -0.13,
  battle: -0.42, lever: -0.34, antimat: -0.5,
};
const BOLT_TIME = 0.55;
const tmpMuzzle: [number, number, number] = [0, 0, 0];

/**
 * Reticle textures (drawn once, 256 px, mip-mapped down to the plane's on-screen size so the lines stay crisp):
 * - red dot: a 2 MOA-style dot with a white-hot core inside a thin 30 MOA ring (the ring frames a target at mid range),
 * - holographic: a 65 MOA ring with three ticks, a centre dot, and two small chevrons in the ring's lower half pointing up at
 *   the dot (marks that lead the eye in, not hold-overs: bullets fly straight, the dot is the aim point).
 * The plane they are drawn on is sized in screen pixels (see RETICLE_PX), the same size on every screen.
 */
function reticleTexture(kind: 'reddot' | 'holo'): THREE.CanvasTexture {
  const S = 256, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const glow = (r: number, a: number) => {
    const g = ctx.createRadialGradient(C, C, 0, C, C, r);
    g.addColorStop(0, `rgba(255,60,40,${a})`);
    g.addColorStop(1, 'rgba(255,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  };
  const disc = (r: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(C, C, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const ring = (r: number, width: number, halo: number) => {
    ctx.strokeStyle = 'rgba(255,40,30,0.28)';
    ctx.lineWidth = width + halo;
    ctx.beginPath();
    ctx.arc(C, C, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,72,56,1)';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(C, C, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'reddot') {
    glow(46, 0.45);
    ring(104, 5, 7);
    disc(15, 'rgba(255,50,35,1)');
    disc(7.5, 'rgba(255,200,180,1)');
  } else {
    glow(30, 0.45);
    ring(104, 6.5, 9);
    ctx.fillStyle = 'rgba(255,72,56,1)';
    // Ticks at 12, 3 and 9 o'clock on the ring (inside it), the 6 o'clock one replaced by the range chevrons.
    for (const [x, y, w, hgt] of [[C - 4, 12, 8, 30], [12, C - 4, 30, 8], [S - 42, C - 4, 30, 8]]) ctx.fillRect(x, y, w, hgt);
    ctx.strokeStyle = 'rgba(255,72,56,1)';
    ctx.lineWidth = 5;
    for (const [y, half] of [[C + 42, 22], [C + 66, 14]]) {
      ctx.beginPath();
      ctx.moveTo(C - half, y + half * 0.55);
      ctx.lineTo(C, y);
      ctx.lineTo(C + half, y + half * 0.55);
      ctx.stroke();
    }
    disc(9, 'rgba(255,60,45,1)');
    disc(4.5, 'rgba(255,205,190,1)');
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Size of the reticle planes in screen pixels on a 720 px tall screen (scaled with the height): dot in its ring, holographic ring. */
const RETICLE_PX = { reddot: 30, holo: 76 } as const;

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
  /** The weapon in hand from the hip and cut for aiming (see weaponFrontGeometry); set in apply(). */
  private hipGeometry: THREE.BufferGeometry | null = null;
  private frontGeometry: THREE.BufferGeometry | null = null;
  private weaponId = '';
  private optic: OpticId = 'iron';
  private sup = false;
  /** Realms camo per weapon id (your own weapons only; see setCamos). */
  private camos: Readonly<Record<string, string>> = {};
  private camo = 'none';
  private sightY = 0;
  private sleeve = '#4f5a3a';
  private def: WeaponDef | null = null;
  /**
   * Red dot / holo reticles: one plane per kind. They hang in the view (not on the weapon) at the exact screen centre, the point the
   * bullets go through, and sit at the depth of the optic's window.
   */
  private readonly reticles: Record<'reddot' | 'holo', THREE.Mesh>;
  private reticle: THREE.Mesh | null = null;
  private reticleDepth = 0.5;
  private reticleKind: 'reddot' | 'holo' | null = null;
  /** The local point of the weapon that is kept on the screen centre while aiming (sight line height and the z of the window or sights). */
  private pivotZ = 0;
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPivot = new THREE.Vector3();
  private readonly tmpSize = new THREE.Vector2();
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
  /** ADS settle (degrees, see adsSettle): a short dip of the weapon about its sight when the sights arrive. */
  settle = 0;

  constructor() {
    this.material = this.weaponMesh.material as THREE.MeshBasicMaterial;
    this.armsMesh = new THREE.Mesh(undefined, this.material);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({
      map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      // One pass: three draws transparent double-sided materials twice (back, then front) and flips needsUpdate both
      // times, a program lookup with garbage per draw. A flat additive quad looks the same either way.
      forceSinglePass: true,
    }));
    this.flash.visible = false;
    const reticle = (kind: 'reddot' | 'holo') => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: reticleTexture(kind), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
      }));
      m.renderOrder = 10;
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    this.reticles = { reddot: reticle('reddot'), holo: reticle('holo') };
    this.root.add(this.weaponMesh, this.armsMesh, this.flash);
    this.scene.add(this.root);
    this.scene.matrixAutoUpdate = false; // see Renderer: only the moving root updates its subtree
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
    return isMagnified(this.optic);
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

  /** Camos chosen in the Realms armoury, per weapon id; repaints the weapon in hand when its camo changed. */
  setCamos(camos: Readonly<Record<string, string>>): void {
    this.camos = camos;
    if (this.weaponId && (camos[this.weaponId] ?? 'none') !== this.camo) this.apply(this.weaponId);
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
    this.camo = this.camos[id] ?? 'none';
    const geo = weaponGeometry(id, this.optic, this.sup, this.camo);
    if (!geo) return;
    this.weaponMesh.geometry = geo;
    this.hipGeometry = geo;
    this.frontGeometry = weaponFrontGeometry(id, this.optic, this.sup, this.camo) ?? geo;
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
    this.reticleKind = this.optic === 'reddot' || this.optic === 'holo' ? this.optic : null;
    // The pivot of the aimed pose: the reticle window, the scope's eyepiece, or the middle of the open sights.
    this.pivotZ = this.optic === 'iron' ? sightZFor(id) : m.rail[1] + OPTIC_MODELS[this.optic].windowZ;
  }

  /** A shot went out: kick and muzzle flash. */
  fire(): void {
    if (!this.def) return;
    this.kick = Math.min(1.6, this.kick + 0.45 + this.def.recoil * 0.18);
    // A suppressor hides most of the flash.
    this.flashLeft = this.sup ? FLASH_TIME * 0.5 : FLASH_TIME;
    this.flash.rotation.z = Math.random() * Math.PI;
    const id = this.def.id;
    const s = (id === 'shotgun' || id === 'antimat' ? 1.8 : id === 'sniper' || id === 'semisniper' || id === 'lever' || id === 'battle' ? 1.4 : id === 'pistol' || id === 'mpistol' ? 0.8 : 1) * (this.sup ? 0.35 : 1);
    this.flash.scale.setScalar(s * (0.8 + Math.random() * 0.4));
  }

  /** Start a knife swing. */
  swingKnife(): void {
    this.swing = 0;
  }

  /**
   * @param ads      aim blend 0..1, linear in the aim time (which parts of the model show)
   * @param eased    the same blend eased for the eye (where the weapon is)
   * @param reload   reload progress 0..1, or −1 when not reloading
   * @param bob      walk phase / strength from the camera
   * @param lookX    mouse movement this frame (pixels)
   * @param light    brightness scale 0..1 from the world light at the player
   */
  update(dt: number, ads: number, eased: number, reload: number, bobPhase: number, bobAmount: number, lookX: number, lookY: number, light: number, aspect: number): void {
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
    this.swayX = approach(this.swayX, Math.max(-1, Math.min(1, lookX * 0.02)), 14, dt);
    this.swayY = approach(this.swayY, Math.max(-1, Math.min(1, lookY * 0.02)), 14, dt);

    const model = WEAPON_MODELS[def.id];
    const e = Math.min(1, Math.max(0, eased));
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
    const adsX = 0, adsY = -this.sightY * 0.85, adsZ = ADS_Z;
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
      this.kick * 0.1 - this.settle * (Math.PI / 180) + equipDrop * 0.6 - reloadT * 0.2 - sw * 0.5 + this.swayY * 0.03,
      -this.swayX * 0.035 + sw * 0.5 + reloadT * 0.25,
      reloadT * 0.9 - this.swayX * 0.015 - sw * 0.7 + boltT * 0.35,
      'YXZ',
    );
    // Kick, sway and bob turn the weapon around its sight, not around the grip: the sight line stays exactly on the screen
    // centre (where the bullets go) while the muzzle and the body move.
    if (e > 0) {
      const v = this.tmpPivot.set(0, this.sightY * 0.85, this.pivotZ * 0.85).applyQuaternion(this.tmpQuat.setFromEuler(r.rotation));
      r.position.x -= e * (r.position.x + v.x);
      r.position.y -= e * (r.position.y + v.y);
    }
    // The reticle hangs at the window's depth on the view axis.
    this.reticleDepth = Math.max(0.2, -(r.position.z + this.pivotZ * 0.85));
    void model;
    this.material.color.setScalar(light * (this.flashLeft > 0 ? 1.5 : 1));
    // A scoped weapon disappears behind the scope overlay when fully aimed.
    this.weaponMesh.visible = !(isMagnified(this.optic) && ads > 0.92);
    // Aiming: no stock and no hands in the way of the sights.
    // (Both picked in apply(): looking them up here built a string key every frame.)
    const front = e > 0.55;
    const geo = (front ? this.frontGeometry : this.hipGeometry) ?? this.weaponMesh.geometry;
    if (this.weaponMesh.geometry !== geo) this.weaponMesh.geometry = geo;
    this.armsMesh.visible = this.weaponMesh.visible && !front;
    const ret = this.reticle;
    if (ret) {
      ret.visible = e > 0.5;
      (ret.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (e - 0.5) * 4);
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.visible || !this.def) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    const ret = this.reticle;
    if (ret && ret.visible && this.reticleKind) {
      // A plane `px` pixels wide at depth d is px * 2 d tan(fov/2) / height world units: the same on every screen.
      renderer.getDrawingBufferSize(this.tmpSize);
      const px = RETICLE_PX[this.reticleKind] * (this.tmpSize.y / 720);
      const size = (px * 2 * this.reticleDepth * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.tmpSize.y);
      ret.scale.set(size, size, 1);
      ret.position.set(0, 0, -this.reticleDepth);
    }
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
