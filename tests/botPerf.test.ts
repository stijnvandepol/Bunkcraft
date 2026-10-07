import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavGraph } from '../server/bots/NavGraph';
import { PATHS_PER_TICK } from '../server/bots/BotManager';
import { type SimClock, SimLobby } from './helpers/botServer';
import { TIME_SLACK } from './helpers/timing';

/**
 * Bots must cost little: three lobbies of 1 person + 11 bots each, 20 simulated seconds at 30 Hz. The work per tick
 * is bounded by construction (checked by counting), and the CPU time is measured on the thread clock, which a busy
 * machine (the full test suite runs in parallel) does not inflate the way it inflates wall time. The full numbers
 * (more lobbies, longer, percentiles) come from `npx tsx scripts/bench-bots.ts`.
 */
const clock: SimClock = { ms: 1_700_000_000_000 };
const lobbies: SimLobby[] = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock.ms); });
afterEach(() => {
  lobbies.splice(0).forEach((l) => l.dispose());
  vi.restoreAllMocks();
});

const threadCpu = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
const cpuMs = () => { const u = (threadCpu ?? process.cpuUsage).call(process); return (u.user + u.system) / 1000; };

describe('bot tick cost', () => {
  it('11 bots per lobby: bounded work per tick and well inside the 33 ms tick', () => {
    for (let i = 0; i < 3; i++) {
      const l = new SimLobby(clock, { gameType: i === 1 ? 'ctf' : 'tdm', map: i === 2 ? 'classic' : 'atomic', bots: { fill: 12, difficulty: 'hard' }, scoreLimit: 100, timeLimitSec: 1800, seed: String(i) });
      l.join(`Person${i}`);
      lobbies.push(l);
    }
    // Fill up, build the graphs, finish the warm-up.
    for (let t = 0; t < 30 * 12; t++) { clock.ms += 1000 / 30; for (const l of lobbies) l.tick(); }
    for (const l of lobbies) expect(l.bots.count).toBe(11);
    const searches = vi.spyOn(NavGraph.prototype, 'path');
    const before = lobbies.map((l) => ({ ...l.bots.perf }));
    let maxSearches = 0;
    const c0 = cpuMs();
    const ticks = 30 * 20;
    for (let t = 0; t < ticks; t++) {
      clock.ms += 1000 / 30;
      for (const l of lobbies) {
        const n0 = searches.mock.calls.length;
        l.tick();
        maxSearches = Math.max(maxSearches, searches.mock.calls.length - n0);
      }
    }
    const cpuPerLobbyTick = (cpuMs() - c0) / (ticks * lobbies.length);
    // At most PATHS_PER_TICK route searches per lobby and tick, however many bots want one.
    expect(maxSearches).toBeLessThanOrEqual(PATHS_PER_TICK);
    lobbies.forEach((l, i) => {
      const p = l.bots.perf, b = before[i];
      const thinks = p.thinks - b.thinks;
      // About 10 decisions per living bot per second (dead ones wait). (Thinks the wall-clock budget pushes to a later
      // tick are not asserted: on a loaded machine that is the budget doing its job.)
      expect(thinks / (11 * 20)).toBeGreaterThan(4);
      expect(thinks / (11 * 20)).toBeLessThan(12);
    });
    // The whole server tick (match, snapshots, culling, 11 bots): measured ~0.1-0.3 ms of CPU on an M1.
    expect(cpuPerLobbyTick).toBeLessThan(3 * TIME_SLACK);
  });
});
