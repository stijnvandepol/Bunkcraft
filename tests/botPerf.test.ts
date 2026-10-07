import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SimClock, SimLobby } from './helpers/botServer';
import { TIME_SLACK } from './helpers/timing';

/**
 * Bots must cost little: three lobbies of 1 person + 11 bots each, 20 simulated seconds at 30 Hz. The full numbers
 * (more lobbies, longer, percentiles) come from `npx tsx scripts/bench-bots.ts`.
 */
const clock: SimClock = { ms: 1_700_000_000_000 };
const lobbies: SimLobby[] = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock.ms); });
afterEach(() => {
  lobbies.splice(0).forEach((l) => l.dispose());
  vi.restoreAllMocks();
});

describe('bot tick cost', () => {
  it('11 bots per lobby stay well inside the 33 ms tick', () => {
    for (let i = 0; i < 3; i++) {
      const l = new SimLobby(clock, { gameType: i === 1 ? 'ctf' : 'tdm', map: i === 2 ? 'classic' : 'atomic', bots: { fill: 12, difficulty: 'hard' }, scoreLimit: 100, timeLimitSec: 1800, seed: String(i) });
      l.join(`Person${i}`);
      lobbies.push(l);
    }
    // Fill up, build the graphs, finish the warm-up.
    for (let t = 0; t < 30 * 12; t++) { clock.ms += 1000 / 30; for (const l of lobbies) l.tick(); }
    for (const l of lobbies) expect(l.bots.count).toBe(11);
    const before = lobbies.map((l) => ({ ...l.bots.perf }));
    const ticks: number[] = [];
    for (let t = 0; t < 30 * 20; t++) {
      clock.ms += 1000 / 30;
      for (const l of lobbies) {
        const t0 = performance.now();
        l.tick();
        ticks.push(performance.now() - t0);
      }
    }
    lobbies.forEach((l, i) => {
      const p = l.bots.perf, b = before[i];
      const avg = (p.totalMs - b.totalMs) / (p.ticks - b.ticks);
      // Measured ~0.1-0.4 ms per lobby tick for 11 bots on an M1; generous for busy CI machines.
      expect(avg).toBeLessThan(2 * TIME_SLACK);
      // Thinking is spread: hardly any think is pushed to a later tick by the budget.
      expect(p.skippedThinks - b.skippedThinks).toBeLessThan((p.thinks - b.thinks) * 0.1 + 5);
    });
    // Whole server ticks (match, snapshots, bots): the 99th percentile far below the 33 ms tick. Not the maximum: one
    // garbage collection or a descheduled process on a busy machine says nothing about the bots.
    ticks.sort((a, b) => a - b);
    expect(ticks[Math.floor(ticks.length * 0.99)]).toBeLessThan(15 * TIME_SLACK);
  });
});
