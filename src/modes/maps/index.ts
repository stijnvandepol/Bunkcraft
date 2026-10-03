import { ArenaMap } from './ArenaMap';
import { ATOMIC } from './atomic';
import { CLASSIC } from './classic';
import { DESERT } from './desert';
import { DOCKYARD } from './dockyard';
import { QUARTER } from './quarter';
import { SUBURB } from './suburb';

export { ARENA_FLOOR_Y, ArenaMap, type Spawn } from './ArenaMap';

export type MapId = 'classic' | 'suburb' | 'quarter' | 'dockyard' | 'desert' | 'atomic';
/** The map of plain "arena" worlds; it must stay 'classic' so old saves keep their map. */
export const DEFAULT_MAP: MapId = 'classic';
/** The map the create-game menu suggests first. */
export const MENU_DEFAULT_MAP: MapId = 'atomic';

/** Room setting: a fixed map, or "rotate" = the next match uses the next map. */
export type MapSetting = MapId | 'rotate';

export const MAPS: ArenaMap[] = [CLASSIC, SUBURB, QUARTER, DOCKYARD, DESERT, ATOMIC].map((d) => new ArenaMap(d));
export const MAP_IDS: MapId[] = MAPS.map((m) => m.id as MapId);
export const MAP_SETTINGS: MapSetting[] = [...MAP_IDS, 'rotate'];

export function parseMapId(v: unknown): MapId | null {
  return MAP_IDS.includes(v as MapId) ? (v as MapId) : null;
}

/** Valid map setting or null (callers fall back to the default). */
export function parseMapSetting(v: unknown): MapSetting | null {
  return MAP_SETTINGS.includes(v as MapSetting) ? (v as MapSetting) : null;
}

export function getMap(id: unknown): ArenaMap {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

/** The map after `id` in rotation order. */
export function nextMap(id: MapId): MapId {
  return MAP_IDS[(MAP_IDS.indexOf(id) + 1) % MAP_IDS.length];
}

export function mapName(setting: MapSetting): string {
  return setting === 'rotate' ? 'Rotate' : getMap(setting).name;
}
