import { ITEM, type ItemStack, itemFromState, itemId } from '../items/ItemRegistry';
import { SKIN_BOXES, type SkinBox } from '../skins/SkinFormat';
import { BLOCK } from '../world/BlockRegistry';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'chicken' | 'zombie' | 'creeper' | 'skeleton' | 'spider' | 'player' | 'player_red' | 'player_blue'
  | 'wolf' | 'enderman' | 'slime' | 'drowned' | 'husk' | 'stray' | 'cave_spider' | 'witch' | 'horse';

/** Animation slot a model part follows. */
export type PartAnim = 'none' | 'head' | 'legA' | 'legB' | 'armL' | 'armR' | 'wingL' | 'wingR' | 'spiderA' | 'spiderB' | 'tail';

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
  /**
   * Skinned boxes (the player): where this box lives in a 64x64 classic skin (box UV origin and size). The box may be
   * larger than its UV size (the overlay layer is inflated) and `colors` is unused.
   */
  skin?: SkinBox;
  /** Skinned boxes: every face samples the solid strip of the skin (a team head band; the colour comes from the part's tint). */
  solid?: boolean;
}

export interface ModelPart {
  anim: PartAnim;
  /** Rotation pivot in model pixels. */
  pivot: [number, number, number];
  /** Rest pose rotation (x, y, z radians; applied Z, then X, then Y), e.g. splayed spider legs. */
  rest?: [number, number, number];
  /**
   * Per-mob colour multiplied into this part's (grey) texture: 'dye' = the colour in `variant & 15` (sheep wool, wolf
   * collar), 'coat' = a horse coat from `variant & 7`.
   */
  tint?: 'dye' | 'coat' | 'fixed';
  /** `tint: 'fixed'`: the colour (0..1) multiplied into this part, the same for every mob of the type (team head band). */
  tintRGB?: [number, number, number];
  /** Multiplied into this part when the mob wears a custom skin, so a team still reads from the colour of its torso. */
  customTint?: [number, number, number];
  /** Only drawn on tamed (wolf collar) or saddled (horse saddle) mobs. */
  only?: 'tamed' | 'saddled';
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
  /** Blocks within which a hostile mob notices the player (attribute follow_range): 16 unless set (zombie 35). */
  followRange?: number;
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
  /** Runs away when hurt (Minecraft's PanicGoal: farm animals, horses). */
  flees?: boolean;
  /** Model scale (cave spider 0.7). */
  scale?: number;
  /**
   * The model is textured from the shared skin atlas (src/rendering/SkinAtlas.ts) instead of its own painted texture:
   * `skinSlot` is the atlas cell of the default skin of this type, a mob's own `skin` overrides it.
   */
  skinSlot?: number;
  /** Ticks of Poison a hit inflicts (cave spider: 7 s on Normal). */
  poison?: number;
  /** Spawn category for the caps: monster, creature, ambient or water. Defaults from `hostile`. */
  category?: 'monster' | 'creature' | 'ambient' | 'water';
  parts: ModelPart[];
  /** @param byPlayer killed by the player (some drops, like spider eyes, need it). */
  drops(byPlayer: boolean, mob?: { variant: number; size: number; baby: boolean }): ItemStack[];
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

// Four-legged layout helper: legs at the corners with pivots at their tops. With `sleeveH` the parts are wool
// sleeves around the upper `sleeveH` pixels of the legs instead (sheep), slightly larger than the leg.
function quadLegs(w: number, h: number, xOff: number, zFront: number, zBack: number, colors: string[], sleeveH = 0): ModelPart[] {
  const leg = (x: number, z: number, anim: PartAnim): ModelPart => ({
    anim,
    pivot: [x + w / 2, h, z + w / 2],
    boxes: [sleeveH > 0
      ? { from: [x - 0.5, h - sleeveH, z - 0.5], to: [x + w + 0.5, h, z + w + 0.5], colors }
      : { from: [x, 0, z], to: [x + w, h, z + w], colors }],
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
function spiderLegs(colors: string[] = SPIDER): ModelPart[] {
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
        boxes: [{ from: [x0, 8, z - 1], to: [x1, 10, z + 1], colors }],
      });
    }
  });
  return legs;
}

export const MOB_TYPES = {
  pig: {
    kind: 'pig', name: 'Pig', flees: true, health: 10, width: 0.9, height: 0.9, walkSpeed: 1.3, runSpeed: 2.6, hostile: false, attack: 0,
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
    kind: 'cow', name: 'Cow', flees: true, health: 10, width: 0.9, height: 1.4, walkSpeed: 1.2, runSpeed: 2.4, hostile: false, attack: 0,
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
    drops: () => [...stack(ITEM.BEEF, rnd(1, 3)), ...stack(itemId('leather'), rnd(0, 2))],
  },
  sheep: {
    kind: 'sheep', name: 'Sheep', flees: true, health: 8, width: 0.9, height: 1.3, walkSpeed: 1.2, runSpeed: 2.4, hostile: false, attack: 0,
    parts: [
      // Wool layer: a larger box around the skin body, like Minecraft's fleece model. Grey-white so the per-sheep
      // dye colour multiplies in; a shorn sheep hides every 'dye' part and shows the skin body.
      { anim: 'none', pivot: [0, 0, 0], tint: 'dye', boxes: [{ from: [-6, 11, -9], to: [6, 21, 9], colors: WOOL }] },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4.5, 12, -7.5], to: [4.5, 20, 7.5], colors: SHEEP_SKIN }] },
      {
        anim: 'head', pivot: [0, 18, -8], boxes: [
          { from: [-3, 15, -16], to: [3, 21, -8], colors: SHEEP_SKIN, face: eyes('#ffffff', '#2a2a2a', 2, true) },
        ],
      },
      // Fleece on the back of the head and the forehead.
      { anim: 'head', pivot: [0, 18, -8], tint: 'dye', boxes: [{ from: [-3.6, 14.6, -12], to: [3.6, 21.8, -7.4], colors: WOOL }] },
      ...quadLegs(4, 12, 1, -7, 3, SHEEP_SKIN),
      ...quadLegs(4, 12, 1, -7, 3, WOOL, 6).map((p) => ({ ...p, tint: 'dye' as const })),
    ],
    drops: (_byPlayer: boolean, mob?: { variant: number }) => [
      ...(mob && mob.variant & 16 ? [] : [{ id: itemFromState(BLOCK.WOOL, (mob?.variant ?? 0) & 15), count: 1 }]),
      ...stack(ITEM.MUTTON, rnd(1, 2)),
    ],
  },
  chicken: {
    kind: 'chicken', name: 'Chicken', flees: true, health: 4, width: 0.4, height: 0.7, walkSpeed: 1.1, runSpeed: 2.4, hostile: false, attack: 0,
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
    kind: 'zombie', name: 'Zombie', health: 20, width: 0.6, height: 1.95, walkSpeed: 1.0, runSpeed: 2.6, hostile: true, attack: 3, followRange: 35, armsForward: true, burnsInDaylight: true,
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
    drops: (byPlayer: boolean) => zombieDrops(byPlayer),
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
} satisfies Omit<Record<MobKind, MobType>, 'player' | 'player_red' | 'player_blue' | ExtraKind> as unknown as Record<MobKind, MobType>;

/**
 * The player model: the classic Minecraft layout (8x8x8 head, 8x12x4 body, 4x12x4 arms and legs, 16 px = 1 block), each
 * box followed by its overlay layer (hat, jacket, sleeves, pants: 0.25 px larger, 0.5 for the hat) so classic 64x64
 * skins fit as they are. Arcade teams add a coloured head band, tinted per part, and tint the torso of custom skins.
 */
function playerType(kind: MobKind, skinSlot: number, team?: { band: [number, number, number]; body: [number, number, number] }): MobType {
  const box = (from: [number, number, number], to: [number, number, number], skin: SkinBox, grow = 0): ModelBox => ({
    from: [from[0] - grow, from[1] - grow, from[2] - grow], to: [to[0] + grow, to[1] + grow, to[2] + grow], colors: ['#c99a7a'], skin,
  });
  const B = SKIN_BOXES;
  const part = (anim: PartAnim, pivot: [number, number, number], boxes: ModelBox[], extra: Partial<ModelPart> = {}): ModelPart => ({ anim, pivot, boxes, ...extra });
  const parts: ModelPart[] = [
    part('head', [0, 24, 0], [box([-4, 24, -4], [4, 32, 4], B.head), box([-4, 24, -4], [4, 32, 4], B.hat, 0.5)]),
    part('none', [0, 0, 0], [box([-4, 12, -2], [4, 24, 2], B.body), box([-4, 12, -2], [4, 24, 2], B.jacket, 0.25)], team ? { customTint: team.body } : {}),
    // The player's left is −X (the model faces −Z): armL/legA are the left limbs.
    part('armL', [-6, 22, 0], [box([-8, 12, -2], [-4, 24, 2], B.leftArm), box([-8, 12, -2], [-4, 24, 2], B.leftSleeve, 0.25)]),
    part('armR', [6, 22, 0], [box([4, 12, -2], [8, 24, 2], B.rightArm), box([4, 12, -2], [8, 24, 2], B.rightSleeve, 0.25)]),
    part('legA', [-2, 12, 0], [box([-4, 0, -2], [0, 12, 2], B.leftLeg), box([-4, 0, -2], [0, 12, 2], B.leftPants, 0.25)]),
    part('legB', [2, 12, 0], [box([0, 0, -2], [4, 12, 2], B.rightLeg), box([0, 0, -2], [4, 12, 2], B.rightPants, 0.25)]),
  ];
  if (team) {
    // Wider than the hat so the two never fight over the same pixels.
    parts.push(part('head', [0, 24, 0], [{ from: [-4.75, 28, -4.75], to: [4.75, 30.5, 4.75], colors: ['#ffffff'], skin: B.head, solid: true }], { tint: 'fixed', tintRGB: team.band }));
  }
  return {
    // Drawn at 0.9: the 32 px model is then exactly the 1.8 block player (Hitscan.PLAYER_MODEL_SCALE, the hitboxes follow it).
    kind, name: 'Player', health: 20, width: 0.6, height: 1.8, scale: 0.9, walkSpeed: 0, runSpeed: 0, hostile: false, attack: 0,
    skinSlot, parts, drops: () => [],
  };
}

/** Atlas cells of the default skins (see rendering/SkinAtlas.ts: DEFAULT_SKIN_SHIRTS paints them). */
export const SKIN_SLOT = { neutral: 0, red: 1, blue: 2, firstCustom: 3 } as const;
MOB_TYPES.player = playerType('player', SKIN_SLOT.neutral);
MOB_TYPES.player_red = playerType('player_red', SKIN_SLOT.red, { band: [1, 0.29, 0.24], body: [1, 0.55, 0.5] });
MOB_TYPES.player_blue = playerType('player_blue', SKIN_SLOT.blue, { band: [0.29, 0.55, 1], body: [0.5, 0.68, 1] });

export const PASSIVE_KINDS: MobKind[] = ['pig', 'cow', 'sheep', 'chicken'];
// Minecraft overworld spawn weights are equal (100 each) for these four.
export const HOSTILE_KINDS: MobKind[] = ['zombie', 'creeper', 'skeleton', 'spider'];

// ---------------------------------------------------------------- more mobs (wolf, enderman, slime, variants...)

type ExtraKind = 'wolf' | 'enderman' | 'slime' | 'drowned' | 'husk' | 'stray' | 'cave_spider' | 'witch' | 'horse';

const named = (name: string, min: number, max: number): ItemStack[] => stack(itemId(name), rnd(min, max));

const zombieFace = (mouth: string) => (px: (x: number, y: number, c: string) => void, w: number) => {
  for (const x of [1, 2, w - 3, w - 2]) px(x, 4, '#101010');
  px(3, 6, mouth); px(4, 6, mouth);
};

/**
 * Zombie loot (Java 1.21): 0-2 rotten flesh, and when a player killed it a rare drop 2.5% of the time: an iron ingot,
 * a carrot or a potato (one of the three).
 */
function zombieDrops(byPlayer: boolean): ItemStack[] {
  const out = stack(ITEM.ROTTEN_FLESH, rnd(0, 2));
  if (byPlayer && Math.random() < 0.025) out.push(...stack(itemId(['iron_ingot', 'carrot', 'potato'][Math.floor(Math.random() * 3)]), 1));
  return out;
}

/** Zombie-shaped mobs (husk, drowned) with their own skin, shirt and trousers. */
function zombieLike(kind: MobKind, name: string, skin: string[], shirt: string[], pants: string[], mouth: string, extra: Partial<MobType>): MobType {
  return {
    kind, name, health: 20, width: 0.6, height: 1.95, walkSpeed: 1.0, runSpeed: 2.6, hostile: true, attack: 3, followRange: 35, armsForward: true,
    parts: [
      { anim: 'head', pivot: [0, 24, 0], boxes: [{ from: [-4, 24, -4], to: [4, 32, 4], colors: skin, face: zombieFace(mouth) }] },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 12, -2], to: [4, 24, 2], colors: shirt }] },
      { anim: 'armL', pivot: [-6, 22, 0], boxes: [{ from: [-8, 12, -2], to: [-4, 24, 2], colors: skin }] },
      { anim: 'armR', pivot: [6, 22, 0], boxes: [{ from: [4, 12, -2], to: [8, 24, 2], colors: skin }] },
      { anim: 'legA', pivot: [-2, 12, 0], boxes: [{ from: [-4, 0, -2], to: [0, 12, 2], colors: pants }] },
      { anim: 'legB', pivot: [2, 12, 0], boxes: [{ from: [0, 0, -2], to: [4, 12, 2], colors: pants }] },
    ],
    drops: (byPlayer: boolean) => zombieDrops(byPlayer),
    ...extra,
  };
}

const WOLF = ['#d9d5d0', '#cbc6bf', '#e6e2dd', '#bdb7ae'];
const WOLF_DARK = ['#b3aca2', '#a39c92', '#c0b9b0'];
const ENDER = ['#161616', '#101010', '#1d1d1d', '#131313'];
const SLIME = ['#7ccf5c', '#6fc04f', '#8bdc6a', '#62b346'];
const STRAY_BONE = ['#bac7ca', '#a6b4b7', '#ccd8da', '#97a6a9'];
const CAVE_SPIDER = ['#123c46', '#0c2f37', '#19505c', '#0a262d'];
const WITCH_SKIN = ['#9aa86e', '#8d9b63', '#a7b57b'];
const ROBE = ['#3b2a52', '#33244a', '#45325e'];
const HAT = ['#2b1f2f', '#352638', '#231a26'];
const COAT = ['#d8d8d8', '#cdcdcd', '#e3e3e3', '#c4c4c4'];
const MANE = ['#3a2a1e', '#2e2117', '#46342a'];

/** Horse coats (white, creamy, chestnut, brown, black, gray, dark brown), as the `coat` tint. */
export const HORSE_COATS = [0xe8e4dc, 0xc9a77a, 0x9a5a2c, 0x6e4426, 0x2e2622, 0x7a746e, 0x4a3020];

/** Witch loot: three rolls of 0-2 from Minecraft's witch table (glass bottles left out). */
const WITCH_LOOT = ['glowstone_dust', 'gunpowder', 'redstone', 'spider_eye', 'sugar', 'stick'];

const EXTRA: Record<ExtraKind, MobType> = {
  wolf: {
    kind: 'wolf', name: 'Wolf', health: 8, width: 0.6, height: 0.85, walkSpeed: 1.5, runSpeed: 3.4, hostile: false, attack: 4,
    parts: [
      {
        anim: 'none', pivot: [0, 0, 0], boxes: [
          { from: [-3, 8, -4], to: [3, 14, 6], colors: WOLF },
          // Mane (upper body), a little larger than the body.
          { from: [-4, 8, -6.5], to: [4, 15, 0], colors: WOLF_DARK },
        ],
      },
      {
        anim: 'head', pivot: [0, 12.5, -6.5], boxes: [
          { from: [-3, 9.5, -10.5], to: [3, 15.5, -6.5], colors: WOLF, face: eyes('#ffffff', '#1b1b1b', 2) },
          { from: [-1.5, 9.5, -13.5], to: [1.5, 12.5, -10.5], colors: ['#cfc9c1', '#bfb9b0'], face: (px) => { px(1, 0, '#1b1b1b'); } },
          { from: [-3, 15.5, -8.5], to: [-1, 17.5, -7.5], colors: WOLF_DARK },
          { from: [1, 15.5, -8.5], to: [3, 17.5, -7.5], colors: WOLF_DARK },
        ],
      },
      // Collar, only on tamed wolves; the colour comes from `variant` (red by default).
      { anim: 'none', pivot: [0, 0, 0], tint: 'dye', only: 'tamed', boxes: [{ from: [-3.6, 9.5, -7.2], to: [3.6, 15.6, -6.1], colors: ['#f0f0f0', '#e2e2e2'] }] },
      { anim: 'tail', pivot: [0, 13, 6], rest: [-0.7, 0, 0], boxes: [{ from: [-1, 5, 5.5], to: [1, 13, 7.5], colors: WOLF }] },
      ...quadLegs(2, 8, 1, -4, 3.5, WOLF),
    ],
    drops: () => [],
  },
  enderman: {
    kind: 'enderman', name: 'Enderman', health: 40, width: 0.6, height: 2.9, walkSpeed: 1.5, runSpeed: 3.5, hostile: true, attack: 7,
    parts: [
      {
        anim: 'head', pivot: [0, 38, 0], boxes: [{ from: [-4, 38, -4], to: [4, 46, 4], colors: ENDER, face: (px) => {
          for (const x of [0, 1, 2, 5, 6, 7]) px(x, 4, x === 1 || x === 6 ? '#cc00fa' : '#e079fa');
        } }],
      },
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 28, -2], to: [4, 38, 2], colors: ENDER }] },
      { anim: 'armL', pivot: [-5, 37, 0], boxes: [{ from: [-6, 9, -1], to: [-4, 38, 1], colors: ENDER }] },
      { anim: 'armR', pivot: [5, 37, 0], boxes: [{ from: [4, 9, -1], to: [6, 38, 1], colors: ENDER }] },
      { anim: 'legA', pivot: [-2, 28, 0], boxes: [{ from: [-3, 0, -1], to: [-1, 28, 1], colors: ENDER }] },
      { anim: 'legB', pivot: [2, 28, 0], boxes: [{ from: [1, 0, -1], to: [3, 28, 1], colors: ENDER }] },
    ],
    drops: () => named('ender_pearl', 0, 1),
  },
  slime: {
    kind: 'slime', name: 'Slime', health: 16, width: 0.52, height: 0.52, walkSpeed: 2.6, runSpeed: 2.6, hostile: true, attack: 0,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4, 0, -4], to: [4, 8, 4], colors: SLIME, face: (px) => {
        for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3], [5, 2], [6, 2], [5, 3], [6, 3]]) px(x, y, '#2a5a20');
        px(4, 6, '#2a5a20');
      } }] },
    ],
    // Only the smallest slimes drop slimeballs (Minecraft).
    drops: (_byPlayer: boolean, mob?: { size: number }) => ((mob?.size ?? 1) <= 1 ? named('slime_ball', 0, 2) : []),
  },
  drowned: zombieLike('drowned', 'Drowned', ['#5f9d93', '#4f8d83', '#6fada3', '#467e75'], ['#3f6f63', '#36614f', '#4a7c6f'],
    ['#3a5a6a', '#33505e', '#446676'], '#2d4f4a', {
      // Gold ingot as a rare player-kill drop (Java 1.21 drops copper; onzeker which applies here).
      drops: (byPlayer: boolean) => [...stack(ITEM.ROTTEN_FLESH, rnd(0, 2)), ...(byPlayer && Math.random() < 0.11 ? stack(ITEM.GOLD_INGOT, 1) : [])],
    }),
  husk: zombieLike('husk', 'Husk', ['#a89260', '#9a8454', '#b49e6c', '#8d7a4c'], ['#6e5a3a', '#625032', '#7a6644'],
    ['#4a3f2c', '#40362a', '#554834'], '#5a4a2a', {}),
  stray: {
    ...MOB_TYPES.skeleton, kind: 'stray', name: 'Stray',
    parts: [
      ...MOB_TYPES.skeleton.parts.map((p) => ({ ...p, boxes: p.boxes.map((b) => ({ ...b, colors: b.colors === BONE ? STRAY_BONE : b.colors })) })),
      // Tattered cloak over the body.
      { anim: 'none', pivot: [0, 0, 0], boxes: [{ from: [-4.5, 11, -2.5], to: [4.5, 24.5, 2.5], colors: ['#5d6e74', '#52626a', '#68797f', '#46555b'] }] },
    ],
  },
  cave_spider: {
    ...MOB_TYPES.spider, kind: 'cave_spider', name: 'Cave Spider', health: 12, width: 0.7, height: 0.5, scale: 0.7, poison: 140,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], boxes: [
        { from: [-5, 4, 3], to: [5, 12, 15], colors: CAVE_SPIDER, patches: '#2a6a75' },
        { from: [-3, 6, -3], to: [3, 12, 3], colors: CAVE_SPIDER },
      ] },
      { anim: 'head', pivot: [0, 9, -3], boxes: [{ from: [-4, 5, -11], to: [4, 13, -3], colors: CAVE_SPIDER, face: (px) => {
        for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3], [5, 2], [6, 2], [5, 3], [6, 3]]) px(x, y, '#d01818');
        for (const [x, y] of [[3, 1], [4, 1], [0, 4], [7, 4], [3, 4], [4, 4]]) px(x, y, '#901010');
      } }] },
      ...spiderLegs(CAVE_SPIDER),
    ],
  },
  witch: {
    kind: 'witch', name: 'Witch', health: 26, width: 0.6, height: 1.95, walkSpeed: 1.0, runSpeed: 1.3, hostile: true, attack: 0,
    parts: [
      {
        anim: 'head', pivot: [0, 24, 0], boxes: [
          { from: [-4, 24, -4], to: [4, 34, 4], colors: WITCH_SKIN, face: (px, w) => {
            for (let x = 1; x < w - 1; x++) px(x, 4, '#3a2a1e');
            px(1, 5, '#ffffff'); px(2, 5, '#2f7a2f'); px(w - 3, 5, '#2f7a2f'); px(w - 2, 5, '#ffffff');
          } },
          { from: [-1, 25, -6], to: [1, 29, -4], colors: WITCH_SKIN, face: (px) => { px(1, 2, '#3f7a2a'); } },
          { from: [-5, 33, -5], to: [5, 34.5, 5], colors: HAT },
          { from: [-3.5, 34.5, -3.5], to: [3.5, 38, 3.5], colors: HAT },
          { from: [-2, 38, -2], to: [2, 41, 2], colors: HAT },
          { from: [-0.75, 41, -0.75], to: [0.75, 43, 0.75], colors: HAT },
        ],
      },
      { anim: 'none', pivot: [0, 0, 0], boxes: [
        { from: [-4, 12, -3], to: [4, 24, 3], colors: ROBE },
        // Folded arms in front of the chest, hands in the middle.
        { from: [-8, 15, -5], to: [8, 19, -2], colors: ROBE },
        { from: [-2, 15, -5.3], to: [2, 19, -2], colors: WITCH_SKIN },
      ] },
      { anim: 'legA', pivot: [-2, 12, 0], boxes: [{ from: [-4, 0, -2], to: [0, 12, 2], colors: ROBE }] },
      { anim: 'legB', pivot: [2, 12, 0], boxes: [{ from: [0, 0, -2], to: [4, 12, 2], colors: ROBE }] },
    ],
    drops: () => {
      const out: ItemStack[] = [];
      for (let i = 0; i < 3; i++) out.push(...named(WITCH_LOOT[Math.floor(Math.random() * WITCH_LOOT.length)], 0, 2));
      return out;
    },
  },
  horse: {
    kind: 'horse', name: 'Horse', flees: true, health: 22, width: 1.4, height: 1.6, walkSpeed: 1.6, runSpeed: 3.2, hostile: false, attack: 0,
    parts: [
      { anim: 'none', pivot: [0, 0, 0], tint: 'coat', boxes: [{ from: [-5, 12, -11], to: [5, 22, 11], colors: COAT }] },
      {
        anim: 'head', pivot: [0, 19, -9], rest: [-0.5, 0, 0], tint: 'coat', boxes: [
          { from: [-2.5, 17, -12], to: [2.5, 30, -6.5], colors: COAT },
          { from: [-2.5, 25, -21], to: [2.5, 30.5, -9], colors: COAT, face: (px, w) => { px(1, 3, '#2a2a2a'); px(w - 2, 3, '#2a2a2a'); } },
          { from: [-2.5, 30.5, -9], to: [-1, 32.5, -8], colors: COAT },
          { from: [1, 30.5, -9], to: [2.5, 32.5, -8], colors: COAT },
        ],
      },
      // Mane along the back of the neck (dark, not tinted).
      { anim: 'head', pivot: [0, 19, -9], rest: [-0.5, 0, 0], boxes: [{ from: [-1, 18, -6.6], to: [1, 31, -5], colors: MANE }] },
      { anim: 'tail', pivot: [0, 21, 11], rest: [-0.5, 0, 0], boxes: [{ from: [-1.5, 9, 10.5], to: [1.5, 21, 13.5], colors: MANE }] },
      { anim: 'none', pivot: [0, 0, 0], only: 'saddled', boxes: [
        { from: [-5.5, 21.5, -4], to: [5.5, 23, 5], colors: ['#7a4a22', '#6a3e1a', '#8a5428'] },
        { from: [-5.6, 15, -0.5], to: [5.6, 21.5, 0.5], colors: ['#3a2a1a'] },
      ] },
      ...quadLegs(4, 12, 1, -10, 6.5, COAT).map((p) => ({ ...p, tint: 'coat' as const })),
    ],
    drops: () => named('leather', 0, 2),
  },
};

for (const k of Object.keys(EXTRA) as ExtraKind[]) MOB_TYPES[k] = EXTRA[k];
