import type * as THREE from 'three';

const ranges = new WeakMap<THREE.BufferAttribute, { start: number; count: number }>();

/**
 * Marks the first `count` values of a dynamic attribute for upload. Same effect as `clearUpdateRanges()` +
 * `addUpdateRange(0, count)` + `needsUpdate = true`, but reuses one range object per attribute: three's
 * `addUpdateRange` allocates a new `{ start, count }` every call, which was a steady source of per-frame garbage
 * (particles, tracers, instanced mobs). three clears the list after uploading, so the object is pushed again each time.
 */
export function uploadPrefix(attr: THREE.BufferAttribute, count: number): void {
  let r = ranges.get(attr);
  if (!r) {
    r = { start: 0, count: 0 };
    ranges.set(attr, r);
  }
  r.start = 0;
  r.count = count;
  const list = attr.updateRanges;
  list.length = 0;
  list.push(r);
  attr.needsUpdate = true;
}
