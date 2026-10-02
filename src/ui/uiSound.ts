import type { UiSoundName } from '../core/audio/synth';

/**
 * Interface sounds through event delegation: one listener on the root plays `playUi(name)` for clicks on
 * buttons and inventory slots, so individual screens need no audio code. A screen can opt out with
 * `data-ui-sound="none"` or pick a sound with `data-ui-sound="equip"` (or any other {@link UiSoundName}).
 * Call `playUi` directly for events that are not clicks (chat ping, advancement).
 */
export function bindUiSounds(root: HTMLElement | Document, playUi: (name: UiSoundName) => void): () => void {
  const onDown = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target || !target.closest) return;
    const tagged = target.closest('[data-ui-sound]');
    if (tagged) {
      const v = tagged.getAttribute('data-ui-sound');
      if (v && v !== 'none') playUi(v as UiSoundName);
      return;
    }
    if (target.closest('button, .mc-btn, .inv-tab, .world-item')) {
      if ((target.closest('button, .mc-btn') as HTMLButtonElement | null)?.disabled) return;
      playUi('click');
    } else if (target.closest('.inv-slot')) playUi('inventoryMove');
  };
  root.addEventListener('pointerdown', onDown, true);
  return () => root.removeEventListener('pointerdown', onDown, true);
}
