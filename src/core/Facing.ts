export type Facing = 'north' | 'east' | 'south' | 'west';

/**
 * Compass direction the camera looks at. The camera's forward vector for a yaw is (−sin yaw, −cos yaw) in x/z
 * (Camera.ts: rotation 'YXZ', three.js looks down −Z), and Minecraft's compass has north = −Z, east = +X.
 */
export function facingFromCameraYaw(yaw: number): Facing {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}
