/**
 * Minecraft-style goal AI: a mob owns a prioritised list of goals. Each tick the selector stops goals that can no
 * longer continue, starts the first goal (lowest priority number) that can use the mob and does not collide on
 * control flags with a running goal of equal or higher priority, and ticks the running ones.
 */

/** Control flags: two goals that share a flag never run together (the lower priority number wins). */
export const FLAG = { MOVE: 1, LOOK: 2, JUMP: 4, TARGET: 8 } as const;

export interface Goal {
  readonly flags: number;
  /** Whether the goal wants to start. Called every tick while it is not running, so keep it cheap. */
  canUse(): boolean;
  /** Whether a running goal carries on (defaults to canUse). */
  canContinue?(): boolean;
  /** False = a goal of higher priority may not interrupt it while running (default true). */
  interruptible?: boolean;
  start?(): void;
  tick?(): void;
  stop?(): void;
}

interface Entry {
  priority: number;
  goal: Goal;
  running: boolean;
}

export class GoalSelector {
  private readonly entries: Entry[] = [];
  /** Running entries in start order, kept in a flat array so the per-tick loop allocates nothing. */
  private readonly running: Entry[] = [];

  add(priority: number, goal: Goal): this {
    this.entries.push({ priority, goal, running: false });
    this.entries.sort((a, b) => a.priority - b.priority);
    return this;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Goals that are running right now (tests and the debug overlay). */
  runningGoals(): Goal[] {
    return this.running.map((e) => e.goal);
  }

  isRunning(goal: Goal): boolean {
    for (let i = 0; i < this.running.length; i++) if (this.running[i].goal === goal) return true;
    return false;
  }

  /** Stops everything (the mob died or changed brains). */
  clear(): void {
    for (let i = this.running.length - 1; i >= 0; i--) this.stopEntry(this.running[i]);
  }

  tick(): void {
    const run = this.running;
    for (let i = run.length - 1; i >= 0; i--) {
      const e = run[i];
      const g = e.goal;
      if (!(g.canContinue ? g.canContinue() : g.canUse())) this.stopEntry(e);
    }
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.running) continue;
      if (!this.mayStart(e) || !e.goal.canUse()) continue;
      // Goals that hold the same flags with a lower priority give way.
      for (let j = run.length - 1; j >= 0; j--) if (run[j].goal.flags & e.goal.flags) this.stopEntry(run[j]);
      e.running = true;
      run.push(e);
      e.goal.start?.();
    }
    for (let i = 0; i < run.length; i++) run[i].goal.tick?.();
  }

  /** No running goal with the same flags and equal or higher priority (or one that cannot be interrupted). */
  private mayStart(e: Entry): boolean {
    const run = this.running;
    for (let j = 0; j < run.length; j++) {
      const r = run[j];
      if (!(r.goal.flags & e.goal.flags)) continue;
      if (r.priority <= e.priority || r.goal.interruptible === false) return false;
    }
    return true;
  }

  private stopEntry(e: Entry): void {
    if (!e.running) return;
    e.running = false;
    const i = this.running.indexOf(e);
    if (i >= 0) this.running.splice(i, 1);
    e.goal.stop?.();
  }
}
