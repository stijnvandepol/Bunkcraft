import { ArenaMap } from './ArenaMap';
import { BUNKER } from './bunker';
import { ATOMIC } from './atomic';
import { CARRIER } from './carrier';
import { CLASSIC } from './classic';
import { DESERT } from './desert';
import { DOCKYARD } from './dockyard';
import { MALL } from './mall';
import { PLAZA } from './plaza';
import { QUARTER } from './quarter';
import { SCRAP } from './scrap';
import { SHANTY } from './shanty';
import { SITE } from './site';
import { STATION } from './station';
import { SUBURB } from './suburb';
import { TOWN } from './town';
import { VILLA } from './villa';
import { YACHT } from './yacht';

export { ARENA_FLOOR_Y, ArenaMap, type Flag, type Spawn, type Zone } from './ArenaMap';

export type MapId = 'classic' | 'suburb' | 'quarter' | 'dockyard' | 'desert' | 'atomic' | 'bunker' | 'villa' | 'yacht' | 'town' | 'station'
  | 'plaza' | 'site' | 'carrier' | 'shanty' | 'mall' | 'scrap';
/** The map of plain "arena" worlds; it must stay 'classic' so old saves keep their map. */
export const DEFAULT_MAP: MapId = 'classic';
/** The map the create-game menu suggests first. */
export const MENU_DEFAULT_MAP: MapId = 'atomic';

/** Room setting: a fixed map, or "rotate" = the next match uses the next map. */
export type MapSetting = MapId | 'rotate';

export const MAPS: ArenaMap[] = [CLASSIC, SUBURB, QUARTER, DOCKYARD, DESERT, ATOMIC, BUNKER, VILLA, YACHT, TOWN, STATION, PLAZA, SITE, CARRIER, SHANTY, MALL, SCRAP].map((d) => new ArenaMap(d));
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

/** The map after `id` in rotation order that has the data the game type needs (all maps when it needs none). */
export function nextMap(id: MapId, requires?: readonly ('zones' | 'flags')[]): MapId {
  for (let i = 1; i <= MAPS.length; i++) {
    const m = MAPS[(MAP_IDS.indexOf(id) + i) % MAPS.length];
    if (m.supports(requires)) return m.id as MapId;
  }
  return id;
}

/** The first map that has the data a game type needs; `preferred` when it qualifies. */
export function mapFor(preferred: MapId, requires?: readonly ('zones' | 'flags')[]): MapId {
  return getMap(preferred).supports(requires) ? preferred : (MAPS.find((m) => m.supports(requires))?.id as MapId | undefined) ?? preferred;
}

export function mapName(setting: MapSetting): string {
  return setting === 'rotate' ? 'Rotate' : getMap(setting).name;
}

/**
 * The maps offered in the vote after a match: the rotation's next map first (it wins a tie), then others the
 * game type can be played on, picked at random; the map just played only when there are not enough others.
 */
export function voteChoices(current: MapId, requires: readonly ('zones' | 'flags')[] | undefined, random: () => number, count = 3): MapId[] {
  const first = nextMap(current, requires);
  const out: MapId[] = [first];
  const pool = MAP_IDS.filter((id) => id !== first && id !== current && getMap(id).supports(requires));
  while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  if (out.length < count && current !== first && getMap(current).supports(requires)) out.push(current);
  return out;
}
