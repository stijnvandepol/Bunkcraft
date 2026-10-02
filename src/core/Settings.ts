import { type KeybindMap, defaultKeybinds, sanitizeKeybinds } from './Keybinds';

export type GraphicsQuality = 'fast' | 'fancy';
export type ShadowQuality = 'off' | 'low' | 'high' | 'ultra';
export type ParticleLevel = 'all' | 'decreased' | 'minimal';

export interface Settings {
  renderDistance: number;
  /** Internal resolution in % of the display resolution (supersampling above 100). */
  renderScale: number;
  /** Lower the resolution automatically when the frame rate drops (weak GPUs, Retina screens). */
  dynamicResolution: boolean;
  graphics: GraphicsQuality;
  shadows: ShadowQuality;
  particles: ParticleLevel;
  fov: number;
  sensitivity: number;
  soundVolume: number;
  musicVolume: number;
  /** Ambience (wind, rain, caves, birds) and interface sounds, 0..100. */
  ambientVolume: number;
  uiVolume: number;
  /** Positional audio: simple stereo pan or HRTF (best on headphones). */
  spatialAudio: 'stereo' | 'hrtf';
  viewBobbing: boolean;
  /** 0 = Auto (largest whole scale that fits 320×240 GUI pixels), otherwise 1–4. */
  guiScale: number;
  /** 0 = Moody … 100 = Bright. */
  brightness: number;
  clouds: 'fancy' | 'off';
  masterVolume: number;
  invertMouse: boolean;
  /** Texture pack id, or "procedural" for the built-in generated textures. */
  texturePack: string;
  /** Action id → key code or "Mouse<n>" ('' = Not Bound); see Keybinds.ts. */
  keybinds: KeybindMap;
  /** UI language (see src/ui/i18n.ts). */
  language: 'en' | 'nl';
  /** Frame limiter in frames per second; MAX_FPS_UNLIMITED (260) = no limit. */
  maxFps: number;
  /** Mob render distance in % (Minecraft's Entity Distance, 50–500%). */
  entityDistance: number;
  /** Where the attack cooldown indicator is drawn. */
  attackIndicator: 'crosshair' | 'hotbar' | 'off';
  /** Raw (unaccelerated) mouse input where the browser supports it. */
  rawInput: boolean;
  /** Jump automatically onto one-block ledges while moving. */
  autoJump: boolean;
  /** FOV Effects: how much sprinting and flying change the field of view, 0–100%. */
  fovEffects: number;
  /** Chat settings (Minecraft's Chat Settings screen). */
  chatOpacity: number;
  chatTextSize: number;
  chatLineSpacing: number;
  chatWidth: number;
  chatColors: boolean;
  chatSuggestions: boolean;
}

export const MAX_FPS_UNLIMITED = 260;

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  renderScale: 100,
  dynamicResolution: true,
  graphics: 'fancy',
  shadows: 'low',
  particles: 'all',
  fov: 70,
  sensitivity: 100,
  soundVolume: 80,
  musicVolume: 50,
  ambientVolume: 80,
  uiVolume: 80,
  spatialAudio: 'stereo',
  viewBobbing: true,
  guiScale: 0,
  brightness: 50,
  clouds: 'fancy',
  masterVolume: 100,
  invertMouse: false,
  texturePack: 'pixel-perfection',
  keybinds: defaultKeybinds(),
  language: 'en',
  maxFps: MAX_FPS_UNLIMITED,
  entityDistance: 100,
  attackIndicator: 'crosshair',
  rawInput: true,
  autoJump: false,
  fovEffects: 100,
  chatOpacity: 100,
  chatTextSize: 100,
  chatLineSpacing: 0,
  chatWidth: 100,
  chatColors: true,
  chatSuggestions: true,
};

export const RENDER_DISTANCE_PRESETS: [string, number][] = [['Low', 4], ['Medium', 8], ['High', 12], ['Ultra', 16], ['Extreme', 20]];
export const MAX_RENDER_DISTANCE = 24;

/** The settings a quality preset controls. */
export type QualitySettings = Pick<Settings, 'renderDistance' | 'renderScale' | 'graphics' | 'shadows' | 'particles'>;

export interface QualityPreset {
  id: string;
  name: string;
  description: string;
  values: QualitySettings;
}

/** One-click quality levels, from weak laptops to high-end desktops. */
export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 'low', name: 'Low', description: 'Older laptops and integrated graphics',
    values: { renderDistance: 4, renderScale: 75, graphics: 'fast', shadows: 'off', particles: 'minimal' },
  },
  {
    id: 'medium', name: 'Medium', description: 'Most laptops',
    values: { renderDistance: 8, renderScale: 100, graphics: 'fancy', shadows: 'low', particles: 'all' },
  },
  {
    id: 'high', name: 'High', description: 'Gaming laptops and desktops',
    values: { renderDistance: 12, renderScale: 100, graphics: 'fancy', shadows: 'high', particles: 'all' },
  },
  {
    id: 'ultra', name: 'Ultra', description: 'Dedicated graphics card',
    values: { renderDistance: 16, renderScale: 100, graphics: 'fancy', shadows: 'high', particles: 'all' },
  },
  {
    id: 'extreme', name: 'Extreme', description: 'High-end GPU: supersampling and 4K shadows',
    values: { renderDistance: 20, renderScale: 150, graphics: 'fancy', shadows: 'ultra', particles: 'all' },
  },
];

/** The preset matching the current values, or undefined when the user customised them. */
export function detectPreset(s: Settings): QualityPreset | undefined {
  return QUALITY_PRESETS.find((p) => (Object.keys(p.values) as (keyof QualitySettings)[]).every((k) => p.values[k] === s[k]));
}

const STORAGE_KEY = 'bunkcraft.settings';

/** Numeric settings: the range the options menu allows (integers are rounded). */
const NUMBER_RANGES = {
  renderDistance: [2, MAX_RENDER_DISTANCE],
  renderScale: [50, 200],
  fov: [30, 110],
  sensitivity: [10, 200],
  soundVolume: [0, 100],
  musicVolume: [0, 100],
  ambientVolume: [0, 100],
  uiVolume: [0, 100],
  masterVolume: [0, 100],
  brightness: [0, 100],
  guiScale: [0, 4],
  maxFps: [30, MAX_FPS_UNLIMITED],
  entityDistance: [50, 500],
  fovEffects: [0, 100],
  chatOpacity: [0, 100],
  chatTextSize: [50, 100],
  chatLineSpacing: [0, 100],
  chatWidth: [40, 100],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

const ENUM_VALUES = {
  graphics: ['fast', 'fancy'],
  shadows: ['off', 'low', 'high', 'ultra'],
  particles: ['all', 'decreased', 'minimal'],
  clouds: ['fancy', 'off'],
  spatialAudio: ['stereo', 'hrtf'],
  language: ['en', 'nl'],
  attackIndicator: ['crosshair', 'hotbar', 'off'],
} as const satisfies Partial<Record<keyof Settings, readonly string[]>>;

const BOOLEAN_KEYS = ['dynamicResolution', 'viewBobbing', 'invertMouse', 'rawInput', 'autoJump', 'chatColors', 'chatSuggestions'] as const;

/**
 * A complete, valid Settings object from untrusted stored data: numbers are clamped to the menu's
 * range, enums validated, unknown keys ignored and anything invalid falls back to the default.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, keybinds: sanitizeKeybinds(null) };
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const o = out as unknown as Record<string, unknown>;
  for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) o[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  for (const [key, allowed] of Object.entries(ENUM_VALUES) as [string, readonly string[]][]) {
    const v = r[key];
    if (typeof v === 'string' && allowed.includes(v)) o[key] = v;
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof r[key] === 'boolean') o[key] = r[key];
  }
  const pack = r.texturePack;
  if (typeof pack === 'string' && pack.length > 0 && pack.length <= 200) out.texturePack = pack;
  out.keybinds = sanitizeKeybinds(r.keybinds);
  return out;
}

/** Settings persisted in localStorage, with change listeners. */
export class SettingsStore {
  readonly values: Settings;
  /** True on a first launch (nothing stored yet): the game then picks a preset for the hardware. */
  readonly fresh: boolean;
  private readonly listeners: ((s: Settings, key: keyof Settings) => void)[] = [];

  constructor() {
    let stored: unknown = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    this.fresh = stored === null || typeof stored !== 'object' || Array.isArray(stored);
    // Stored values are untrusted: clamp, validate and drop unknown keys (keybinds included).
    this.values = sanitizeSettings(stored);
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // Storage unavailable (private mode): settings simply won't persist.
    }
    for (const l of this.listeners) l(this.values, key);
  }

  /** Apply several values at once (listeners fire once per changed key). */
  setMany(values: Partial<Settings>): void {
    for (const [k, v] of Object.entries(values) as [keyof Settings, Settings[keyof Settings]][]) {
      (this.set as (key: keyof Settings, value: Settings[keyof Settings]) => void)(k, v);
    }
  }

  onChange(listener: (s: Settings, key: keyof Settings) => void): void {
    this.listeners.push(listener);
  }
}
