import * as THREE from 'three';
import type { OpticId } from '../modes/Weapons';

/**
 * Procedural weapon models: a handful of coloured boxes per weapon, no assets. Units are blocks,
 * the barrel points to −Z (the way a player looks), +Y is up and the origin sits on the receiver
 * just above the grip, where the right hand holds it. Face shading is baked into the vertex
 * colours, so one `MeshBasicMaterial({ vertexColors: true })` draws every weapon.
 *
 * Optics (red dot, holographic, scope) and the suppressor are separate box sets mounted on the
 * weapon's rail and muzzle; every weapon + optic + suppressor combination is merged into one
 * geometry, built once and shared by the first-person view and every remote player.
 */

/** x0, y0, z0, x1, y1, z1, a colour, and optionally `iron` for iron-sight parts (removed when an optic is mounted). */
export type Box = [number, number, number, number, number, number, string] | [number, number, number, number, number, number, string, 'iron'];

export interface WeaponModel {
  boxes: Box[];
  /** Where the bullets come out (without suppressor). */
  muzzle: [number, number, number];
  /** Height of the iron sight line above the origin: aiming moves this point to the screen centre. */
  sightY: number;
  /** Top of the receiver (y) and the z where an optic is mounted. */
  rail: [number, number];
}

const METAL = '#3d4147', DARK = '#2a2d31', STEEL = '#8f969e', WOOD = '#7a5230', WOOD_DARK = '#5d3d22';
const OLIVE = '#4f5a3a', ORANGE = '#d9822b', BLACK = '#17181a', LENS = '#4a8fd6', TAN = '#a08a5c';

export const WEAPON_MODELS: Record<string, WeaponModel> = {
  rifle: {
    muzzle: [0, 0.018, -0.6], sightY: 0.078, rail: [0.04, -0.1],
    boxes: [
      [-0.03, -0.05, -0.3, 0.03, 0.04, 0.12, METAL], // receiver
      [-0.016, 0.0, -0.56, 0.016, 0.034, -0.3, DARK], // barrel
      [-0.02, -0.02, -0.46, 0.02, 0.04, -0.3, METAL], // handguard
      [-0.026, -0.065, 0.12, 0.026, 0.035, 0.33, OLIVE], // stock
      [-0.02, -0.17, -0.1, 0.02, -0.05, -0.03, BLACK], // magazine
      [-0.02, -0.14, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.008, 0.04, -0.24, 0.008, 0.078, -0.21, DARK, 'iron'], // front sight
      [-0.008, 0.04, 0.04, 0.008, 0.078, 0.07, DARK, 'iron'], // rear sight
    ],
  },
  smg: {
    muzzle: [0, 0.012, -0.36], sightY: 0.07, rail: [0.04, -0.04],
    boxes: [
      [-0.03, -0.05, -0.2, 0.03, 0.04, 0.1, ORANGE], // body
      [-0.013, -0.005, -0.34, 0.013, 0.025, -0.2, DARK], // barrel
      [-0.016, -0.22, -0.12, 0.016, -0.05, -0.07, BLACK], // long magazine
      [-0.02, -0.13, 0.03, 0.02, -0.045, 0.08, BLACK], // grip
      [-0.012, -0.03, 0.1, 0.012, 0.012, 0.25, METAL], // wire stock
      [-0.008, 0.04, -0.17, 0.008, 0.07, -0.14, DARK, 'iron'], // front sight
      [-0.008, 0.04, 0.06, 0.008, 0.07, 0.085, DARK, 'iron'], // rear sight
    ],
  },
  shotgun: {
    muzzle: [0, 0.02, -0.7], sightY: 0.07, rail: [0.04, -0.03],
    boxes: [
      [-0.03, -0.06, -0.12, 0.03, 0.04, 0.09, METAL], // receiver
      [-0.02, 0.0, -0.66, 0.02, 0.042, -0.12, DARK], // barrel
      [-0.016, -0.034, -0.56, 0.016, 0.0, -0.18, METAL], // magazine tube
      [-0.034, -0.062, -0.46, 0.034, -0.014, -0.3, WOOD], // pump
      [-0.026, -0.075, 0.09, 0.026, 0.03, 0.32, WOOD_DARK], // stock
      [-0.02, -0.14, 0.03, 0.02, -0.055, 0.08, BLACK], // grip
      [-0.006, 0.042, -0.62, 0.006, 0.07, -0.6, STEEL, 'iron'], // bead sight
    ],
  },
  lmg: {
    muzzle: [0, 0.02, -0.72], sightY: 0.084, rail: [0.046, -0.06],
    boxes: [
      [-0.036, -0.055, -0.3, 0.036, 0.046, 0.12, DARK], // receiver
      [-0.018, 0.0, -0.68, 0.018, 0.04, -0.3, BLACK], // heavy barrel
      [-0.024, -0.008, -0.6, 0.024, 0.046, -0.5, METAL], // barrel shroud with carry ring
      [-0.026, 0.0, -0.44, 0.026, 0.05, -0.3, METAL], // handguard
      [-0.042, 0.046, -0.24, 0.042, 0.06, 0.06, METAL], // feed cover
      [-0.07, -0.16, -0.18, -0.034, -0.02, -0.02, OLIVE], // ammo box (left)
      [-0.034, -0.05, -0.16, -0.02, 0.03, -0.04, TAN], // ammo belt
      [-0.028, -0.07, 0.12, 0.028, 0.04, 0.36, DARK], // stock
      [-0.02, -0.15, 0.04, 0.02, -0.05, 0.09, BLACK], // grip
      [-0.005, -0.15, -0.66, 0.005, 0.0, -0.64, STEEL], // bipod leg
      [-0.008, 0.06, -0.64, 0.008, 0.084, -0.62, DARK, 'iron'], // front sight
      [-0.008, 0.06, 0.03, 0.008, 0.084, 0.06, DARK, 'iron'], // rear sight
    ],
  },
  burst: {
    muzzle: [0, 0.018, -0.5], sightY: 0.078, rail: [0.04, -0.08],
    boxes: [
      [-0.03, -0.05, -0.26, 0.03, 0.04, 0.12, METAL], // receiver
      [-0.014, 0.0, -0.5, 0.014, 0.034, -0.26, DARK], // barrel
      [-0.022, -0.02, -0.4, 0.022, 0.044, -0.28, ORANGE], // triple-barrel shroud
      [-0.026, -0.065, 0.12, 0.026, 0.035, 0.3, METAL], // stock
      [-0.02, -0.16, -0.08, 0.02, -0.05, -0.02, BLACK], // magazine
      [-0.02, -0.14, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.008, 0.044, -0.22, 0.008, 0.078, -0.19, DARK, 'iron'], // front sight
      [-0.008, 0.04, 0.04, 0.008, 0.078, 0.07, DARK, 'iron'], // rear sight
    ],
  },
  dmr: {
    muzzle: [0, 0.018, -0.8], sightY: 0.08, rail: [0.04, -0.12],
    boxes: [
      [-0.028, -0.05, -0.26, 0.028, 0.04, 0.12, OLIVE], // receiver
      [-0.013, 0.0, -0.76, 0.013, 0.03, -0.26, DARK], // barrel
      [-0.02, -0.01, -0.5, 0.02, 0.04, -0.26, METAL], // handguard
      [-0.02, -0.005, -0.8, 0.02, 0.035, -0.74, BLACK], // muzzle device
      [-0.026, -0.07, 0.12, 0.026, 0.04, 0.34, WOOD_DARK], // stock
      [-0.02, -0.15, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.018, -0.15, -0.12, 0.018, -0.05, -0.06, BLACK], // magazine
      [-0.007, 0.04, -0.46, 0.007, 0.08, -0.43, DARK, 'iron'], // front sight
      [-0.009, 0.04, 0.05, 0.009, 0.08, 0.08, DARK, 'iron'], // rear aperture
    ],
  },
  semisniper: {
    muzzle: [0, 0.016, -0.9], sightY: 0.1, rail: [0.042, -0.1],
    boxes: [
      [-0.03, -0.05, -0.28, 0.03, 0.042, 0.12, TAN], // receiver
      [-0.014, 0.0, -0.86, 0.014, 0.03, -0.28, DARK], // barrel
      [-0.022, -0.012, -0.56, 0.022, 0.044, -0.28, TAN], // handguard
      [-0.022, -0.004, -0.9, 0.022, 0.036, -0.84, BLACK], // muzzle brake
      [-0.028, -0.075, 0.12, 0.028, 0.044, 0.36, TAN], // stock
      [-0.022, 0.044, 0.14, 0.022, 0.07, 0.3, BLACK], // cheek riser
      [-0.02, -0.15, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.02, -0.16, -0.14, 0.02, -0.05, -0.06, BLACK], // magazine
    ],
  },
  sniper: {
    muzzle: [0, 0.015, -0.98], sightY: 0.1, rail: [0.04, -0.14],
    boxes: [
      [-0.028, -0.05, -0.22, 0.028, 0.04, 0.12, OLIVE], // receiver
      [-0.012, 0.002, -0.96, 0.012, 0.028, -0.22, DARK], // long barrel
      [-0.02, 0.0, -0.98, 0.02, 0.03, -0.9, BLACK], // muzzle brake
      [-0.026, -0.07, 0.12, 0.026, 0.045, 0.36, OLIVE], // stock
      [-0.02, -0.15, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.018, -0.12, -0.12, 0.018, -0.05, -0.06, BLACK], // magazine
      [0.026, -0.005, 0.0, 0.07, 0.012, 0.03, STEEL], // bolt handle
      [0.06, -0.012, -0.004, 0.08, 0.02, 0.034, BLACK], // bolt knob
    ],
  },
  battle: {
    muzzle: [0, 0.018, -0.68], sightY: 0.082, rail: [0.044, -0.1],
    boxes: [
      [-0.032, -0.055, -0.3, 0.032, 0.044, 0.12, DARK], // receiver
      [-0.016, 0.0, -0.62, 0.016, 0.034, -0.3, BLACK], // barrel
      [-0.026, -0.03, -0.5, 0.026, 0.044, -0.3, TAN], // handguard
      [-0.022, -0.004, -0.68, 0.022, 0.038, -0.62, BLACK], // muzzle brake
      [-0.028, -0.07, 0.12, 0.028, 0.04, 0.34, TAN], // stock
      [-0.022, -0.19, -0.12, 0.022, -0.055, -0.04, BLACK], // big magazine
      [-0.02, -0.14, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [0.032, 0.0, -0.06, 0.05, 0.016, -0.02, METAL], // charging handle
      [-0.008, 0.044, -0.28, 0.008, 0.082, -0.25, DARK, 'iron'], // front sight
      [-0.008, 0.044, 0.04, 0.008, 0.082, 0.07, DARK, 'iron'], // rear sight
    ],
  },
  lever: {
    muzzle: [0, 0.017, -0.66], sightY: 0.066, rail: [0.04, -0.06],
    boxes: [
      [-0.026, -0.05, -0.18, 0.026, 0.04, 0.06, STEEL], // receiver
      [-0.013, 0.004, -0.66, 0.013, 0.03, -0.18, DARK], // barrel
      [-0.012, -0.026, -0.6, 0.012, 0.0, -0.18, METAL], // magazine tube
      [-0.024, -0.04, -0.44, 0.024, 0.006, -0.18, WOOD], // fore-end
      [-0.024, -0.08, 0.06, 0.024, 0.03, 0.32, WOOD], // stock
      [-0.018, -0.12, 0.03, 0.018, -0.04, 0.09, WOOD_DARK], // wrist
      [-0.008, -0.14, -0.04, 0.008, -0.05, -0.02, STEEL], // lever loop front
      [-0.008, -0.15, -0.04, 0.008, -0.13, 0.08, STEEL], // lever loop bottom
      [-0.006, 0.03, -0.64, 0.006, 0.066, -0.62, STEEL, 'iron'], // front bead
      [-0.01, 0.04, -0.1, 0.01, 0.066, -0.08, DARK, 'iron'], // rear sight
    ],
  },
  antimat: {
    muzzle: [0, 0.018, -1.16], sightY: 0.11, rail: [0.05, -0.12],
    boxes: [
      [-0.036, -0.06, -0.3, 0.036, 0.05, 0.14, DARK], // receiver
      [-0.018, 0.0, -1.08, 0.018, 0.036, -0.3, BLACK], // heavy barrel
      [-0.032, -0.008, -1.16, 0.032, 0.044, -1.06, METAL], // muzzle brake
      [-0.03, -0.02, -0.6, 0.03, 0.05, -0.3, OLIVE], // handguard
      [-0.03, -0.08, 0.14, 0.03, 0.05, 0.42, OLIVE], // stock
      [-0.03, 0.05, 0.2, 0.03, 0.075, 0.36, BLACK], // cheek rest
      [-0.024, -0.17, -0.14, 0.024, -0.06, -0.04, BLACK], // magazine
      [-0.02, -0.16, 0.06, 0.02, -0.06, 0.11, BLACK], // grip
      [-0.052, -0.2, -0.58, -0.042, -0.02, -0.56, STEEL], // bipod leg left
      [0.042, -0.2, -0.58, 0.052, -0.02, -0.56, STEEL], // bipod leg right
      [0.036, -0.005, 0.02, 0.08, 0.014, 0.05, STEEL], // bolt handle
      [0.07, -0.014, 0.016, 0.092, 0.022, 0.054, BLACK], // bolt knob
    ],
  },
  revolver: {
    muzzle: [0, 0.025, -0.3], sightY: 0.056, rail: [0.04, -0.1],
    boxes: [
      [-0.016, 0.0, -0.3, 0.016, 0.04, 0.0, STEEL], // barrel with rib
      [-0.024, -0.03, -0.1, 0.024, 0.045, -0.02, METAL], // cylinder
      [-0.018, -0.04, -0.02, 0.018, 0.05, 0.05, DARK], // frame
      [-0.019, -0.15, 0.02, 0.019, -0.035, 0.08, WOOD], // grip
      [-0.006, 0.04, -0.29, 0.006, 0.058, -0.28, STEEL, 'iron'], // front sight
      [-0.008, 0.05, 0.03, 0.008, 0.058, 0.05, STEEL], // hammer
    ],
  },
  pistol: {
    muzzle: [0, 0.02, -0.24], sightY: 0.05, rail: [0.045, -0.1],
    boxes: [
      [-0.02, -0.005, -0.22, 0.02, 0.045, 0.03, METAL], // slide
      [-0.018, -0.04, -0.14, 0.018, -0.005, 0.03, DARK], // frame
      [-0.019, -0.14, 0.0, 0.019, -0.035, 0.05, BLACK], // grip
      [-0.006, 0.045, -0.2, 0.006, 0.058, -0.19, STEEL, 'iron'], // front sight
      [-0.008, 0.045, 0.01, 0.008, 0.058, 0.025, STEEL, 'iron'], // rear sight
    ],
  },
  mpistol: {
    muzzle: [0, 0.02, -0.26], sightY: 0.052, rail: [0.045, -0.08],
    boxes: [
      [-0.022, -0.008, -0.22, 0.022, 0.045, 0.04, DARK], // slide
      [-0.012, 0.004, -0.26, 0.012, 0.03, -0.22, BLACK], // threaded barrel
      [-0.02, -0.045, -0.15, 0.02, -0.008, 0.04, METAL], // frame
      [-0.019, -0.24, 0.0, 0.019, -0.04, 0.045, BLACK], // grip with extended magazine
      [-0.012, -0.09, -0.15, 0.012, -0.045, -0.11, BLACK], // fore grip
      [-0.006, 0.045, -0.2, 0.006, 0.052, -0.19, STEEL, 'iron'], // front sight
      [-0.008, 0.045, 0.02, 0.008, 0.052, 0.035, STEEL, 'iron'], // rear sight
    ],
  },
  knife: {
    muzzle: [0, 0, -0.34], sightY: 0.0, rail: [0, 0],
    boxes: [
      [-0.006, -0.012, -0.36, 0.006, 0.024, -0.06, '#d3dae0'], // blade
      [-0.004, 0.0, -0.34, 0.004, 0.022, -0.1, '#a9b1b8'], // blade edge shading
      [-0.026, -0.035, -0.06, 0.026, 0.035, -0.036, STEEL], // guard
      [-0.016, -0.03, -0.036, 0.016, 0.022, 0.1, WOOD_DARK], // handle
      [-0.018, -0.032, 0.1, 0.018, 0.026, 0.115, STEEL], // pommel
    ],
  },
};

/**
 * Optics as boxes relative to the rail point (0, rail y, rail z), and the height of their sight line
 * above the rail. The reticle (dot, ring) is drawn by the first-person view at that height.
 */
interface OpticModel { boxes: Box[]; sightY: number; /** z of the reticle window relative to the rail point. */ windowZ: number; /** Front of the scope (glint). */ frontZ: number }

export const OPTIC_MODELS: Record<Exclude<OpticId, 'iron'>, OpticModel> = {
  reddot: {
    sightY: 0.046, windowZ: -0.03, frontZ: -0.045,
    boxes: [
      [-0.02, 0.0, -0.05, 0.02, 0.014, 0.03, BLACK], // mount
      [-0.036, 0.014, -0.05, -0.026, 0.08, -0.02, DARK], // left of the hood
      [0.026, 0.014, -0.05, 0.036, 0.08, -0.02, DARK], // right of the hood
      [-0.036, 0.07, -0.05, 0.036, 0.08, -0.02, DARK], // top of the hood
      [-0.036, 0.014, -0.05, 0.036, 0.02, -0.02, DARK], // bottom of the hood
      [0.036, 0.03, -0.04, 0.046, 0.05, -0.02, METAL], // brightness knob
    ],
  },
  holo: {
    sightY: 0.05, windowZ: -0.06, frontZ: -0.075,
    boxes: [
      [-0.03, 0.0, -0.08, 0.03, 0.018, 0.04, BLACK], // base
      [-0.044, 0.018, -0.08, -0.034, 0.094, -0.05, DARK], // left of the window
      [0.034, 0.018, -0.08, 0.044, 0.094, -0.05, DARK], // right of the window
      [-0.044, 0.084, -0.08, 0.044, 0.094, -0.05, DARK], // top of the window
      [-0.02, 0.018, 0.0, 0.02, 0.036, 0.04, METAL], // battery box
      [0.03, 0.02, -0.02, 0.04, 0.034, 0.02, METAL], // buttons
    ],
  },
  combat: {
    sightY: 0.045, windowZ: 0.07, frontZ: -0.1,
    boxes: [
      [-0.016, 0.0, -0.06, 0.016, 0.012, 0.04, BLACK], // mount
      [-0.026, 0.012, -0.08, 0.026, 0.072, 0.06, DARK], // body
      [-0.03, 0.008, -0.1, 0.03, 0.076, -0.08, BLACK], // front hood
      [-0.022, 0.018, -0.102, 0.022, 0.066, -0.1, LENS], // objective lens
      [-0.024, 0.014, 0.06, 0.024, 0.07, 0.08, BLACK], // eyepiece
      [-0.006, 0.072, -0.06, 0.006, 0.08, 0.02, '#4caf50'], // fibre optic
    ],
  },
  scope: {
    sightY: 0.042, windowZ: 0.16, frontZ: -0.21,
    boxes: [
      [-0.012, 0.0, -0.1, 0.012, 0.02, -0.08, STEEL], // mount
      [-0.012, 0.0, 0.06, 0.012, 0.02, 0.08, STEEL], // mount
      [-0.022, 0.02, -0.16, 0.022, 0.064, 0.14, DARK], // tube
      [-0.03, 0.013, -0.21, 0.03, 0.071, -0.16, BLACK], // objective bell
      [-0.022, 0.02, -0.212, 0.022, 0.064, -0.209, LENS], // front lens
      [-0.027, 0.016, 0.14, 0.027, 0.068, 0.18, BLACK], // eyepiece
      [-0.008, 0.064, -0.03, 0.008, 0.078, 0.0, METAL], // elevation turret
      [0.022, 0.034, -0.03, 0.034, 0.05, 0.0, METAL], // windage turret
    ],
  },
};

/** Suppressor: a long can on the muzzle (relative to the muzzle point). */
const SUPPRESSOR: Box[] = [[-0.024, -0.024, -0.2, 0.024, 0.024, 0.0, BLACK], [-0.026, -0.026, -0.05, 0.026, 0.026, -0.04, DARK]];
const SUPPRESSOR_LENGTH = 0.2;

function shift(boxes: Box[], dx: number, dy: number, dz: number): Box[] {
  return boxes.map((b) => [b[0] + dx, b[1] + dy, b[2] + dz, b[3] + dx, b[4] + dy, b[5] + dz, b[6]] as Box);
}

/** All boxes of a weapon with its optic and suppressor. */
function assemble(id: string, optic: OpticId, sup: boolean): Box[] {
  const m = WEAPON_MODELS[id];
  let boxes = optic === 'iron' ? m.boxes : m.boxes.filter((b) => b[7] !== 'iron');
  if (optic !== 'iron') boxes = boxes.concat(shift(OPTIC_MODELS[optic].boxes, 0, m.rail[0], m.rail[1]));
  if (sup && id !== 'knife') boxes = boxes.concat(shift(SUPPRESSOR, m.muzzle[0], m.muzzle[1], m.muzzle[2]));
  return boxes;
}

/** Height of the sight line above the weapon origin with an optic: the iron sights, or the optic's reticle. */
export function sightYFor(id: string, optic: OpticId): number {
  const m = WEAPON_MODELS[id];
  return optic === 'iron' ? m.sightY : m.rail[0] + OPTIC_MODELS[optic].sightY;
}

/** Where the bullets come out, with or without a suppressor (written into `out`). */
export function muzzleFor(id: string, sup: boolean, out: [number, number, number]): [number, number, number] {
  const m = WEAPON_MODELS[id];
  out[0] = m.muzzle[0]; out[1] = m.muzzle[1]; out[2] = m.muzzle[2] - (sup && id !== 'knife' ? SUPPRESSOR_LENGTH : 0);
  return out;
}

const FACE_SHADE = { top: 1, bottom: 0.55, x: 0.78, z: 0.9 };
const tmpColor = new THREE.Color();

/** Merged, vertex-coloured geometry for a list of boxes. */
export function buildBoxGeometry(boxes: readonly Box[]): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  for (const [x0, y0, z0, x1, y1, z1, hex] of boxes) {
    tmpColor.set(hex);
    const quad = (pts: number[][], shade: number) => {
      const base = positions.length / 3;
      for (const p of pts) {
        positions.push(p[0], p[1], p[2]);
        colors.push(tmpColor.r * shade, tmpColor.g * shade, tmpColor.b * shade);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], FACE_SHADE.x); // +X
    quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], FACE_SHADE.x); // −X
    quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], FACE_SHADE.top); // +Y
    quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], FACE_SHADE.bottom); // −Y
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], FACE_SHADE.z); // +Z
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], FACE_SHADE.z); // −Z
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

const geometries = new Map<string, THREE.BufferGeometry>();
const frontGeometries = new Map<string, THREE.BufferGeometry>();

/** Boxes starting behind this z are the stock: hidden while aiming, so the sights are not blocked. */
const STOCK_FROM_Z = 0.085;

/**
 * One shared geometry per weapon id + optic + suppressor (first-person view and every remote player
 * use it). Built on first use; the cache key is a short string, so callers should only ask on changes.
 */
export function weaponGeometry(id: string, optic: OpticId = 'iron', sup = false): THREE.BufferGeometry | null {
  if (!WEAPON_MODELS[id]) return null;
  const key = `${id}|${optic}|${sup ? 1 : 0}`;
  let g = geometries.get(key);
  if (!g) {
    g = buildBoxGeometry(assemble(id, optic, sup));
    geometries.set(key, g);
  }
  return g;
}

/**
 * Where the first-person aiming view cuts the weapon off (boxes end here, nothing behind it): behind the stock with
 * iron sights or a scope; just behind the window of a red dot or holo, so the eye looks through the housing instead
 * of at the flat back of the receiver right in front of it (QA: "looking at the back of a block").
 */
export function adsCutZ(id: string, optic: OpticId): number {
  if (optic !== 'reddot' && optic !== 'holo') return STOCK_FROM_Z;
  return WEAPON_MODELS[id].rail[1] + OPTIC_MODELS[optic].windowZ + 0.012;
}

/** The weapon cut off at `adsCutZ` (no stock, no receiver behind a red dot or holo), for the first-person aiming view. */
export function weaponFrontGeometry(id: string, optic: OpticId = 'iron', sup = false): THREE.BufferGeometry | null {
  if (!WEAPON_MODELS[id]) return null;
  const key = `${id}|${optic}|${sup ? 1 : 0}`;
  let g = frontGeometries.get(key);
  if (!g) {
    const cut = adsCutZ(id, optic);
    const clip = optic === 'reddot' || optic === 'holo';
    const boxes = assemble(id, optic, sup).filter((b) => b[2] < cut)
      .map((b) => (clip && b[5] > cut ? [b[0], b[1], b[2], b[3], b[4], cut, b[6]] as Box : b));
    g = buildBoxGeometry(boxes);
    frontGeometries.set(key, g);
  }
  return g;
}

/** Material shared by all weapon meshes; `color` scales the baked colours (lighting, muzzle flash). */
export function createWeaponMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
}
