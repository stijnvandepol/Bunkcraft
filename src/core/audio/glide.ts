/**
 * Per-frame parameter smoothing without flooding the audio timeline. The mixer, ambience loops and music re-aim
 * their gains and filters every frame; each `setTargetAtTime` adds an automation event that the browser has to keep
 * and evaluate (Chrome profiles showed it as the single largest audio cost in a match), although the target almost
 * never changes. `glide` only schedules when the target moved by more than `tolerance` since the last call for that
 * parameter.
 */
const lastTarget = new WeakMap<AudioParam, number>();

export function glide(param: AudioParam, target: number, now: number, timeConstant: number, tolerance: number): void {
  const last = lastTarget.get(param);
  // Silence is always reached exactly (a fade out must not stop a hair above zero).
  if (last !== undefined && (target === 0 ? last === 0 : Math.abs(last - target) <= tolerance)) return;
  lastTarget.set(param, target);
  param.setTargetAtTime(target, now, timeConstant);
}

/** Forget the last target (after something else set the parameter directly, e.g. a cancel or a value write). */
export function resetGlide(param: AudioParam): void {
  lastTarget.delete(param);
}
