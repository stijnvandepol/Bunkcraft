import { BLOCK } from '../world/BlockRegistry';
import { pointInLiquid } from '../world/Liquids';
import { type AABB, type BlockGetter, boxIntersectsSolid, clipAxis } from './Collision';
import { AIR_STEER, JUMP_PAD_VELOCITY, POSE, SLIDE, padBelow } from './ArcadeMove';
import { PHYSICS, approach } from './Physics';

/** Ledges up to this high are walked up without jumping (Minecraft's step height). */
const STEP_HEIGHT = 0.6;

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1 (right positive)
  jump: boolean;
  jumpPressed: boolean;
  sprint: boolean;
  descend: boolean;
  /** Arcade: the crouch/slide key is held (optional: Minecraft movement ignores it). */
  crouch?: boolean;
  /** Arcade: the crouch/slide key went down since the last step. */
  crouchPressed?: boolean;
}

/**
 * First-person player: an AABB (0.6 × 1.8 × 0.6) moved with a fixed 60 Hz step.
 * Rendering interpolates between the previous and current step for smooth motion
 * on any refresh rate.
 */
export class Player {
  x = 0; y = 80; z = 0;
  prevX = 0; prevY = 80; prevZ = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0;
  pitch = 0;
  onGround = false;
  inWater = false;
  /** Depth Strider of the worn boots as 0..1 (see EnchantRules.depthStriderFactor). */
  depthStrider = 0;
  headInWater = false;
  flying = false;
  sprinting = false;
  /** Sneaking on the ground or in the air (slow walk, no sprint); not while flying or swimming. */
  sneaking = false;
  horizontalCollision = false;
  /** Distance walked on the ground, drives head bob and footsteps. */
  walkDistance = 0;
  /** Downward speed at the moment of the last landing (for landing sounds/bob). */
  landingImpact = 0;
  inLava = false;
  /** Blocks fallen since last on the ground (fall damage = distance − 3). */
  fallDistance = 0;
  /** Fall distance of the most recent landing, consumed by the game (fall damage). */
  landedFall = 0;
  /** Mode rules, set by the game. */
  canFly = true;
  canSprint = true;
  /** Arcade: scales walking and sprinting speed on the ground and in the air (1 = Minecraft). */
  speedMultiplier = 1;
  /** Jump Boost levels (+0.1 blocks/tick of jump speed each) and Levitation levels (rise 0.9 blocks/s each). */
  jumpBoost = 0;
  levitation = 0;
  /** Horizontal acceleration in the air (arcade raises it for bunny hopping). */
  airAccel: number = PHYSICS.AIR_ACCEL;
  /** Spectator: fly through blocks. */
  noclip = false;
  /** Distance travelled while sprinting / swimming and jumps since last read (hunger). */
  sprintDistance = 0;
  swimDistance = 0;
  jumps = 0;

  // ---- Arcade movement (see ArcadeMove.ts); all of it is inert while `arcadeMove` is false.
  /** Slide, slide-hop, momentum, air strafe, crouch and jump pads. Off = Minecraft movement, unchanged. */
  arcadeMove = false;
  /** Crouched on the ground (slower, lower eye and hitbox), not sliding. */
  crouching = false;
  sliding = false;
  /** Ground seconds of the current slide, seconds until the next slide may start, the slide cooldown. */
  slideTime = 0;
  slideReady = 0;
  slideCooldown: number = SLIDE.COOLDOWN;
  /** Slides started (a counter the game watches for sound, FOV kick and the `sl` field of `pos`). */
  slideStarts = 0;
  /** A crouch press waiting for the ground (press in the air, land in a slide). */
  private slideArmed = false;
  /** Jump pad launches (a counter for the launch sound). */
  padLaunches = 0;
  /** Eye height above the feet (follows the pose), and its value one step ago (interpolation). */
  eye: number = PHYSICS.EYE_HEIGHT;
  prevEye: number = PHYSICS.EYE_HEIGHT;

  private time = 0;
  private lastJumpPress = -1;
  private readonly box: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  setPosition(x: number, y: number, z: number): void {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
    this.vx = this.vy = this.vz = 0;
    // The slide cooldown keeps running (a rubber band must not hand out an early slide the server would refuse).
    this.sliding = this.crouching = this.slideArmed = false;
    this.slideTime = 0;
    this.eye = this.prevEye = PHYSICS.EYE_HEIGHT;
  }

  get eyeY(): number {
    return this.y + this.eye;
  }

  private updateBox(): AABB {
    const b = this.box, hw = PHYSICS.WIDTH / 2;
    b.minX = this.x - hw; b.maxX = this.x + hw;
    b.minY = this.y; b.maxY = this.y + PHYSICS.HEIGHT;
    b.minZ = this.z - hw; b.maxZ = this.z + hw;
    return b;
  }

  /** Would a block at (x,y,z) intersect the player? Used before placing blocks. */
  intersectsBlock(x: number, y: number, z: number): boolean {
    const b = this.updateBox();
    return b.maxX > x && b.minX < x + 1 && b.maxY > y && b.minY < y + 1 && b.maxZ > z && b.minZ < z + 1;
  }

  /** @param getMeta block states, so slabs, stairs and doors collide with their real shape (full blocks without). */
  step(input: MoveInput, getBlock: BlockGetter, getMeta?: BlockGetter): void {
    const dt = PHYSICS.STEP;
    this.time += dt;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;

    this.inWater = getBlock(Math.floor(this.x), Math.floor(this.y + 0.4), Math.floor(this.z)) === BLOCK.WATER;
    this.headInWater = pointInLiquid(getBlock, getMeta, BLOCK.WATER, this.x, this.eyeY, this.z);
    this.inLava = getBlock(Math.floor(this.x), Math.floor(this.y + 0.4), Math.floor(this.z)) === BLOCK.LAVA;
    if (this.inLava) this.inWater = true; // lava swims like (slow) water
    if (this.noclip) this.flying = true;
    else if (!this.canFly) this.flying = false;

    // Double-tap jump toggles flight (creative style).
    if (input.jumpPressed && this.canFly && !this.noclip) {
      if (this.time - this.lastJumpPress < 0.3) {
        this.flying = !this.flying;
        this.lastJumpPress = -1;
        if (this.flying) this.vy = 0;
      } else {
        this.lastJumpPress = this.time;
      }
    }

    // Desired horizontal velocity in world space.
    let f = input.forward, s = input.strafe;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    this.sneaking = input.descend && !this.flying && !this.inWater && !this.noclip;
    this.sprinting = input.sprint && f > 0 && !this.inWater && this.canSprint && !this.sneaking;
    let speed: number;
    if (this.flying) speed = this.sprinting ? PHYSICS.FLY_SPRINT_SPEED : PHYSICS.FLY_SPEED;
    // Depth Strider (boots) brings the water speed up towards the walking speed, a third per level.
    else if (this.inWater) speed = this.inLava ? PHYSICS.SWIM_SPEED * 0.5 : PHYSICS.SWIM_SPEED + (PHYSICS.WALK_SPEED - PHYSICS.SWIM_SPEED) * this.depthStrider;
    else speed = (this.sprinting ? PHYSICS.SPRINT_SPEED : PHYSICS.WALK_SPEED) * this.speedMultiplier * (this.sneaking ? PHYSICS.SNEAK_FACTOR : 1);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const tx = (-sin * f + cos * s) * speed;
    const tz = (-cos * f - sin * s) * speed;
    // Arcade on foot: slide, momentum and jump pads (a jump this step is handled there too).
    const arcade = this.arcadeMove && !this.flying && !this.inWater && !this.noclip;
    let jumped = false;
    if (arcade) jumped = this.arcadeHorizontal(input, f, s, sin, cos, getBlock, dt);
    else {
      if (this.arcadeMove) { this.sliding = this.crouching = false; }
      const accel = this.flying ? PHYSICS.FLY_ACCEL : this.inWater ? 10 : this.onGround ? PHYSICS.GROUND_ACCEL : this.airAccel;
      this.vx = approach(this.vx, tx, accel, dt);
      this.vz = approach(this.vz, tz, accel, dt);
    }
    if (this.arcadeMove) {
      this.prevEye = this.eye;
      const target = this.sliding ? POSE.SLIDE_EYE : this.crouching ? POSE.CROUCH_EYE : PHYSICS.EYE_HEIGHT;
      this.eye = approach(this.eye, target, POSE.EYE_RATE, dt);
    }

    // Ladders: climb while holding jump or pushing into the wall, hold still while sneaking, otherwise slide down.
    const onLadder = !this.flying && !this.inWater && !this.noclip
      && (getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z)) === BLOCK.LADDER
        || getBlock(Math.floor(this.x), Math.floor(this.y + 1), Math.floor(this.z)) === BLOCK.LADDER);
    // Vertical.
    if (onLadder) {
      this.vy = input.jump || this.horizontalCollision ? 3.5 : input.descend ? 0 : -3;
      this.fallDistance = 0;
    } else if (this.flying) {
      const target = ((input.jump ? 1 : 0) - (input.descend ? 1 : 0)) * PHYSICS.FLY_VERTICAL;
      this.vy = approach(this.vy, target, 10, dt);
    } else if (this.inWater) {
      this.vy -= PHYSICS.WATER_GRAVITY * dt;
      if (input.jump) this.vy = approach(this.vy, PHYSICS.SWIM_UP, 8, dt);
      if (this.vy < -PHYSICS.WATER_SINK) this.vy = approach(this.vy, -PHYSICS.WATER_SINK, 10, dt);
      // Climb out onto the shore.
      if (input.jump && this.horizontalCollision) this.vy = Math.max(this.vy, 5.5);
    } else {
      if (arcade) {
        if (jumped) this.jumps++;
      } else if (input.jump && this.onGround) {
        this.vy = PHYSICS.JUMP_VELOCITY + this.jumpBoost * 2.1;
        this.jumps++;
      }
      if (this.levitation > 0) {
        this.vy = approach(this.vy, 0.9 * this.levitation, 5, dt);
        this.fallDistance = 0;
      } else this.vy = Math.max(this.vy - PHYSICS.GRAVITY * dt, -PHYSICS.TERMINAL_VELOCITY);
    }

    if (this.noclip) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.z += this.vz * dt;
      this.onGround = false;
      this.fallDistance = 0;
      return;
    }

    // Collide per axis: Y first, then X and Z.
    const box = this.updateBox();
    const wantY = this.vy * dt;
    const dy = clipAxis(box, 1, wantY, getBlock, getMeta);
    this.y += dy;
    const wasOnGround = this.onGround;
    this.onGround = wantY < 0 && dy > wantY + 1e-6;
    if (dy !== wantY) {
      if (this.onGround && !wasOnGround) this.landingImpact = -this.vy;
      this.vy = 0;
    }

    this.updateBox();
    const startX = this.x, startZ = this.z;
    const wantX = this.vx * dt;
    let dx = clipAxis(this.box, 0, wantX, getBlock, getMeta);
    this.x += dx;
    this.updateBox();
    const wantZ = this.vz * dt;
    let dz = clipAxis(this.box, 2, wantZ, getBlock, getMeta);
    this.z += dz;
    this.horizontalCollision = dx !== wantX || dz !== wantZ;
    if (this.horizontalCollision && (wasOnGround || this.onGround) && !this.inWater && !this.flying
      && this.stepUp(startX, startZ, wantX, wantZ, dx, dz, getBlock, getMeta)) {
      // Climbed a slab or stair: the distance covered is the stepped one.
      dx = this.x - startX;
      dz = this.z - startZ;
      this.horizontalCollision = false;
      this.onGround = true;
    }
    if (dx !== wantX) this.vx = 0;
    if (dz !== wantZ) this.vz = 0;

    if (this.flying && this.onGround) this.flying = false;
    if (this.onGround) this.walkDistance += Math.hypot(dx, dz);
    const moved = Math.hypot(dx, dz);
    if (this.sprinting) this.sprintDistance += moved;
    if (this.inWater) this.swimDistance += moved;

    // Fall distance (reset in liquids and while flying), reported on landing.
    if (this.inWater || this.flying) this.fallDistance = 0;
    else if (dy < 0) this.fallDistance -= dy;
    if (this.onGround) {
      if (this.fallDistance > 0) this.landedFall = this.fallDistance;
      this.fallDistance = 0;
    }
  }

  /**
   * Arcade horizontal movement for one step on foot (see ArcadeMove.ts for the numbers and the speed bound
   * the server relies on). Sets vx/vz, and vy for a jump or a jump pad launch; returns whether the player
   * jumped. Every branch either approaches a target no faster than the run speed `run` (a contraction) or
   * lets the speed above `run` decay at least at SLIDE.AIR_DRAG; only a slide start adds speed.
   */
  private arcadeHorizontal(
    input: MoveInput, f: number, s: number, sin: number, cos: number, getBlock: BlockGetter, dt: number,
  ): boolean {
    const run = PHYSICS.SPRINT_SPEED * this.speedMultiplier;
    const crouch = input.crouch === true;
    if (input.crouchPressed) this.slideArmed = true;
    if (!crouch) this.slideArmed = false;
    this.slideReady = Math.max(0, this.slideReady - dt);
    let speed = Math.hypot(this.vx, this.vz);
    // Wish direction (unit, or zero without input).
    let wx = -sin * f + cos * s, wz = -cos * f - sin * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-6) { wx /= wl; wz /= wl; } else { wx = wz = 0; }

    // Take-off: a jump pad under the feet, or a jump. Both keep the horizontal speed (no ground friction this step).
    let jumped = false, airborne = !this.onGround;
    if (this.onGround && padBelow(getBlock, this.x, this.y, this.z)) {
      this.vy = JUMP_PAD_VELOCITY;
      this.padLaunches++;
      this.sliding = false;
      airborne = true;
    } else if (this.onGround && input.jump) {
      this.vy = PHYSICS.JUMP_VELOCITY + this.jumpBoost * 2.1;
      jumped = airborne = true;
    }

    // Slide start: on the ground with an armed crouch press, fast enough, cooldown over.
    if (!airborne && !this.sliding && this.slideArmed && this.slideReady <= 0 && speed >= SLIDE.MIN_SPEED * run) {
      const peak = Math.max(speed, run * (1 + SLIDE.BOOST));
      this.vx *= peak / speed; this.vz *= peak / speed;
      speed = peak;
      this.sliding = true;
      this.slideArmed = false;
      this.slideTime = 0;
      this.slideReady = this.slideCooldown;
      this.slideStarts++;
    }
    // A slide ends when the key is let go, when it has run its time, when it has lost its boost, or with a jump (slide-hop).
    if (this.sliding && (!crouch || jumped || this.slideTime >= SLIDE.MAX_TIME || speed - run < SLIDE.END_EXCESS * run)) this.sliding = false;

    if (this.sliding) {
      // Curve slide: the direction turns slowly towards the input; the boost decays (less in the air: stairs down).
      if (!airborne) this.slideTime += dt;
      this.momentum(speed, run, wx, wz, SLIDE.STEER, airborne ? SLIDE.AIR_DRAG : SLIDE.FRICTION, dt);
    } else if (airborne && speed > run + 1e-6 && wx * this.vx + wz * this.vz >= -0.2 * speed) {
      // Momentum in the air (slide-hop, bunny hop): kept, slowly fading, steered by strafe + mouse (air strafe).
      this.momentum(speed, run, wx, wz, AIR_STEER, SLIDE.AIR_DRAG, dt);
    } else {
      const target = run * (this.crouching && !airborne ? POSE.CROUCH_SPEED : 1) * (f > 0 ? 1 : PHYSICS.WALK_SPEED / PHYSICS.SPRINT_SPEED);
      const tx = wx * target * Math.min(1, wl), tz = wz * target * Math.min(1, wl);
      const accel = airborne ? this.airAccel : PHYSICS.GROUND_ACCEL;
      this.vx = approach(this.vx, tx, accel, dt);
      this.vz = approach(this.vz, tz, accel, dt);
    }
    this.crouching = crouch && !this.sliding && !airborne;
    return jumped;
  }

  /** Speed above `run` decays at `drag`; the direction turns towards (wx, wz) at `steer` (unit wish, or zero). */
  private momentum(speed: number, run: number, wx: number, wz: number, steer: number, drag: number, dt: number): void {
    const mag = run + Math.max(0, speed - run) * Math.exp(-drag * dt);
    let dx = this.vx / speed, dz = this.vz / speed;
    if (wx !== 0 || wz !== 0) {
      const k = 1 - Math.exp(-steer * dt);
      dx += (wx - dx) * k; dz += (wz - dz) * k;
      const l = Math.hypot(dx, dz);
      if (l > 1e-6) { dx /= l; dz /= l; } else { dx = this.vx / speed; dz = this.vz / speed; }
    }
    this.vx = dx * mag; this.vz = dz * mag;
  }

  /**
   * Minecraft's step height: when walking into a ledge of at most 0.6 blocks (slab, stair), tries the same
   * move from 0.6 higher and drops back down. Keeps the result when it gets further than the flat move.
   */
  private stepUp(
    startX: number, startZ: number, wantX: number, wantZ: number, dx: number, dz: number, getBlock: BlockGetter, getMeta?: BlockGetter,
  ): boolean {
    const hw = PHYSICS.WIDTH / 2;
    const b = this.box;
    b.minX = startX - hw; b.maxX = startX + hw;
    b.minZ = startZ - hw; b.maxZ = startZ + hw;
    b.minY = this.y; b.maxY = this.y + PHYSICS.HEIGHT;
    const up = clipAxis(b, 1, STEP_HEIGHT, getBlock, getMeta);
    if (up <= 0) { this.updateBox(); return false; }
    b.minY += up; b.maxY += up;
    const sdx = clipAxis(b, 0, wantX, getBlock, getMeta);
    b.minX += sdx; b.maxX += sdx;
    const sdz = clipAxis(b, 2, wantZ, getBlock, getMeta);
    b.minZ += sdz; b.maxZ += sdz;
    const down = clipAxis(b, 1, -up, getBlock, getMeta);
    // Only a step if we land on something and got further than before.
    if (down <= -up + 1e-6 || sdx * sdx + sdz * sdz <= dx * dx + dz * dz + 1e-9) { this.updateBox(); return false; }
    this.x = startX + sdx;
    this.z = startZ + sdz;
    this.y += up + down;
    this.updateBox();
    return true;
  }

  /** Pushes the player up if they end up inside a block (e.g. spawn in a tree). */
  unstick(getBlock: BlockGetter, getMeta?: BlockGetter): void {
    for (let i = 0; i < 64 && boxIntersectsSolid(this.updateBox(), getBlock, getMeta); i++) this.y += 1;
    this.prevY = this.y;
  }
}
