export type GraphicsQuality = 'fast' | 'fancy';
export type ShadowQuality = 'off' | 'low' | 'high' | 'ultra';
export type ParticleLevel = 'all' | 'decreased' | 'minimal';

export interface Settings {
  renderDistance: number;
  /** Internal resolution in % of the display resolution (supersampling above 100). */
  renderScale: number;
  graphics: GraphicsQuality;
  shadows: ShadowQuality;
  particles: ParticleLevel;
  fov: number;
  sensitivity: number;
  soundVolume: number;
  musicVolume: number;
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
}

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  renderScale: 100,
  graphics: 'fancy',
  shadows: 'low',
  particles: 'all',
  fov: 70,
  sensitivity: 100,
  soundVolume: 80,
  musicVolume: 50,
  viewBobbing: true,
  guiScale: 0,
  brightness: 50,
  clouds: 'fancy',
  masterVolume: 100,
  invertMouse: false,
  texturePack: 'pixel-perfection',
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

/** Settings persisted in localStorage, with change listeners. */
export class SettingsStore {
  readonly values: Settings;
  private readonly listeners: ((s: Settings, key: keyof Settings) => void)[] = [];

  constructor() {
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Settings>;
    } catch {
      stored = {};
    }
    this.values = { ...DEFAULT_SETTINGS, ...stored };
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
