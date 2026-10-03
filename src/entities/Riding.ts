import type { MoveInput, Player } from '../player/Player';
import type { Mob, MobTarget } from './Mob';

/** Height of the saddle above a horse's feet (blocks), where the rider's feet go. */
export const SEAT_HEIGHT = 0.85;

/**
 * Minimal mount system (singleplayer): while riding, the player's physics step is replaced by this one. The horse
 * gets the movement keys and the view yaw as input (its goal moves it at 20 Hz); the player sits on it, interpolated
 * between horse ticks so the camera stays smooth at 60 Hz. Sneak dismounts. Returns false once the ride is over.
 *
 * @param frac how far the current 60 Hz step is into the horse's 20 Hz tick (0..1)
 */
export function rideStep(p: Player, horse: Mob, move: MoveInput, frac: number): boolean {
  if (horse.dead || horse.removed || horse.rider === null || move.descend) {
    dismount(p, horse);
    return false;
  }
  horse.rideForward = move.forward;
  horse.rideStrafe = move.strafe;
  horse.rideYaw = p.yaw;
  horse.rideJump = move.jump;
  p.prevX = p.x; p.prevY = p.y; p.prevZ = p.z;
  p.x = horse.prevX + (horse.x - horse.prevX) * frac;
  p.y = horse.prevY + (horse.y - horse.prevY) * frac + SEAT_HEIGHT;
  p.z = horse.prevZ + (horse.z - horse.prevZ) * frac;
  p.vx = p.vy = p.vz = 0;
  p.fallDistance = 0;
  p.onGround = true;
  return true;
}

/** Gets on: the horse remembers its rider (used by its ridden goal and the taming roll). */
export function mount(p: Player, horse: Mob, rider: MobTarget): void {
  horse.rider = rider;
  horse.nav.stop();
  p.setPosition(horse.x, horse.y + SEAT_HEIGHT, horse.z);
}

/** Gets off to the side of the horse. */
export function dismount(p: Player, horse: Mob): void {
  horse.rider = null;
  horse.rideForward = horse.rideStrafe = 0;
  horse.rideJump = false;
  const side = horse.yaw + Math.PI / 2;
  p.setPosition(horse.x - Math.sin(side) * (horse.width / 2 + 0.4), horse.y + 0.2, horse.z - Math.cos(side) * (horse.width / 2 + 0.4));
}
