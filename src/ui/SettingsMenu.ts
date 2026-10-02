import {
  type GraphicsQuality, MAX_RENDER_DISTANCE, type ParticleLevel, QUALITY_PRESETS,
  type SettingsStore, type ShadowQuality, detectPreset,
} from '../core/Settings';
import {
  KEYBINDS, KEYBIND_CATEGORIES, type KeybindMap, conflictingActions, defaultKeybinds, isValidCode, keyDisplayName,
} from '../core/Keybinds';
import { installButton } from '../pwa/Pwa';
import { button, cycleButton, h, menuScreen, slider } from './dom';

export interface OptionsNav {
  push(el: HTMLElement): void;
  pop(): void;
  openResourcePacks(): void;
  credits(): string[];
}

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
      button('Credits & Attribution...', () => nav.push(creditsScreen(nav))),
      fullscreenButton(),
      installButton(),
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
