import {
  type GraphicsQuality, MAX_RENDER_DISTANCE, type ParticleLevel, QUALITY_PRESETS,
  type Settings, type SettingsStore, type ShadowQuality, detectPreset,
} from '../core/Settings';
import {
  KEYBINDS, KEYBIND_CATEGORIES, type KeybindMap, conflictingActions, defaultKeybinds, isValidCode, keyDisplayName,
} from '../core/Keybinds';
import { button, cycleButton, h, menuScreen, slider } from './dom';

export interface OptionsNav {
  push(el: HTMLElement): void;
  pop(): void;
  openResourcePacks(): void;
  credits(): string[];
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
  const label = () => `Fullscreen: ${document.fullscreenElement ? 'ON' : 'OFF'}`;
  const btn = button(label(), () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
    window.setTimeout(() => (btn.textContent = label()), 200);
  });
  return btn;
}

const fovLabel = (v: number) => `FOV: ${v === 70 ? 'Normal' : v === 110 ? 'Quake Pro' : v}`;

/** Options hub, structured like Minecraft 1.21's Options screen. */
export function optionsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  const presetIds = [...QUALITY_PRESETS.map((p) => p.id), 'custom'];
  const presetNames = Object.fromEntries([...QUALITY_PRESETS.map((p) => [p.id, p.name]), ['custom', 'Custom']]);
  const quality = cycleButton<string>('Quality', presetIds, presetNames, detectPreset(s)?.id ?? 'custom', (id) => {
    const p = QUALITY_PRESETS.find((q) => q.id === id);
    if (p) store.setMany(p.values);
  });

  return menuScreen('Options', [
    h('div', { class: 'grid2' },
      slider(30, 110, 1, s.fov, fovLabel, (v) => store.set('fov', v)),
      quality,
      h('div', { class: 'section-label' }),
      button('Video Settings...', () => nav.push(videoSettingsScreen(store, nav))),
      button('Music & Sounds...', () => nav.push(soundScreen(store, nav))),
      button('Controls...', () => nav.push(controlsScreen(store, nav))),
      button('Resource Packs...', () => nav.openResourcePacks()),
      button('Touch Settings...', () => nav.push(touchScreen(store, nav))),
      button('Controller Settings...', () => nav.push(controllerScreen(store, nav, nav.padName?.() ?? ''))),
      button('Accessibility Settings...', () => nav.push(accessibilityScreen(store, nav))),
      button('Credits & Attribution...', () => nav.push(creditsScreen(nav))),
      h('div', { class: 'wide' }, fullscreenButton()),
    ),
  ], [button('Done', () => nav.pop())]);
}

/** Video Settings: quality presets on top, then the individual options as a 2-column list. */
export function videoSettingsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const root = menuScreen('Video Settings', [], [button('Done', () => nav.pop())], { list: true });
  const body = root.querySelector<HTMLElement>('.screen-body')!;

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
      info.textContent = active ? `${active.name}: ${active.description}` : 'Custom: your own combination';
    };
    const tracked = <T>(fn: (v: T) => void) => (v: T) => { fn(v); refresh(); };

    body.replaceChildren(h('div', { class: 'grid2' },
      h('div', { class: 'section-label', text: 'Graphics Quality' }),
      h('div', { class: 'wide row', style: 'justify-content: center' }, ...presetButtons),
      info,
      h('div', { class: 'section-label' }),
      cycleButton<GraphicsQuality>('Graphics', ['fancy', 'fast'], { fancy: 'Fancy', fast: 'Fast' }, s.graphics, tracked((v) => store.set('graphics', v))),
      slider(2, MAX_RENDER_DISTANCE, 1, s.renderDistance, (v) => `Render Distance: ${v} chunks`, tracked((v) => store.set('renderDistance', v))),
      cycleButton<ShadowQuality>('Shadows', ['off', 'low', 'high', 'ultra'], { off: 'OFF', low: 'Low', high: 'High', ultra: 'Ultra' }, s.shadows, tracked((v) => store.set('shadows', v))),
      slider(50, 200, 25, s.renderScale, (v) => `Render Scale: ${v}%`, tracked((v) => store.set('renderScale', v))),
      cycleButton<'on' | 'off'>('Dynamic Resolution', ['on', 'off'], { on: 'ON', off: 'OFF' }, s.dynamicResolution ? 'on' : 'off', (v) => store.set('dynamicResolution', v === 'on')),
      cycleButton<ParticleLevel>('Particles', ['all', 'decreased', 'minimal'], { all: 'All', decreased: 'Decreased', minimal: 'Minimal' }, s.particles, tracked((v) => store.set('particles', v))),
      cycleButton<'fancy' | 'off'>('Clouds', ['fancy', 'off'], { fancy: 'Fancy', off: 'OFF' }, s.clouds, (v) => store.set('clouds', v)),
      slider(0, 100, 1, s.brightness, (v) => `Brightness: ${v === 0 ? 'Moody' : v === 100 ? 'Bright' : `${v}%`}`, (v) => store.set('brightness', v)),
      cycleButton<string>('GUI Scale', ['0', '1', '2', '3', '4'], { 0: 'Auto', 1: '1', 2: '2', 3: '3', 4: '4' }, String(s.guiScale), (v) => store.set('guiScale', Number(v))),
      cycleButton<'on' | 'off'>('View Bobbing', ['on', 'off'], { on: 'ON', off: 'OFF' }, s.viewBobbing ? 'on' : 'off', (v) => store.set('viewBobbing', v === 'on')),
      slider(30, 110, 1, s.fov, fovLabel, (v) => store.set('fov', v)),
      fullscreenButton(),
    ));
    refresh();
  };
  render();
  return root;
}

function soundScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  const vol = (name: string) => (v: number) => `${name}: ${v === 0 ? 'OFF' : `${v}%`}`;
  return menuScreen('Music & Sound Options', [
    h('div', { class: 'grid2' },
      h('div', { class: 'wide' }, slider(0, 100, 1, s.masterVolume, vol('Master Volume'), (v) => store.set('masterVolume', v))),
      slider(0, 100, 1, s.musicVolume, vol('Music'), (v) => store.set('musicVolume', v)),
      slider(0, 100, 1, s.soundVolume, vol('Blocks'), (v) => store.set('soundVolume', v)),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}

function controlsScreen(store: SettingsStore, nav: OptionsNav): HTMLDivElement {
  const s = store.values;
  return menuScreen('Controls', [
    h('div', { class: 'grid2' },
      slider(10, 200, 1, s.sensitivity, (v) => `Sensitivity: ${v}%`, (v) => store.set('sensitivity', v)),
      cycleButton<'on' | 'off'>('Invert Mouse', ['off', 'on'], { on: 'ON', off: 'OFF' }, s.invertMouse ? 'on' : 'off', (v) => store.set('invertMouse', v === 'on')),
      button('Key Binds...', () => nav.push(keyBindsScreen(store, nav))),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
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
      resetButtons[i] = button('Reset', () => bind(i, k.defaultCode));
      rows.push(h('div', { class: 'keybind-label', text: k.name }), keyButtons[i], resetButtons[i]);
    }
  }

  render();
  return menuScreen('Key Binds', [h('div', { class: 'keybinds' }, ...rows)], [
    button('Reset Keys', () => setKeybinds(defaultKeybinds()), { cls: 'w150' }),
    button('Done', () => nav.pop(), { cls: 'w150' }),
  ], { list: true });
}

function creditsScreen(nav: OptionsNav): HTMLDivElement {
  return menuScreen('Credits & Attribution', [
    h('div', { class: 'hint', style: 'display: flex; flex-direction: column; gap: calc(var(--s) * 6);' },
      ...nav.credits().map((line) => h('div', { text: line })),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}
