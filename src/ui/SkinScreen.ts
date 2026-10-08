import { currentProfile, profileToken, refreshProfile } from '../net/ProfileApi';
import {
  currentSkinPixels, previewPixels, removeSkin, skinErrorText, skinsSupported, uploadSkin,
} from '../net/SkinApi';
import { SKIN_MAX_BYTES } from '../skins/SkinFormat';
import { button, h, menuScreen } from './dom';
import { t } from './i18n';
import type { ScreenStack } from './Screens';
import { SkinPreview, defaultSkinPixels } from './SkinPreview';

/**
 * The skin screen (Realms profile and Build & Survival): a rotating preview, a file picker and the buttons to use or
 * remove the skin. The file is checked here first (type, size, dimensions) and shown exactly as other players will
 * see it (legacy and slim skins converted); the server then validates and re-encodes it again.
 */
export function showSkinScreen(stack: ScreenStack): void {
  const preview = new SkinPreview(6);
  const caption = h('div', { class: 'prog-muted skin-caption', text: t('skin.default') });
  const status = h('div', { class: 'hint skin-status', role: 'status' });
  const input = h('input', { type: 'file', accept: 'image/png,.png', style: 'display:none' });
  let pending: Uint8Array | null = null;
  let supported = true;

  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('bad', error);
  };
  const use = button(t('skin.use'), () => void save(), { cls: 'w150 primary' });
  const remove = button(t('skin.remove'), () => void clear(), { cls: 'w150' });
  const choose = button(t('skin.choose'), () => input.click(), { cls: 'w150' });

  const sync = () => {
    use.disabled = !supported || !pending;
    remove.disabled = !supported || (!currentProfile()?.skin && !pending);
    choose.disabled = !supported;
  };

  /** Shows the skin the profile has now (or the default one). */
  const showCurrent = async () => {
    pending = null;
    const px = await currentSkinPixels();
    preview.setPixels(px ?? defaultSkinPixels());
    caption.textContent = px ? t('skin.yours') : t('skin.default');
    sync();
  };

  async function save(): Promise<void> {
    if (!pending) return;
    use.disabled = true;
    say(t('skin.busy'));
    const res = await uploadSkin(pending);
    if (res.ok) {
      say(t('skin.saved'));
      await showCurrent();
    } else {
      say(skinErrorText(res.code), true);
      sync();
    }
  }

  async function clear(): Promise<void> {
    remove.disabled = true;
    const res = await removeSkin();
    if (res.ok) {
      say(t('skin.removed'));
      await showCurrent();
    } else {
      say(skinErrorText(res.code), true);
      sync();
    }
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void (async () => {
      if (file.size > SKIN_MAX_BYTES) { say(skinErrorText('too-large'), true); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await previewPixels(bytes);
      if (!res.ok) { say(skinErrorText(res.code), true); return; }
      pending = bytes;
      preview.setPixels(res.rgba);
      caption.textContent = t('skin.pending');
      say('');
      sync();
    })();
  });

  const panel = h('div', { class: 'prog-panel skin-panel', style: 'align-items: center;' },
    preview.el, caption,
    h('div', { class: 'hint', text: t('skin.hint') }),
    h('div', { class: 'row' }, choose, use),
    remove, status, input,
  );
  const back = button(t('common.back'), () => { preview.stop(); stack.pop(); }, { cls: 'w150' });
  stack.push(menuScreen(t('skin.title'), [panel], [back], { list: true, cls: 'bc' }));
  preview.start();
  sync();

  void (async () => {
    supported = await skinsSupported();
    if (!supported) { say(t('skin.unavailable'), true); sync(); return; }
    if (profileToken() && !currentProfile()) await refreshProfile();
    await showCurrent();
  })();
}
