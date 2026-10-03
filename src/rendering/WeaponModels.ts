import * as THREE from 'three';

/**
 * Procedural weapon models: a handful of coloured boxes per weapon, no assets. Units are blocks,
 * the barrel points to −Z (the way a player looks), +Y is up and the origin sits on the receiver
 * just above the grip, where the right hand holds it. Face shading is baked into the vertex
 * colours, so one `MeshBasicMaterial({ vertexColors: true })` draws every weapon.
 */

/** x0, y0, z0, x1, y1, z1 and a colour. */
type Box = [number, number, number, number, number, number, string];

export interface WeaponModel {
  boxes: Box[];
  /** Where the bullets come out. */
  muzzle: [number, number, number];
  /** Height of the sight line above the origin: aiming moves this point to the screen centre. */
  sightY: number;
  /** Model has a scope (sniper): the first-person view switches to a scope overlay when fully aimed. */
  scope: boolean;
}

const METAL = '#3d4147', DARK = '#2a2d31', STEEL = '#8f969e', WOOD = '#7a5230', WOOD_DARK = '#5d3d22';
const OLIVE = '#4f5a3a', ORANGE = '#d9822b', BLACK = '#17181a', LENS = '#4a8fd6';

export const WEAPON_MODELS: Record<string, WeaponModel> = {
  rifle: {
    muzzle: [0, 0.018, -0.6], sightY: 0.078, scope: false,
    boxes: [
      [-0.03, -0.05, -0.3, 0.03, 0.04, 0.12, METAL], // receiver
      [-0.016, 0.0, -0.56, 0.016, 0.034, -0.3, DARK], // barrel
      [-0.02, -0.02, -0.46, 0.02, 0.04, -0.3, METAL], // handguard
      [-0.026, -0.065, 0.12, 0.026, 0.035, 0.33, OLIVE], // stock
      [-0.02, -0.17, -0.1, 0.02, -0.05, -0.03, BLACK], // magazine
      [-0.02, -0.14, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.008, 0.04, -0.24, 0.008, 0.078, -0.21, DARK], // front sight
      [-0.008, 0.04, 0.04, 0.008, 0.078, 0.07, DARK], // rear sight
    ],
  },
  smg: {
    muzzle: [0, 0.012, -0.36], sightY: 0.07, scope: false,
    boxes: [
      [-0.03, -0.05, -0.2, 0.03, 0.04, 0.1, ORANGE], // body
      [-0.013, -0.005, -0.34, 0.013, 0.025, -0.2, DARK], // barrel
      [-0.016, -0.22, -0.12, 0.016, -0.05, -0.07, BLACK], // long magazine
      [-0.02, -0.13, 0.03, 0.02, -0.045, 0.08, BLACK], // grip
      [-0.012, -0.03, 0.1, 0.012, 0.012, 0.25, METAL], // wire stock
      [-0.008, 0.04, -0.14, 0.008, 0.07, -0.11, DARK], // sight
    ],
  },
  shotgun: {
    muzzle: [0, 0.02, -0.7], sightY: 0.07, scope: false,
    boxes: [
      [-0.03, -0.06, -0.12, 0.03, 0.04, 0.09, METAL], // receiver
      [-0.02, 0.0, -0.66, 0.02, 0.042, -0.12, DARK], // barrel
      [-0.016, -0.034, -0.56, 0.016, 0.0, -0.18, METAL], // magazine tube
      [-0.034, -0.062, -0.46, 0.034, -0.014, -0.3, WOOD], // pump
      [-0.026, -0.075, 0.09, 0.026, 0.03, 0.32, WOOD_DARK], // stock
      [-0.02, -0.14, 0.03, 0.02, -0.055, 0.08, BLACK], // grip
      [-0.006, 0.042, -0.62, 0.006, 0.07, -0.6, STEEL], // bead sight
    ],
  },
  sniper: {
    muzzle: [0, 0.015, -0.98], sightY: 0.1, scope: true,
    boxes: [
      [-0.028, -0.05, -0.22, 0.028, 0.04, 0.12, OLIVE], // receiver
      [-0.012, 0.002, -0.96, 0.012, 0.028, -0.22, DARK], // long barrel
      [-0.02, 0.0, -0.98, 0.02, 0.03, -0.9, BLACK], // muzzle brake
      [-0.026, -0.07, 0.12, 0.026, 0.045, 0.36, OLIVE], // stock
      [-0.02, -0.15, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.018, -0.12, -0.12, 0.018, -0.05, -0.06, BLACK], // magazine
      [-0.024, 0.045, -0.34, 0.024, 0.1, -0.02, DARK], // scope tube
      [-0.03, 0.05, -0.36, 0.03, 0.105, -0.33, BLACK], // scope front bell
      [-0.02, 0.055, -0.355, 0.02, 0.098, -0.349, LENS], // front lens
      [-0.012, 0.04, -0.28, 0.012, 0.046, -0.26, STEEL], // mount
      [-0.012, 0.04, -0.1, 0.012, 0.046, -0.08, STEEL], // mount
      [0.026, -0.005, 0.0, 0.07, 0.012, 0.03, STEEL], // bolt handle
    ],
  },
  dmr: {
    muzzle: [0, 0.018, -0.78], sightY: 0.1, scope: false,
    boxes: [
      [-0.028, -0.05, -0.26, 0.028, 0.04, 0.12, OLIVE], // receiver
      [-0.013, 0.0, -0.76, 0.013, 0.03, -0.26, DARK], // barrel
      [-0.02, -0.01, -0.5, 0.02, 0.04, -0.26, METAL], // handguard
      [-0.02, -0.005, -0.8, 0.02, 0.035, -0.74, BLACK], // muzzle device
      [-0.026, -0.07, 0.12, 0.026, 0.04, 0.34, WOOD_DARK], // stock
      [-0.02, -0.15, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.018, -0.15, -0.12, 0.018, -0.05, -0.06, BLACK], // magazine
      [-0.018, 0.04, -0.3, 0.018, 0.1, -0.1, DARK], // short optic
      [-0.014, 0.06, -0.31, 0.014, 0.092, -0.3, LENS], // front lens
      [-0.01, 0.036, -0.28, 0.01, 0.042, -0.12, STEEL], // mount
    ],
  },
  burst: {
    muzzle: [0, 0.018, -0.5], sightY: 0.078, scope: false,
    boxes: [
      [-0.03, -0.05, -0.26, 0.03, 0.04, 0.12, METAL], // receiver
      [-0.014, 0.0, -0.5, 0.014, 0.034, -0.26, DARK], // barrel
      [-0.022, -0.02, -0.4, 0.022, 0.044, -0.28, ORANGE], // triple-barrel shroud
      [-0.026, -0.065, 0.12, 0.026, 0.035, 0.3, METAL], // stock
      [-0.02, -0.16, -0.08, 0.02, -0.05, -0.02, BLACK], // magazine
      [-0.02, -0.14, 0.04, 0.02, -0.045, 0.09, BLACK], // grip
      [-0.008, 0.04, -0.22, 0.008, 0.078, -0.19, DARK], // front sight
      [-0.008, 0.04, 0.04, 0.008, 0.078, 0.07, DARK], // rear sight
    ],
  },
  revolver: {
    muzzle: [0, 0.025, -0.3], sightY: 0.056, scope: false,
    boxes: [
      [-0.016, 0.0, -0.3, 0.016, 0.04, 0.0, STEEL], // barrel with rib
      [-0.024, -0.03, -0.1, 0.024, 0.045, -0.02, METAL], // cylinder
      [-0.018, -0.04, -0.02, 0.018, 0.05, 0.05, DARK], // frame
      [-0.019, -0.15, 0.02, 0.019, -0.035, 0.08, WOOD], // grip
      [-0.006, 0.04, -0.29, 0.006, 0.058, -0.28, STEEL], // front sight
      [-0.008, 0.05, 0.03, 0.008, 0.058, 0.05, STEEL], // hammer
    ],
  },
  pistol: {
    muzzle: [0, 0.02, -0.24], sightY: 0.05, scope: false,
    boxes: [
      [-0.02, -0.005, -0.22, 0.02, 0.045, 0.03, METAL], // slide
      [-0.018, -0.04, -0.14, 0.018, -0.005, 0.03, DARK], // frame
      [-0.019, -0.14, 0.0, 0.019, -0.035, 0.05, BLACK], // grip
      [-0.006, 0.045, -0.2, 0.006, 0.058, -0.19, STEEL], // front sight
      [-0.008, 0.045, 0.01, 0.008, 0.058, 0.025, STEEL], // rear sight
    ],
  },
  knife: {
    muzzle: [0, 0, -0.34], sightY: 0.0, scope: false,
    boxes: [
      [-0.006, -0.012, -0.36, 0.006, 0.024, -0.06, '#d3dae0'], // blade
      [-0.004, 0.0, -0.34, 0.004, 0.022, -0.1, '#a9b1b8'], // blade edge shading
      [-0.026, -0.035, -0.06, 0.026, 0.035, -0.036, STEEL], // guard
      [-0.016, -0.03, -0.036, 0.016, 0.022, 0.1, WOOD_DARK], // handle
      [-0.018, -0.032, 0.1, 0.018, 0.026, 0.115, STEEL], // pommel
    ],
  },
};

const FACE_SHADE = { top: 1, bottom: 0.55, x: 0.78, z: 0.9 };
const tmpColor = new THREE.Color();

/** Merged, vertex-coloured geometry for a list of boxes. */
export function buildBoxGeometry(boxes: Box[]): THREE.BufferGeometry {
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

/** One shared geometry per weapon id (first-person view and every remote player use it). */
export function weaponGeometry(id: string): THREE.BufferGeometry | null {
  const model = WEAPON_MODELS[id];
  if (!model) return null;
  let g = geometries.get(id);
  if (!g) {
    g = buildBoxGeometry(model.boxes);
    geometries.set(id, g);
  }
  return g;
}

const frontGeometries = new Map<string, THREE.BufferGeometry>();

/** Boxes starting behind this z are the stock: hidden while aiming, so the sights are not blocked. */
const STOCK_FROM_Z = 0.085;

/** The weapon without its stock, for the first-person aiming view. */
export function weaponFrontGeometry(id: string): THREE.BufferGeometry | null {
  const model = WEAPON_MODELS[id];
  if (!model) return null;
  let g = frontGeometries.get(id);
  if (!g) {
    g = buildBoxGeometry(model.boxes.filter((b) => b[2] < STOCK_FROM_Z));
    frontGeometries.set(id, g);
  }
  return g;
}

/** Material shared by all weapon meshes; `color` scales the baked colours (lighting, muzzle flash). */
export function createWeaponMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
}
