import { ITEM, type ItemStack } from '../items/ItemRegistry';
import { BLOCK } from '../world/BlockRegistry';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'chicken' | 'zombie' | 'creeper' | 'skeleton' | 'spider' | 'player' | 'player_red' | 'player_blue';

/** Animation slot a model part follows. */
export type PartAnim = 'none' | 'head' | 'legA' | 'legB' | 'armL' | 'armR' | 'wingL' | 'wingR' | 'spiderA' | 'spiderB';

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
  /** Rest pose rotation (x, y, z radians; applied Z, then X, then Y), e.g. splayed spider legs. */
  rest?: [number, number, number];
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
  /** Burns in direct sunlight (zombie, skeleton). */
  burnsInDaylight?: boolean;
  /** Shoots arrows instead of melee (skeleton). */
  ranged?: boolean;
  /** Climbs walls (spider). */
  climbs?: boolean;
  /** Neutral in bright light unless provoked (spider). */
  neutralInLight?: boolean;
  parts: ModelPart[];
  /** @param byPlayer killed by the player (some drops, like spider eyes, need it). */
  drops(byPlayer: boolean): ItemStack[];
}

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const stack = (id: number, count: number): ItemStack[] => (count > 0 ? [{ id, count }] : []);

type FacePainter = (px: (x: number, y: number, c: string) => void, w: number) => void;

/**
 * Two eyes on the front face of a head that is `w` texture pixels wide, always symmetric.
 * Wide faces (≥ 8 px) get a white of the eye on the outside and a pupil inside; narrow faces
 * (sheep 6 px, chicken 4 px) have no room for that, so the pupils sit at the outer columns and
 * the whites are skipped. The old fixed layout made the pupils of a 6 px face touch (one wide
 * eye) and overwrote one eye of a 4 px face completely. `tall` paints the pupil two rows high.
 */
const eyes = (white: string, pupil: string, y: number, tall = false): FacePainter => (px, w) => {
  const eye = (x: number, x2: number) => {
    px(x, y, pupil);
    if (tall) px(x, y + 1, pupil);
    if (x2 >= 0) { px(x2, y, white); if (tall) px(x2, y + 1, white); }
  };
  if (w >= 8) { eye(2, 1); eye(w - 3, w - 2); }
  else if (w >= 6) { eye(1, 0); eye(w - 2, w - 1); }
  else { eye(0, -1); eye(w - 1, -1); }
};

// Four-legged layout helper: legs at the corners with pivots at their tops.
function quadLegs(w: number, h: number, xOff: number, zFront: number, zBack: number, colors: string[], sleeve?: string[], sleeveH = 6): ModelPart[] {
  const leg = (x: number, z: number, anim: PartAnim): ModelPart => ({
    anim,
    pivot: [x + w / 2, h, z + w / 2],
    boxes: [
      { from: [x, 0, z], to: [x + w, h, z + w], colors },
      // Wool sleeve around the upper part of the leg (sheep), slightly larger than the leg.
      ...(sleeve ? [{ from: [x - 0.5, h - sleeveH, z - 0.5] as [number, number, number], to: [x + w + 0.5, h, z + w + 0.5] as [number, number, number], colors: sleeve }] : []),
    ],
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
const BONE = ['#c8c8c8', '#b4b4b4', '#d8d8d8', '#a0a0a0'];
const SPIDER = ['#2e2620', '#3a3029', '#241e19', '#463a31'];

/**
 * Spider legs as in Minecraft's model: 16×2×2, four per side, tilted 45° down and fanned
 * forward/back; alternate legs swing in opposite phase.
 */
function spiderLegs(): ModelPart[] {
  const legs: ModelPart[] = [];
  const fan = [-Math.PI / 4, -Math.PI / 8, Math.PI / 8, Math.PI / 4];
  [-1, 0, 1, 2].forEach((zRow, i) => {
    const z = zRow;
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -19 : 3, x1 = side < 0 ? -3 : 19;
      legs.push({
        anim: (i + (side < 0 ? 0 : 1)) % 2 === 0 ? 'spiderA' : 'spiderB',
        pivot: [side * 3, 9, z],
        rest: [0, side < 0 ? fan[i] : -fan[i], side < 0 ? Math.PI / 4 * 0.75 : -Math.PI / 4 * 0.75],
        boxes: [{ from: [x0, 8, z - 1], to: [x1, 10, z + 1], colors: SPIDER }],
      });
    }
  });
  return legs;
}

export const MOB_TYPES = {
  pig: {
    kind: 'pig', name: 'Pig', health: 10, width: 0.9, height: 0.9, walkSpeed: 1.3, runSpeed: 2.6, hostile: false, attack: 0,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-5, 6, -8], to: [5, 14, 8], colors: PIG_SKIN }] },
      {
        anim: 'head', pivot: [0, 12, -8], boxes: [
          { from: [-4, 8, -15], to: [4, 16, -7], colors: PIG_SKIN, face: eyes('#ffffff', '#1f1f1f', 3, true) },
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
          { from: [-6, 12, -9], to: [6, 22, 9], colors: COW_HIDE, patches: '#e6e3da' },
          { from: [-2, 10, 3], to: [2, 12, 8], colors: ['#e8a7a3', '#dc9894'] },
        ],
      },
      {
        anim: 'head', pivot: [0, 20, -9], boxes: [
          { from: [-4, 16, -15], to: [4, 24, -9], colors: ['#3c291c', '#4a3324'], face: (px, w) => {
            eyes('#ffffff', '#111111', 2, true)(px, w);
            for (let x = 2; x < w - 2; x++) for (let y = 5; y < 8; y++) px(x, y, '#d9d6cc');
            px(3, 6, '#5a5550'); px(w - 4, 6, '#5a5550');
          } },
          { from: [-5, 22, -13], to: [-4, 25, -12], colors: ['#d7d2c4'] },
          { from: [4, 22, -13], to: [5, 25, -12], colors: ['#d7d2c4'] },
        ],
      },
      ...quadLegs(4, 12, 2, -8, 4, ['#3c291c', '#4a3324']),
    ],
    drops: () => [...stack(ITEM.BEEF, rnd(1, 3))],
  },
  sheep: {
    kind: 'sheep', name: 'Sheep', health: 8, width: 0.9, height: 1.3, walkSpeed: 1.2, runSpeed: 2.4, hostile: false, attack: 0,
    parts: [
      // Wool layer: a larger box around the (hidden) skin body, like Minecraft's fleece model.
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-6, 11, -9], to: [6, 21, 9], colors: WOOL }] },
      {
        anim: 'head', pivot: [0, 18, -8], boxes: [
          { from: [-3, 15, -16], to: [3, 21, -8], colors: SHEEP_SKIN, face: eyes('#ffffff', '#2a2a2a', 2, true) },
          // Fleece on the back of the head and the forehead.
          { from: [-3.6, 14.6, -12], to: [3.6, 21.8, -7.4], colors: WOOL },
        ],
      },
      ...quadLegs(4, 12, 1, -7, 3, SHEEP_SKIN, WOOL, 6),
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
    kind: 'zombie', name: 'Zombie', health: 20, width: 0.6, height: 1.95, walkSpeed: 1.0, runSpeed: 2.6, hostile: true, attack: 3, armsForward: true, burnsInDaylight: true,
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
  skeleton: {
    kind: 'skeleton', name: 'Skeleton', health: 20, width: 0.6, height: 1.99, walkSpeed: 1.0, runSpeed: 2.5, hostile: true, attack: 0,
    armsForward: true, burnsInDaylight: true, ranged: true,
    parts: [
      {
        anim: 'head', pivot: [0, 24, 0], boxes: [{ from: [-4, 24, -4], to: [4, 32, 4], colors: BONE, face: (px, w) => {
          for (const [x, y] of [[1, 3], [2, 3], [1, 4], [2, 4], [w - 3, 3], [w - 2, 3], [w - 3, 4], [w - 2, 4]]) px(x, y, '#2a2a2a');
          px(3, 5, '#5a5a5a'); px(4, 5, '#5a5a5a');
          for (let x = 1; x < w - 1; x++) px(x, 6, x % 2 ? '#3a3a3a' : '#8a8a8a');
        } }],
      },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 12, -2], to: [4, 24, 2], colors: BONE, face: (px, w, h) => {
        // Ribcage: dark gaps between bone ribs, a spine in the middle.
        for (let y = 1; y < h - 3; y += 2) for (let x = 0; x < w; x++) px(x, y, x === w / 2 - 1 || x === w / 2 ? '#d8d8d8' : '#4a4a4a');
      } }] },
      { anim: 'armL', pivot: [-5, 22, 0], boxes: [{ from: [-6, 12, -1], to: [-4, 24, 1], colors: BONE }] },
      { anim: 'armR', pivot: [5, 22, 0], boxes: [{ from: [4, 12, -1], to: [6, 24, 1], colors: BONE }] },
      { anim: 'legA', pivot: [-2, 12, 0], boxes: [{ from: [-3, 0, -1], to: [-1, 12, 1], colors: BONE }] },
      { anim: 'legB', pivot: [2, 12, 0], boxes: [{ from: [1, 0, -1], to: [3, 12, 1], colors: BONE }] },
    ],
    drops: () => [...stack(ITEM.BONE, rnd(0, 2)), ...stack(ITEM.ARROW, rnd(0, 2))],
  },
  spider: {
    kind: 'spider', name: 'Spider', health: 16, width: 1.4, height: 0.9, walkSpeed: 1.2, runSpeed: 3.4, hostile: true, attack: 2,
    climbs: true, neutralInLight: true,
    parts: [
      {
        anim: 'none', pivot: [0, 0, 0], boxes: [
          { from: [-5, 4, 3], to: [5, 12, 15], colors: SPIDER, patches: '#4a1414' },
          { from: [-3, 6, -3], to: [3, 12, 3], colors: SPIDER },
        ],
      },
      {
        anim: 'head', pivot: [0, 9, -3], boxes: [{ from: [-4, 5, -11], to: [4, 13, -3], colors: SPIDER, face: (px) => {
          // Two large eyes and six small ones, like the vanilla spider.
          for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3], [5, 2], [6, 2], [5, 3], [6, 3]]) px(x, y, '#c41414');
          for (const [x, y] of [[3, 1], [4, 1], [0, 4], [7, 4], [3, 4], [4, 4]]) px(x, y, '#8a1010');
        } }],
      },
      ...spiderLegs(),
    ],
    drops: (byPlayer: boolean) => [...stack(ITEM.STRING, rnd(0, 2)), ...(byPlayer && Math.random() < 1 / 3 ? stack(ITEM.SPIDER_EYE, 1) : [])],
  },
} satisfies Omit<Record<MobKind, MobType>, 'player' | 'player_red' | 'player_blue'> as unknown as Record<MobKind, MobType>;

const SKIN = ['#c99a7a', '#bf8f6f', '#d1a585'];
const SHIRT = ['#2d9fa6', '#268a90', '#33b0b8'];
const PANTS = ['#3a3f9a', '#323688', '#4248aa'];

/** The player model; arcade teams get a coloured shirt and a head band (so the team reads from afar). */
function playerType(kind: MobKind, shirt: string[], band?: string[]): MobType {
  const headBoxes: ModelBox[] = [{ from: [-4, 24, -4], to: [4, 32, 4], colors: SKIN, face: (px, w) => {
    for (let x = 0; x < w; x++) px(x, 0, '#3b2414'), px(x, 1, '#4a2e1a');
    px(0, 2, '#3b2414'); px(w - 1, 2, '#3b2414');
    px(1, 4, '#ffffff'); px(2, 4, '#3a5bb0'); px(w - 3, 4, '#3a5bb0'); px(w - 2, 4, '#ffffff');
    px(3, 6, '#8a5a40'); px(4, 6, '#8a5a40');
  } }];
  if (band) headBoxes.push({ from: [-4.5, 28, -4.5], to: [4.5, 30.5, 4.5], colors: band });
  return {
    kind, name: 'Player', health: 20, width: 0.6, height: 1.8, walkSpeed: 0, runSpeed: 0, hostile: false, attack: 0,
    parts: [
      { anim: 'head', pivot: [0, 24, 0], boxes: headBoxes },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 12, -2], to: [4, 24, 2], colors: shirt }] },
      { anim: 'armL', pivot: [-6, 22, 0], boxes: [{ from: [-8, 12, -2], to: [-4, 24, 2], colors: SKIN }] },
      { anim: 'armR', pivot: [6, 22, 0], boxes: [{ from: [4, 12, -2], to: [8, 24, 2], colors: SKIN }] },
      { anim: 'legA', pivot: [-2, 12, 0], boxes: [{ from: [-4, 0, -2], to: [0, 12, 2], colors: PANTS }] },
      { anim: 'legB', pivot: [2, 12, 0], boxes: [{ from: [0, 0, -2], to: [4, 12, 2], colors: PANTS }] },
    ],
    drops: () => [],
  };
}

MOB_TYPES.player = playerType('player', SHIRT);
MOB_TYPES.player_red = playerType('player_red', ['#c8372f', '#b32d26', '#d8443b'], ['#ff4a3d', '#e63a2e']);
MOB_TYPES.player_blue = playerType('player_blue', ['#2f5fc8', '#2850b0', '#3a6fdc'], ['#4a8bff', '#3a77e8']);

export const PASSIVE_KINDS: MobKind[] = ['pig', 'cow', 'sheep', 'chicken'];
// Minecraft overworld spawn weights are equal (100 each) for these four.
export const HOSTILE_KINDS: MobKind[] = ['zombie', 'creeper', 'skeleton', 'spider'];
