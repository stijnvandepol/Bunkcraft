import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GameType, gameTypeDef } from '../src/modes/GameTypes';
import { getMap } from '../src/modes/maps';
import { REALMS_MODES, joinable } from '../src/modes/Realms';
import { t } from '../src/ui/i18n';
import { Rooms } from '../server/Rooms';

const NEW_MODES: GameType[] = ['killconfirmed', 'snd', 'infected', 'sharpshooter', 'koth'];
const sets: Rooms[] = [];
const dirs: string[] = [];

afterEach(() => {
  sets.splice(0).forEach((r) => r.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function rooms(): Rooms {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-newmodes-'));
  dirs.push(dir);
  const r = new Rooms({ dataDir: dir, maxRooms: 40, maxPlayers: 8, motd: '', idleUnloadMs: 60_000, expireDays: 0 });
  sets.push(r);
  return r;
}

describe('new modes in Realms', () => {
  it('are in the playlist with a name and a description in both languages', () => {
    for (const m of NEW_MODES) {
      expect(REALMS_MODES).toContain(m);
      expect(t(`realms.mode.${m}` as never)).not.toBe(`realms.mode.${m}`);
      expect(t(`realms.desc.${m}` as never)).not.toBe(`realms.desc.${m}`);
    }
  });

  it('have sensible limits: options contain the defaults, round modes count rounds', () => {
    for (const m of NEW_MODES) {
      const def = gameTypeDef(m);
      expect(def.options!.time).toContain(def.timeLimitSec);
      if (def.options!.score.length) expect(def.options!.score).toContain(def.scoreLimit);
      else expect(def.scoreLimit).toBe(0);
    }
    expect(gameTypeDef('snd').rounds).toBeDefined();
    // Round modes are never "about to end" by the clock of one round.
    expect(joinable({ code: 'X', gameType: 'snd', players: 2, maxPlayers: 8, open: true, phase: 'live', timeLeft: 10, progress: 0.3 }, 'snd')).toBe(true);
  });

  it('quick play opens a public lobby on a map the mode can be played on, then fills it', () => {
    const r = rooms();
    for (const m of NEW_MODES) {
      const res = r.quickPlay(m, () => true) as { code: string; created: boolean };
      expect(res.created, m).toBe(true);
      const map = r.get(res.code)!.server.lobbyStatus()!.map;
      expect(getMap(map).supports(gameTypeDef(m).requires), `${m} on ${map}`).toBe(true);
      expect(r.info(res.code)).toMatchObject({ gameType: m });
    }
  });

  it('a private search and destroy lobby keeps a small round limit and a short round', () => {
    const r = rooms();
    const code = r.create('SnD', undefined, undefined, { gameType: 'snd', scoreLimit: 2, timeLimitSec: 90, mapId: 'classic' })!;
    expect(r.info(code)).toMatchObject({ gameType: 'snd', scoreLimit: 2, timeLimitSec: 90 });
  });
});
