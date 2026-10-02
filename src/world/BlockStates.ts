/**
 * Block states: next to the block id (Uint8) every block has a `meta` byte with its variant
 * (slab half, stair facing, open door, liquid level). Meta 0 is always the default state, so
 * generated terrain needs no meta at all. See docs/BLOCKSTATES.md.
 *
 * A "state" is the pair packed into one number: id | meta << 8. Edit maps, the server's
 * world.json and the network all use that packed form.
 */

export function packState(id: number, meta: number): number {
  return id | (meta << 8);
}

export function stateId(state: number): number {
  return state & 255;
}

export function stateMeta(state: number): number {
  return (state >> 8) & 255;
}
