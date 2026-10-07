/**
 * Server tick cost with bots: L lobbies of 1 idle person + 11 bots each, on a simulated clock (so a minute of
 * play runs as fast as the CPU allows), measuring the wall time of every tick of every lobby.
 *
 *   npx tsx scripts/bench-bots.ts [lobbies=4] [seconds=60] [mode=tdm] [map=atomic] [difficulty=normal]
 */
import { SimLobby } from '../tests/helpers/botServer';
import type { GameType } from '../src/modes/GameTypes';
import type { MapSetting } from '../src/modes/maps';
import type { BotDifficulty } from '../server/bots/BotSkill';

const [lobbiesArg, secondsArg, modeArg, mapArg, diffArg] = process.argv.slice(2);
const lobbies = Number(lobbiesArg ?? 4);
const seconds = Number(secondsArg ?? 60);
const mode = (modeArg ?? 'tdm') as GameType;
const map = (mapArg ?? 'atomic') as MapSetting;
const difficulty = (diffArg ?? 'normal') as BotDifficulty;

const clock = { ms: 1_700_000_000_000 };
Date.now = () => clock.ms;
const list: SimLobby[] = [];
for (let i = 0; i < lobbies; i++) {
  const l = new SimLobby(clock, { gameType: mode, map, bots: { fill: 12, difficulty }, scoreLimit: 100, timeLimitSec: 1800, seed: String(7 + i) });
  l.join(`Human${i}`);
  list.push(l);
}
// Fill up (bots join a few per second) and build the nav graphs before measuring.
const hz = 30;
for (let i = 0; i < hz * 5; i++) { clock.ms += 1000 / hz; for (const l of list) l.tick(); }
const threadCpu = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
const cpuMs = () => { const u = threadCpu ? threadCpu.call(process) : process.cpuUsage(); return (u.user + u.system) / 1000; };
let cpuTotal = 0;
const times: number[] = [];
const roundTimes: number[] = [];
const botTimes: number[] = [];
for (let i = 0; i < seconds * hz; i++) {
  clock.ms += 1000 / hz;
  const r0 = performance.now();
  const c0 = cpuMs();
  for (const l of list) {
    const b0 = l.bots.perf.totalMs;
    const t0 = performance.now();
    l.tick();
    times.push(performance.now() - t0);
    botTimes.push(l.bots.perf.totalMs - b0);
  }
  roundTimes.push(performance.now() - r0);
  cpuTotal += cpuMs() - c0;
  if (i % hz === 0) for (const l of list) for (const ws of l.humans) ws.sent.length = 0;
}
times.sort((a, b) => a - b);
botTimes.sort((a, b) => a - b);
roundTimes.sort((a, b) => a - b);
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(`${lobbies} lobbies × (1 person + ${list[0].bots.count} bots), ${mode} on ${map}, ${difficulty}, ${seconds}s at ${hz} Hz`);
console.log(`per lobby tick: avg ${avg(times).toFixed(3)} ms, p50 ${pct(times, 0.5).toFixed(3)}, p99 ${pct(times, 0.99).toFixed(3)}, max ${times[times.length - 1].toFixed(2)} ms`);
console.log(`  of which bots: avg ${avg(botTimes).toFixed(3)} ms, p50 ${pct(botTimes, 0.5).toFixed(3)}, p99 ${pct(botTimes, 0.99).toFixed(3)}, max ${botTimes[botTimes.length - 1].toFixed(2)} ms`);
// Thread CPU time: what the lobbies cost regardless of other processes on the machine (wall times above swing with load).
console.log(`per lobby tick CPU: mean ${(cpuTotal / (seconds * hz) / lobbies).toFixed(3)} ms`);
console.log(`all lobbies per tick: avg ${avg(roundTimes).toFixed(3)} ms, p99 ${pct(roundTimes, 0.99).toFixed(3)} ms (budget ${(1000 / hz).toFixed(1)} ms)`);
for (const l of list) {
  const p = l.server.botPerf()!;
  const m = l.match;
  console.log(`  bots: avg ${p.avgMs.toFixed(3)} ms/tick, max ${p.maxMs.toFixed(2)} ms, thinks ${p.thinks}, deferred ${p.skippedThinks}; score red ${m.scores.red} blue ${m.scores.blue}, phase ${m.phase}`);
}
for (const l of list) l.dispose();
