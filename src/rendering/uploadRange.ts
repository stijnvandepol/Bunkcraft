import type * as THREE from 'three';

const ranges = new WeakMap<THREE.BufferAttribute, { start: number; count: number }>();
const keep = (): void => {};

/**
 * Marks the first `count` values of a dynamic attribute for upload: the effect of `clearUpdateRanges()` +
 * `addUpdateRange(0, count)` + `needsUpdate = true`, without the garbage. three allocates a `{ start, count }` per
 * `addUpdateRange` and empties the list after every upload (`length = 0` drops the array's backing store, so the next
 * push allocates a new one), which made instanced mobs, particles and tracers a steady source of per-frame garbage.
 *
 * Here the attribute keeps one range object in its list for good: its `clearUpdateRanges` is replaced by a no-op on
 * that instance, and only the count changes. Attributes passed here must only be uploaded through this function.
 * A count of 0 uploads everything (WebGL reads length 0 as "to the end"): harmless, callers skip empty frames anyway.
 */
export function uploadPrefix(attr: THREE.BufferAttribute, count: number): void {
  let r = ranges.get(attr);
  if (!r) {
    r = { start: 0, count: 0 };
    ranges.set(attr, r);
    attr.updateRanges.length = 0;
    attr.updateRanges.push(r);
    attr.clearUpdateRanges = keep;
  }
  r.count = count;
  attr.needsUpdate = true;
}
