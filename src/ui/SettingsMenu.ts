import {
  type GraphicsQuality, MAX_FPS_UNLIMITED, MAX_RENDER_DISTANCE, type ParticleLevel, QUALITY_PRESETS,
  type Settings, type SettingsStore, type ShadowQuality, detectPreset,
} from '../core/Settings';
import {
  KEYBINDS, KEYBIND_CATEGORIES, type KeybindMap, conflictingActions, defaultKeybinds, isValidCode, keyDisplayName,
} from '../core/Keybinds';
import { keyboardLockEnabled, keyboardLockSupported, setKeyboardLockEnabled } from '../pwa/KeyboardLock';
import { installButton } from '../pwa/Pwa';
import { button, cycleButton, h, menuScreen, slider } from './dom';
import { LANGUAGES, LANGUAGE_NAMES, type Language, getLanguage, setLanguage, t } from './i18n';

export interface OptionsNav {
  push(el: HTMLElement): void;
  pop(): void;
  openResourcePacks(): void;
  credits(): string[];
  /** The language changed: the game rebuilds the screens below the Options screen. */
  languageChanged?(): void;
  /** Name of the connected controller, if any. */
  padName?(): string;
}

type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/** ON/OFF cycle button for a boolean setting. */
function toggle(store: SettingsStore, label: string, key: BooleanKey, on = 'ON', off = 'OFF'): HTMLButtonElement {
  return cycleButton<'on' | 'off'>(label, ['off', 'on'], { on, off }, store.values[key] ? 'on' : 'off', (v) => store.set(key, (v === 'on') as Settings[typeof key]));
}

const percent = (name: string) => (v: number) => `${name}: ${v}%`;
const holdOrToggle = (store: SettingsStore, label: string, key: BooleanKey) => toggle(store, label, key, 'Toggle', 'Hold');

function fullscreenButton(): HTMLButtonElement {
  const label = () => t('options.fullscreen', document.fullscreenElement ? t('common.on') : t('common.off'));
  const btn = button(label(), () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
    window.setTimeout(() => (btn.textContent = label()), 200);
  });
  return btn;
}

/** Chromium: receive Esc in fullscreen so it pauses the game instead of leaving fullscreen. */
function lockEscButton(): HTMLButtonElement {
  const label = () => t('options.lockEsc', keyboardLockEnabled() ? t('common.on') : t('common.off'));
  const btn = button(label(), () => {
    setKeyboardLockEnabled(!keyboardLockEnabled());
    btn.textContent = label();
  });
  return btn;
}

const fovLabel = (v: number) => t('options.fov', v === 70 ? t('options.fov.normal') : v === 110 ? t('options.fov.quakePro') : v);
const onOff = () => ({ on: t('common.on'), off: t('common.off') });

/** Options hub, structured like Minecraft 1.21's Options screen. */
export function optionsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  const presetIds = [...QUALITY_PRESETS.map((p) => p.id), 'custom'];
  const presetNames = Object.fromEntries([...QUALITY_PRESETS.map((p) => [p.id, p.name]), ['custom', t('options.quality.custom')]]);
  const quality = cycleButton<string>(t('options.quality'), presetIds, presetNames, detectPreset(s)?.id ?? 'custom', (id) => {
    const p = QUALITY_PRESETS.find((q) => q.id === id);
    if (p) store.setMany(p.values);
  });

  return menuScreen(t('options.title'), [
    h('div', { class: 'grid2' },
      slider(30, 110, 1, s.fov, fovLabel, (v) => store.set('fov', v)),
      quality,
      h('div', { class: 'section-label' }),
      button(t('options.video'), () => nav.push(videoSettingsScreen(store, nav))),
      button(t('options.sound'), () => nav.push(soundScreen(store, nav))),
      button(t('options.controls'), () => nav.push(controlsScreen(store, nav))),
      button(t('options.chat'), () => nav.push(chatSettingsScreen(store, nav))),
      button(t('options.language'), () => nav.push(languageScreen(store, nav))),
      button(t('options.resourcePacks'), () => nav.openResourcePacks()),
      button(t('options.touch'), () => nav.push(touchScreen(store, nav))),
      button(t('options.controller'), () => nav.push(controllerScreen(store, nav, nav.padName?.() ?? ''))),
      button(t('options.accessibility'), () => nav.push(accessibilityScreen(store, nav))),
      button(t('options.credits'), () => nav.push(creditsScreen(nav))),
      h('div', { class: 'wide' }, fullscreenButton()),
      keyboardLockSupported() ? lockEscButton() : null,
      installButton(),
    ),
  ], [button(t('common.done'), () => nav.pop())]);
}

/** Max Framerate slider text: 30–250 FPS, the top step is Unlimited (Minecraft's range). */
export function framerateLabel(v: number): string {
  return t('video.maxFps', v >= MAX_FPS_UNLIMITED ? t('video.maxFps.unlimited') : `${v} FPS`);
}

/** Video Settings: quality presets on top, then the individual options as a 2-column list. */
export function videoSettingsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const root = menuScreen(t('video.title'), [], [button(t('common.done'), () => nav.pop())], { list: true });
  const body = root.querySelector<HTMLElement>('.screen-body')!;
  const toggle = (label: string, on: boolean, set: (v: boolean) => void) =>
    cycleButton<'on' | 'off'>(label, ['on', 'off'], onOff(), on ? 'on' : 'off', (v) => set(v === 'on'));

  // Rebuilt after a preset is applied so every control shows the new values.
  const render = () => {
    const s = store.values;
    const presetButtons = QUALITY_PRESETS.map((p) => {
      const btn = button(p.name, () => { store.setMany(p.values); render(); }, { cls: 'w72' });
      btn.title = p.description;
      btn.style.width = 'calc(var(--s) * 58)';
      return btn;
    });
    const info = h('div', { class: 'section-label hint' });
    const refresh = () => {
      const active = detectPreset(store.values);
      QUALITY_PRESETS.forEach((p, i) => presetButtons[i].classList.toggle('selected', p === active));
      info.textContent = active ? `${active.name}: ${active.description}` : t('video.custom');
    };
    const tracked = <T>(fn: (v: T) => void) => (v: T) => { fn(v); refresh(); };

    body.replaceChildren(h('div', { class: 'grid2' },
      h('div', { class: 'section-label', text: t('video.presets') }),
      h('div', { class: 'wide row', style: 'justify-content: center' }, ...presetButtons),
      info,
      h('div', { class: 'section-label' }),
      cycleButton<GraphicsQuality>(t('video.graphics'), ['fancy', 'fast'], { fancy: t('video.graphics.fancy'), fast: t('video.graphics.fast') }, s.graphics, tracked((v) => store.set('graphics', v))),
      slider(2, MAX_RENDER_DISTANCE, 1, s.renderDistance, (v) => t('video.renderDistance', v), tracked((v) => store.set('renderDistance', v))),
      cycleButton<ShadowQuality>(t('video.shadows'), ['off', 'low', 'high', 'ultra'], { off: t('common.off'), low: t('video.shadows.low'), high: t('video.shadows.high'), ultra: t('video.shadows.ultra') }, s.shadows, tracked((v) => store.set('shadows', v))),
      slider(50, 200, 25, s.renderScale, (v) => t('video.renderScale', v), tracked((v) => store.set('renderScale', v))),
      toggle(t('video.dynamicResolution'), s.dynamicResolution, (v) => store.set('dynamicResolution', v)),
      cycleButton<ParticleLevel>(t('video.particles'), ['all', 'decreased', 'minimal'], { all: t('video.particles.all'), decreased: t('video.particles.decreased'), minimal: t('video.particles.minimal') }, s.particles, tracked((v) => store.set('particles', v))),
      cycleButton<'fancy' | 'off'>(t('video.clouds'), ['fancy', 'off'], { fancy: t('video.graphics.fancy'), off: t('common.off') }, s.clouds, (v) => store.set('clouds', v)),
      slider(0, 100, 1, s.brightness, (v) => t('video.brightness', v === 0 ? t('video.brightness.moody') : v === 100 ? t('video.brightness.bright') : `${v}%`), (v) => store.set('brightness', v)),
      cycleButton<string>(t('video.guiScale'), ['0', '1', '2', '3', '4'], { 0: t('common.auto'), 1: '1', 2: '2', 3: '3', 4: '4' }, String(s.guiScale), (v) => store.set('guiScale', Number(v))),
      toggle(t('video.viewBobbing'), s.viewBobbing, (v) => store.set('viewBobbing', v)),
      slider(30, 110, 1, s.fov, fovLabel, (v) => store.set('fov', v)),
      slider(30, MAX_FPS_UNLIMITED, 10, s.maxFps, framerateLabel, (v) => store.set('maxFps', v)),
      slider(50, 500, 25, s.entityDistance, (v) => t('video.entityDistance', v), (v) => store.set('entityDistance', v)),
      cycleButton<'crosshair' | 'hotbar' | 'off'>(t('video.attackIndicator'), ['crosshair', 'hotbar', 'off'], { crosshair: t('video.attackIndicator.crosshair'), hotbar: t('video.attackIndicator.hotbar'), off: t('common.off') }, s.attackIndicator, (v) => store.set('attackIndicator', v)),
      fullscreenButton(),
    ));
    refresh();
  };
  render();
  return root;
}

function soundScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  const vol = (name: string) => (v: number) => `${name}: ${v === 0 ? t('common.off') : `${v}%`}`;
  return menuScreen(t('sound.title'), [
    h('div', { class: 'grid2' },
      h('div', { class: 'wide' }, slider(0, 100, 1, s.masterVolume, vol(t('sound.master')), (v) => store.set('masterVolume', v))),
      slider(0, 100, 1, s.musicVolume, vol(t('sound.music')), (v) => store.set('musicVolume', v)),
      slider(0, 100, 1, s.soundVolume, vol(t('sound.blocks')), (v) => store.set('soundVolume', v)),
      slider(0, 100, 1, s.ambientVolume, vol(t('sound.ambient')), (v) => store.set('ambientVolume', v)),
      slider(0, 100, 1, s.uiVolume, vol(t('sound.ui')), (v) => store.set('uiVolume', v)),
      cycleButton<'stereo' | 'hrtf'>(t('sound.spatial'), ['stereo', 'hrtf'], { stereo: t('sound.stereo'), hrtf: t('sound.hrtf') }, s.spatialAudio, (v) => store.set('spatialAudio', v)),
    ),
  ], [button(t('common.done'), () => nav.pop())], { list: true });
}

function controlsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  return menuScreen(t('controls.title'), [
    h('div', { class: 'grid2' },
      button(t('controls.mouse'), () => nav.push(mouseScreen(store, nav))),
      cycleButton<'on' | 'off'>(t('controls.autoJump'), ['off', 'on'], onOff(), s.autoJump ? 'on' : 'off', (v) => store.set('autoJump', v === 'on')),
      h('div', { class: 'wide' }, button(t('controls.keybinds'), () => nav.push(keyBindsScreen(store, nav)))),
    ),
  ], [button(t('common.done'), () => nav.pop())], { list: true });
}

function mouseScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  return menuScreen(t('mouse.title'), [
    h('div', { class: 'grid2' },
      slider(10, 200, 1, s.sensitivity, (v) => t('mouse.sensitivity', v), (v) => store.set('sensitivity', v)),
      cycleButton<'on' | 'off'>(t('mouse.invert'), ['off', 'on'], onOff(), s.invertMouse ? 'on' : 'off', (v) => store.set('invertMouse', v === 'on')),
      cycleButton<'on' | 'off'>(t('mouse.raw'), ['on', 'off'], onOff(), s.rawInput ? 'on' : 'off', (v) => store.set('rawInput', v === 'on')),
    ),
  ], [button(t('common.done'), () => nav.pop())], { list: true });
}

function chatSettingsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  return menuScreen(t('chat.title'), [
    h('div', { class: 'grid2' },
      slider(0, 100, 1, s.chatOpacity, (v) => t('chat.opacity', v), (v) => store.set('chatOpacity', v)),
      slider(50, 100, 1, s.chatTextSize, (v) => t('chat.size', v), (v) => store.set('chatTextSize', v)),
      slider(0, 100, 1, s.chatLineSpacing, (v) => t('chat.spacing', v), (v) => store.set('chatLineSpacing', v)),
      slider(40, 100, 1, s.chatWidth, (v) => t('chat.width', v), (v) => store.set('chatWidth', v)),
      cycleButton<'on' | 'off'>(t('chat.colors'), ['on', 'off'], onOff(), s.chatColors ? 'on' : 'off', (v) => store.set('chatColors', v === 'on')),
      cycleButton<'on' | 'off'>(t('chat.suggestions'), ['on', 'off'], onOff(), s.chatSuggestions ? 'on' : 'off', (v) => store.set('chatSuggestions', v === 'on')),
    ),
  ], [button(t('common.done'), () => nav.pop())], { list: true });
}

/** Language screen: one button per language; the choice applies at once and the screens below are rebuilt. */
export function languageScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const buttons = LANGUAGES.map((lang: Language) => {
    const btn = button(LANGUAGE_NAMES[lang], () => {
      if (getLanguage() === lang) return;
      store.set('language', lang);
      setLanguage(lang);
      // The game rebuilds the screens below (title or pause menu, then Options) in the new language.
      nav.pop();
      nav.languageChanged?.();
    });
    btn.classList.toggle('selected', getLanguage() === lang);
    return btn;
  });
  return menuScreen(t('language.title'), [
    h('div', { style: 'display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * 4);' },
      ...buttons,
      h('div', { class: 'hint', text: t('language.hint') }),
    ),
  ], [button(t('common.done'), () => nav.pop())], { list: true });
}

/** Accessibility & comfort: captions, motion, flashes, colours, contrast, text size, toggle/hold. */
export function accessibilityScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  return menuScreen('Accessibility Settings', [
    h('div', { class: 'grid2' },
      h('div', { class: 'section-label', text: 'Hearing and Seeing' }),
      toggle(store, 'Subtitles', 'subtitles'),
      toggle(store, 'Reduce Flashes', 'reduceFlashes'),
      toggle(store, 'High Contrast', 'highContrast'),
      toggle(store, 'Colour-Blind Colours', 'colorBlindSafe', 'Safe', 'Default'),
      slider(100, 200, 25, s.textScale, percent('Text Size'), (v) => store.set('textScale', v)),
      cycleButton<string>('GUI Scale', ['0', '1', '2', '3', '4'], { 0: 'Auto', 1: '1', 2: '2', 3: '3', 4: '4' }, String(s.guiScale), (v) => store.set('guiScale', Number(v))),
      h('div', { class: 'section-label', text: 'Motion' }),
      toggle(store, 'Reduced Motion', 'reducedMotion'),
      toggle(store, 'View Bobbing', 'viewBobbing'),
      slider(0, 100, 5, s.fovEffects, percent('FOV Effects'), (v) => store.set('fovEffects', v)),
      h('div', { class: 'section-label', text: 'Toggle or Hold' }),
      holdOrToggle(store, 'Sneak', 'toggleSneak'),
      holdOrToggle(store, 'Sprint', 'toggleSprint'),
      holdOrToggle(store, 'Attack/Destroy', 'toggleAttack'),
      holdOrToggle(store, 'Use Item/Place', 'toggleUse'),
      h('div', { class: 'section-label', text: 'Input' }),
      slider(0, 100, 5, s.stickCurve, (v) => `Stick Curve: ${v === 0 ? 'Linear' : `${v}%`}`, (v) => store.set('stickCurve', v)),
      slider(150, 800, 50, s.menuRepeatDelay, (v) => `Menu Key Repeat: ${v} ms`, (v) => store.set('menuRepeatDelay', v)),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}

/** Touch screens: joystick, look, buttons, gestures. */
export function touchScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  return menuScreen('Touch Settings', [
    h('div', { class: 'grid2' },
      cycleButton<Settings['touchControls']>('Touch Controls', ['auto', 'on', 'off'], { auto: 'Auto', on: 'ON', off: 'OFF' }, s.touchControls, (v) => store.set('touchControls', v)),
      slider(10, 300, 5, s.touchSensitivity, percent('Look Sensitivity'), (v) => store.set('touchSensitivity', v)),
      slider(60, 160, 10, s.touchButtonScale, percent('Button Size'), (v) => store.set('touchButtonScale', v)),
      slider(20, 100, 5, s.touchOpacity, percent('Opacity'), (v) => store.set('touchOpacity', v)),
      toggle(store, 'Left-Handed', 'touchLeftHanded'),
      toggle(store, 'Auto-Jump', 'touchAutoJump'),
      toggle(store, 'Tap to Use, Hold to Break', 'touchGestures'),
      toggle(store, 'Sprint by Pushing Stick', 'touchSprintPush'),
      toggle(store, 'Invert Look', 'invertMouse', 'Inverted', 'Normal'),
      h('div', { class: 'section-label hint', text: 'Left: joystick. Right: drag to look, tap to use, hold to break.' }),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}

/** Gamepad: sensitivity, dead zone, curve, invert, layout, vibration and the button map. */
export function controllerScreen(store: SettingsStore, nav: OptionsNav, padName: string): HTMLDivElement {
  const s = store.values;
  const map = [
    'Left stick: move (push in: sprint)  Right stick: look',
    'RT: attack/break  LT: use/place  A: jump  B: sneak',
    'X: inventory (reload)  Y: pick block (quick switch)',
    'LB/RB or D-pad: hotbar  Start: pause  Back: chat (scoreboard)',
  ];
  return menuScreen('Controller Settings', [
    h('div', { class: 'grid2' },
      h('div', { class: 'section-label hint', text: padName ? `Connected: ${padName}` : 'No controller detected. Press any button.' }),
      toggle(store, 'Controller', 'padEnabled'),
      cycleButton<Settings['padLayout']>('Layout', ['default', 'southpaw'], { default: 'Default', southpaw: 'Southpaw' }, s.padLayout, (v) => store.set('padLayout', v)),
      slider(10, 300, 5, s.padSensitivity, percent('Look Sensitivity'), (v) => store.set('padSensitivity', v)),
      slider(0, 50, 1, s.padDeadZone, percent('Dead Zone'), (v) => store.set('padDeadZone', v)),
      slider(0, 100, 5, s.stickCurve, (v) => `Stick Curve: ${v === 0 ? 'Linear' : `${v}%`}`, (v) => store.set('stickCurve', v)),
      toggle(store, 'Invert Y', 'padInvertY', 'Inverted', 'Normal'),
      toggle(store, 'Vibration', 'padRumble'),
      holdOrToggle(store, 'Sprint (L3)', 'toggleSprint'),
      ...map.map((line) => h('div', { class: 'section-label hint', text: line })),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}

const SWALLOWED = ['click', 'auxclick', 'contextmenu'];

/**
 * Key Binds, like Minecraft 1.21: grouped by category, "Name [key] [Reset]" per row.
 * Clicking a key button shows "> key <"; the next key or mouse press binds it and Escape
 * unbinds it ("Not Bound"). Keys used by more than one action are shown in red.
 */
function keyBindsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const keyButtons: HTMLButtonElement[] = [];
  const resetButtons: HTMLButtonElement[] = [];
  let listening = -1;

  const render = () => {
    const map = store.values.keybinds;
    const conflicts = conflictingActions(map);
    KEYBINDS.forEach((k, i) => {
      const code = map[k.id] ?? k.defaultCode;
      const btn = keyButtons[i];
      const label = keyDisplayName(code);
      btn.textContent = i === listening ? `> ${label} <` : label;
      btn.classList.toggle('listening', i === listening);
      btn.classList.toggle('conflict', i !== listening && conflicts.has(i));
      resetButtons[i].disabled = code === k.defaultCode;
    });
  };

  const setKeybinds = (map: KeybindMap) => {
    store.set('keybinds', map);
    render();
  };
  const bind = (i: number, code: string) => setKeybinds({ ...store.values.keybinds, [KEYBINDS[i].id]: code });

  // Listeners exist only while waiting for a press. They run in the capture phase, before
  // the game's own window listeners, so Escape here never reaches the pause/back handling.
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onKey = (e: KeyboardEvent) => {
    swallow(e);
    if (!e.repeat) finish(e.code === 'Escape' ? '' : e.code);
  };
  const onMouse = (e: MouseEvent) => {
    swallow(e);
    // The click/contextmenu that follows this press must not trigger a button.
    for (const t of SWALLOWED) window.addEventListener(t, swallow, true);
    window.addEventListener('mouseup', () => window.setTimeout(() => {
      for (const t of SWALLOWED) window.removeEventListener(t, swallow, true);
    }, 0), { capture: true, once: true });
    finish(`Mouse${e.button}`);
  };
  const stopListening = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
  };
  const finish = (code: string) => {
    const i = listening;
    listening = -1;
    stopListening();
    if (i >= 0 && isValidCode(code)) bind(i, code);
    else render();
  };
  const listen = (i: number) => {
    listening = i;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    render();
  };

  const rows: HTMLElement[] = [];
  for (const cat of KEYBIND_CATEGORIES) {
    rows.push(h('div', { class: 'keybind-category', text: cat }));
    // Alphabetical within a category, like Minecraft.
    const inCat = KEYBINDS.map((k, i) => ({ k, i })).filter(({ k }) => k.category === cat)
      .sort((a, b) => a.k.name.localeCompare(b.k.name, 'en', { numeric: true }));
    for (const { k, i } of inCat) {
      keyButtons[i] = button('', () => listen(i), { cls: 'keybind' });
      resetButtons[i] = button(t('common.reset'), () => bind(i, k.defaultCode));
      rows.push(h('div', { class: 'keybind-label', text: k.name }), keyButtons[i], resetButtons[i]);
    }
  }

  render();
  return menuScreen(t('keybinds.title'), [h('div', { class: 'keybinds' }, ...rows)], [
    button(t('keybinds.resetAll'), () => setKeybinds(defaultKeybinds()), { cls: 'w150' }),
    button(t('common.done'), () => nav.pop(), { cls: 'w150' }),
  ], { list: true });
}

function creditsScreen(nav: OptionsNav): HTMLDivElement {
  return menuScreen(t('options.credits').replace('...', ''), [
    h('div', { class: 'hint', style: 'display: flex; flex-direction: column; gap: calc(var(--s) * 6);' },
      ...nav.credits().map((line) => h('div', { text: line })),
    ),
  ], [button(t('common.done'), () => nav.pop())], { list: true });
}
