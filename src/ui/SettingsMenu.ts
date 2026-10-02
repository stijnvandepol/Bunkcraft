import {
  type GraphicsQuality, MAX_RENDER_DISTANCE, type ParticleLevel, QUALITY_PRESETS,
  type SettingsStore, type ShadowQuality, detectPreset,
} from '../core/Settings';
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
  const binds: [string, string][] = [
    ['Walk Forwards', 'W'], ['Walk Backwards', 'S'], ['Strafe Left', 'A'], ['Strafe Right', 'D'],
    ['Jump', 'Space'], ['Sprint', 'Left Shift'], ['Fly Down', 'C'], ['Toggle Flight', 'Space ×2'],
    ['Attack/Destroy', 'Button 1'], ['Use Item/Place Block', 'Button 2'], ['Pick Block', 'Button 3'],
    ['Open/Close Inventory', 'E'], ['Drop Item', 'Q'], ['Hotbar Slots', '1 – 9'], ['Toggle HUD', 'F1'], ['Debug Screen', 'F3'],
    ['Pause', 'Escape'],
  ];
  return menuScreen('Controls', [
    h('div', { class: 'grid2' },
      slider(10, 200, 1, s.sensitivity, (v) => `Sensitivity: ${v}%`, (v) => store.set('sensitivity', v)),
      cycleButton<'on' | 'off'>('Invert Mouse', ['off', 'on'], { on: 'ON', off: 'OFF' }, s.invertMouse ? 'on' : 'off', (v) => store.set('invertMouse', v === 'on')),
      h('div', { class: 'section-label', text: 'Key Binds' }),
      ...binds.flatMap(([action, key]) => [
        h('div', { class: 'keybind-label', text: action }),
        button(key, () => undefined, { cls: 'keybind' }),
      ]),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}

function creditsScreen(nav: OptionsNav): HTMLDivElement {
  return menuScreen('Credits & Attribution', [
    h('div', { class: 'hint', style: 'display: flex; flex-direction: column; gap: calc(var(--s) * 6);' },
      ...nav.credits().map((line) => h('div', { text: line })),
    ),
  ], [button('Done', () => nav.pop())], { list: true });
}
