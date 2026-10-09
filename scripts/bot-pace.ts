/**
 * Pace of bot matches through the real GameServer on a simulated clock (tests/helpers/botServer.ts): kills per minute,
 * the average life (time between a bot's respawn and its death) and the kills per weapon with the headshot share.
 * Together with scripts/ttk-sim.ts the numbers behind "you die too fast".
 *
 *   npx tsx scripts/bot-pace.ts [seconds=300] [bots=11] [difficulty=normal] [mode=tdm] [map=classic,suburb,quarter,town]
 */
import { RESPAWN_SECONDS } from '../src/modes/Weapons';
import type { GameType } from '../src/modes/GameTypes';
import type { MapSetting } from '../src/modes/maps';
import type { BotDifficulty } from '../server/bots/BotSkill';
import { SimLobby } from '../tests/helpers/botServer';

const [secondsArg, botsArg, diffArg, modeArg, mapsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 300);
const bots = Number(botsArg ?? 11);
const difficulty = (diffArg ?? 'normal') as BotDifficulty;
const mode = (modeArg ?? 'tdm') as GameType;
const maps = (mapsArg ?? 'classic,suburb,quarter,town').split(',') as MapSetting[];

const clock = { ms: 1_700_000_000_000 };
Date.now = () => clock.ms;
const byWeapon = new Map<string, { kills: number; heads: number }>();
const lives: number[] = [];
let kills = 0, headKills = 0, minutes = 0;
const rows: string[] = [];

for (const [i, map] of maps.entries()) {
  const lobby = new SimLobby(clock, { gameType: mode, map, bots: { fill: bots + 1, difficulty }, scoreLimit: 100000, timeLimitSec: 100000, seed: String(7 + i) });
  const human = lobby.join('Idle');
  lobby.run(25); // bots join, the warm-up ends
  human.sent.length = 0;
  const lastDeath = new Map<number, number>();
  let seen = 0, mk = 0, mh = 0;
  const t0 = clock.ms;
  const mapLives: number[] = [];
  lobby.run(seconds, 30, () => {
    for (; seen < human.sent.length; seen++) {
      const m = human.sent[seen];
      if (m.t !== 'kill' || m.killer === m.victim) continue;
      const now = (clock.ms - t0) / 1000;
      const idle = human.sent.find((x) => x.t === 'welcome') as { id: number } | undefined;
      if (m.victim === idle?.id || m.killer === idle?.id) continue;
      mk++; if (m.head) mh++;
      const w = byWeapon.get(m.weapon) ?? { kills: 0, heads: 0 };
      w.kills++; if (m.head) w.heads++;
      byWeapon.set(m.weapon, w);
      const prev = lastDeath.get(m.victim);
      if (prev !== undefined) mapLives.push(now - prev - RESPAWN_SECONDS);
      lastDeath.set(m.victim, now);
    }
    if (human.sent.length > 1500) { seen -= human.sent.length - 500; human.sent.splice(0, human.sent.length - 500); }
  });
  lobby.dispose();
  const avg = mapLives.reduce((a, b) => a + b, 0) / Math.max(1, mapLives.length);
  rows.push(`${String(map).padEnd(10)}${(mk / (seconds / 60)).toFixed(1).padStart(10)}${avg.toFixed(1).padStart(9)}${(mk ? (mh / mk) * 100 : 0).toFixed(0).padStart(11)}`);
  kills += mk; headKills += mh; minutes += seconds / 60; lives.push(...mapLives);
}
console.log(`${bots} bots (${difficulty}) + 1 idle, ${mode}, ${seconds} s per map`);
console.log('map'.padEnd(10) + 'kills/min'.padStart(10) + 'life s'.padStart(9) + 'headshot %'.padStart(11));
for (const r of rows) console.log(r);
console.log('mean'.padEnd(10) + (kills / minutes).toFixed(1).padStart(10) + (lives.reduce((a, b) => a + b, 0) / Math.max(1, lives.length)).toFixed(1).padStart(9) + (kills ? (headKills / kills) * 100 : 0).toFixed(0).padStart(11));
console.log('\nkills per weapon (headshot %)');
console.log([...byWeapon].sort((a, b) => b[1].kills - a[1].kills).map(([w, s]) => `${w} ${s.kills} (${Math.round((s.heads / s.kills) * 100)}%)`).join(', '));
process.exit(0);
