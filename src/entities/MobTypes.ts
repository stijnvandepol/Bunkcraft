import { ITEM, type ItemStack } from '../items/ItemRegistry';
import { BLOCK } from '../world/BlockRegistry';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'chicken' | 'zombie' | 'creeper' | 'player';

/** Animation slot a model part follows. */
export type PartAnim = 'none' | 'head' | 'legA' | 'legB' | 'armL' | 'armR' | 'wingL' | 'wingR';

/** A box in model pixels (16 px = 1 block). Front of the mob faces −Z. */
export interface ModelBox {
  from: [number, number, number];
  to: [number, number, number];
  /** Colours for the noisy fill; first is the base. */
  colors: string[];
  /** Large blobs of this colour over the fill (cow patches). */
  patches?: string;
  /** Optional detail painter for the front face (eyes, snout…), in texture pixels. */
  face?: (px: (x: number, y: number, c: string) => void, w: number, h: number) => void;
}

export interface ModelPart {
  anim: PartAnim;
  /** Rotation pivot in model pixels. */
  pivot: [number, number, number];
  boxes: ModelBox[];
}

export interface MobType {
  kind: MobKind;
  name: string;
  health: number;
  width: number;
  height: number;
  /** Blocks per second while wandering / fleeing or chasing. */
  walkSpeed: number;
  runSpeed: number;
  hostile: boolean;
  /** Melee damage (Normal difficulty). */
  attack: number;
  /** Zombie pose: arms held straight forward. */
  armsForward?: boolean;
  parts: ModelPart[];
  drops(): ItemStack[];
}

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const stack = (id: number, count: number): ItemStack[] => (count > 0 ? [{ id, count }] : []);

const eyes = (white: string, pupil: string, y: number) => (px: (x: number, y: number, c: string) => void, w: number) => {
  px(1, y, white); px(2, y, pupil);
  px(w - 3, y, pupil); px(w - 2, y, white);
};

// Four-legged layout helper: legs at the corners with pivots at their tops.
function quadLegs(w: number, h: number, xOff: number, zFront: number, zBack: number, colors: string[]): ModelPart[] {
  const leg = (x: number, z: number, anim: PartAnim): ModelPart => ({
    anim,
    pivot: [x + w / 2, h, z + w / 2],
    boxes: [{ from: [x, 0, z], to: [x + w, h, z + w], colors }],
  });
  return [
    leg(-xOff - w, zFront, 'legA'), leg(xOff, zFront, 'legB'),
    leg(-xOff - w, zBack, 'legB'), leg(xOff, zBack, 'legA'),
  ];
}

const PIG_SKIN = ['#efa3a0', '#e8958f', '#f4b1ad', '#e28a86'];
const COW_HIDE = ['#4a3324', '#3c291c', '#56402d'];
const WOOL = ['#e9e9e9', '#dedede', '#f4f4f4', '#d2d2d2'];
const SHEEP_SKIN = ['#d9bfa6', '#cdb194', '#e3cbb4'];
const ZOMBIE_SKIN = ['#4f8a3c', '#457c34', '#5a9a45', '#3f7130'];
const CREEPER = ['#4caa3a', '#3a8a2c', '#6dc95a', '#2f6e23', '#87d873', '#5bb748'];

export const MOB_TYPES = {
  pig: {
    kind: 'pig', name: 'Pig', health: 10, width: 0.9, height: 0.9, walkSpeed: 1.3, runSpeed: 2.6, hostile: false, attack: 0,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-5, 6, -8], to: [5, 14, 8], colors: PIG_SKIN }] },
      {
        anim: 'head', pivot: [0, 12, -8], boxes: [
          { from: [-4, 8, -15], to: [4, 16, -7], colors: PIG_SKIN, face: eyes('#ffffff', '#1f1f1f', 3) },
          { from: [-2, 9, -16], to: [2, 12, -15], colors: ['#e28a86'], face: (px) => { px(1, 1, '#8a4a48'); px(2, 1, '#8a4a48'); } },
        ],
      },
      ...quadLegs(4, 6, 1, -7, 3, PIG_SKIN),
    ],
    drops: () => stack(ITEM.PORKCHOP, rnd(1, 3)),
  },
  cow: {
    kind: 'cow', name: 'Cow', health: 10, width: 0.9, height: 1.4, walkSpeed: 1.2, runSpeed: 2.4, hostile: false, attack: 0,
    parts: [
      {
        anim: 'none', pivot: [0, 0, 0], boxes: [
          { from: [-6, 10, -9], to: [6, 20, 9], colors: COW_HIDE, patches: '#e6e3da' },
          { from: [-2, 8, 3], to: [2, 10, 8], colors: ['#e8a7a3'] },
        ],
      },
      {
        anim: 'head', pivot: [0, 18, -9], boxes: [
          { from: [-4, 14, -15], to: [4, 22, -9], colors: ['#3c291c', '#4a3324'], face: (px, w) => {
            eyes('#ffffff', '#111111', 3)(px, w);
            for (let x = 2; x < w - 2; x++) for (let y = 5; y < 8; y++) px(x, y, '#d9d6cc');
            px(3, 6, '#5a5550'); px(w - 4, 6, '#5a5550');
          } },
          { from: [-5, 20, -13], to: [-4, 23, -12], colors: ['#d7d2c4'] },
          { from: [4, 20, -13], to: [5, 23, -12], colors: ['#d7d2c4'] },
        ],
      },
      ...quadLegs(4, 10, 2, -8, 4, ['#3c291c', '#4a3324']),
    ],
    drops: () => [...stack(ITEM.BEEF, rnd(1, 3))],
  },
  sheep: {
    kind: 'sheep', name: 'Sheep', health: 8, width: 0.9, height: 1.3, walkSpeed: 1.2, runSpeed: 2.4, hostile: false, attack: 0,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-6, 10, -9], to: [6, 20, 9], colors: WOOL }] },
      {
        anim: 'head', pivot: [0, 18, -8], boxes: [
          { from: [-3, 15, -14], to: [3, 21, -7], colors: SHEEP_SKIN, face: eyes('#ffffff', '#2a2a2a', 2) },
          { from: [-3.5, 19, -13], to: [3.5, 22, -7], colors: WOOL },
        ],
      },
      ...quadLegs(4, 11, 1, -7, 3, SHEEP_SKIN),
    ],
    drops: () => [...stack(BLOCK.WHITE_WOOL, 1), ...stack(ITEM.MUTTON, rnd(1, 2))],
  },
  chicken: {
    kind: 'chicken', name: 'Chicken', health: 4, width: 0.4, height: 0.7, walkSpeed: 1.1, runSpeed: 2.4, hostile: false, attack: 0,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-3, 4, -4], to: [3, 10, 4], colors: ['#f2f2f2', '#e6e6e6', '#ffffff'] }] },
      {
        anim: 'head', pivot: [0, 9, -4], boxes: [
          { from: [-2, 9, -7], to: [2, 15, -4], colors: ['#f2f2f2', '#ffffff'], face: eyes('#ffffff', '#111111', 1) },
          { from: [-2, 11, -9], to: [2, 13, -7], colors: ['#f0b52a', '#e3a21d'] },
          { from: [-1, 9, -8], to: [1, 11, -7], colors: ['#d8282a'] },
        ],
      },
      { anim: 'wingL', pivot: [-3, 10, 0], boxes: [{ from: [-4, 5, -3], to: [-3, 9, 3], colors: ['#ebebeb', '#dedede'] }] },
      { anim: 'wingR', pivot: [3, 10, 0], boxes: [{ from: [3, 5, -3], to: [4, 9, 3], colors: ['#ebebeb', '#dedede'] }] },
      { anim: 'legA', pivot: [-1.5, 4, 0], boxes: [{ from: [-2, 0, -0.5], to: [-1, 4, 0.5], colors: ['#e5a92a'] }] },
      { anim: 'legB', pivot: [1.5, 4, 0], boxes: [{ from: [1, 0, -0.5], to: [2, 4, 0.5], colors: ['#e5a92a'] }] },
    ],
    drops: () => [...stack(ITEM.CHICKEN, 1), ...stack(ITEM.FEATHER, rnd(0, 2))],
  },
  zombie: {
    kind: 'zombie', name: 'Zombie', health: 20, width: 0.6, height: 1.95, walkSpeed: 1.0, runSpeed: 2.6, hostile: true, attack: 3, armsForward: true,
    parts: [
      {
        anim: 'head', pivot: [0, 24, 0], boxes: [{ from: [-4, 24, -4], to: [4, 32, 4], colors: ZOMBIE_SKIN, face: (px, w) => {
          for (const x of [1, 2, w - 3, w - 2]) px(x, 4, '#101010');
          px(3, 6, '#2f5a26'); px(4, 6, '#2f5a26');
        } }],
      },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 12, -2], to: [4, 24, 2], colors: ['#2e8c95', '#277b84', '#35a0aa'] }] },
      { anim: 'armL', pivot: [-6, 22, 0], boxes: [{ from: [-8, 12, -2], to: [-4, 24, 2], colors: ZOMBIE_SKIN }] },
      { anim: 'armR', pivot: [6, 22, 0], boxes: [{ from: [4, 12, -2], to: [8, 24, 2], colors: ZOMBIE_SKIN }] },
      { anim: 'legA', pivot: [-2, 12, 0], boxes: [{ from: [-4, 0, -2], to: [0, 12, 2], colors: ['#3b3a8c', '#33327a', '#46459e'] }] },
      { anim: 'legB', pivot: [2, 12, 0], boxes: [{ from: [0, 0, -2], to: [4, 12, 2], colors: ['#3b3a8c', '#33327a', '#46459e'] }] },
    ],
    drops: () => stack(ITEM.ROTTEN_FLESH, rnd(0, 2)),
  },
  creeper: {
    kind: 'creeper', name: 'Creeper', health: 20, width: 0.6, height: 1.7, walkSpeed: 1.0, runSpeed: 2.3, hostile: true, attack: 0,
    parts: [
      {
        anim: 'head', pivot: [0, 18, 0], boxes: [{ from: [-4, 18, -4], to: [4, 26, 4], colors: CREEPER, face: (px) => {
          const k = '#0e0e0e';
          for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3], [5, 2], [6, 2], [5, 3], [6, 3], [3, 4], [4, 4], [2, 5], [3, 5], [4, 5], [5, 5], [2, 6], [5, 6], [3, 6], [4, 6]]) px(x, y, k);
        } }],
      },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 6, -2], to: [4, 18, 2], colors: CREEPER }] },
      ...quadLegs(4, 6, 0, -6, 2, CREEPER),
    ],
    drops: () => stack(ITEM.GUNPOWDER, rnd(0, 2)),
  },
} as Record<MobKind, MobType>;

const SKIN = ['#c99a7a', '#bf8f6f', '#d1a585'];
const SHIRT = ['#2d9fa6', '#268a90', '#33b0b8'];
const PANTS = ['#3a3f9a', '#323688', '#4248aa'];

MOB_TYPES.player = {
  kind: 'player', name: 'Player', health: 20, width: 0.6, height: 1.8, walkSpeed: 0, runSpeed: 0, hostile: false, attack: 0,
  parts: [
    {
      anim: 'head', pivot: [0, 24, 0], boxes: [{ from: [-4, 24, -4], to: [4, 32, 4], colors: SKIN, face: (px, w) => {
        for (let x = 0; x < w; x++) px(x, 0, '#3b2414'), px(x, 1, '#4a2e1a');
        px(0, 2, '#3b2414'); px(w - 1, 2, '#3b2414');
        px(1, 4, '#ffffff'); px(2, 4, '#3a5bb0'); px(w - 3, 4, '#3a5bb0'); px(w - 2, 4, '#ffffff');
        px(3, 6, '#8a5a40'); px(4, 6, '#8a5a40');
      } }],
    },
    { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 12, -2], to: [4, 24, 2], colors: SHIRT }] },
    { anim: 'armL', pivot: [-6, 22, 0], boxes: [{ from: [-8, 12, -2], to: [-4, 24, 2], colors: SKIN }] },
    { anim: 'armR', pivot: [6, 22, 0], boxes: [{ from: [4, 12, -2], to: [8, 24, 2], colors: SKIN }] },
    { anim: 'legA', pivot: [-2, 12, 0], boxes: [{ from: [-4, 0, -2], to: [0, 12, 2], colors: PANTS }] },
    { anim: 'legB', pivot: [2, 12, 0], boxes: [{ from: [0, 0, -2], to: [4, 12, 2], colors: PANTS }] },
  ],
  drops: () => [],
};

export const PASSIVE_KINDS: MobKind[] = ['pig', 'cow', 'sheep', 'chicken'];
export const HOSTILE_KINDS: MobKind[] = ['zombie', 'creeper'];
