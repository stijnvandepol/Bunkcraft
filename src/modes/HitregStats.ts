/**
 * Hit registration statistics on the client (DOM-free): every shot records what the screen showed (the first other
 * player on the bullet's line, as drawn, and whether it was the head), then the server's verdict (`hit` with the
 * shot's `seq`). A shot is settled a moment after the server acknowledged it (`ammo` with its `seq`) or after a
 * second. The counts answer "how often does a shot that looked like a hit not count" (F3 overlay, QA scripts).
 */

/** Seconds after the acknowledgement before a shot without a `hit` counts as a miss (the `hit` follows at once). */
const SETTLE_AFTER_ACK = 0.25;
/** Shots never acknowledged (knife, a lost message) settle after this long. */
const SETTLE_TIMEOUT = 1.5;
const RING = 64;

export interface HitregCounts {
  /** Shots that looked like a hit on screen. */
  claimed: number;
  /** ...and the server agreed. */
  agreed: number;
  /** ...and the server said miss. */
  denied: number;
  /** Looked like a miss, the server said hit (generous hitboxes, spread luck). */
  surprise: number;
  /** Looked like a headshot; of those, how many the server counted as one. */
  headClaimed: number;
  headAgreed: number;
  /** All settled shots. */
  shots: number;
}

export class HitregStats {
  private readonly seq = new Int32Array(RING).fill(-1);
  private readonly firedAt = new Float64Array(RING);
  private readonly ackAt = new Float64Array(RING);
  private readonly claimed = new Int32Array(RING);
  private readonly claimedHead = new Uint8Array(RING);
  private readonly hit = new Uint8Array(RING);
  private readonly hitHead = new Uint8Array(RING);
  readonly counts: HitregCounts = { claimed: 0, agreed: 0, denied: 0, surprise: 0, headClaimed: 0, headAgreed: 0, shots: 0 };
  /** The last settled shots (QA): seq, claimed victim (−1 none), claimed head, server hit, server head. */
  readonly log: [number, number, boolean, boolean, boolean][] = [];
  /** Keep a log of settled shots (QA scripts turn it on). */
  logging = false;

  /** A shot went out: `victim` is the player id the screen showed on its line (−1 = none). */
  fired(seq: number, now: number, victim: number, head: boolean): void {
    const i = seq % RING;
    if (this.seq[i] >= 0) this.settle(i); // the ring wrapped: settle the old one first
    this.seq[i] = seq;
    this.firedAt[i] = now;
    this.ackAt[i] = -1;
    this.claimed[i] = victim;
    this.claimedHead[i] = head ? 1 : 0;
    this.hit[i] = 0;
    this.hitHead[i] = 0;
  }

  /** The server processed the shot (`ammo` with its seq). */
  acked(seq: number, now: number): void {
    const i = seq % RING;
    if (this.seq[i] === seq && this.ackAt[i] < 0) this.ackAt[i] = now;
  }

  /** The server counted a hit for the shot (`hit` with its seq). */
  confirmed(seq: number, head: boolean): void {
    const i = seq % RING;
    if (this.seq[i] !== seq) return;
    this.hit[i] = 1;
    if (head) this.hitHead[i] = 1;
  }

  /** Settles shots whose verdict is in (call now and then; cheap). */
  update(now: number): void {
    for (let i = 0; i < RING; i++) {
      if (this.seq[i] < 0) continue;
      const acked = this.ackAt[i] >= 0;
      if ((acked && now - this.ackAt[i] >= SETTLE_AFTER_ACK) || now - this.firedAt[i] >= SETTLE_TIMEOUT) this.settle(i);
    }
  }

  private settle(i: number): void {
    const c = this.counts;
    const claimed = this.claimed[i] >= 0, hit = this.hit[i] === 1;
    c.shots++;
    if (claimed) {
      c.claimed++;
      if (hit) c.agreed++; else c.denied++;
      if (this.claimedHead[i]) {
        c.headClaimed++;
        if (this.hitHead[i]) c.headAgreed++;
      }
    } else if (hit) c.surprise++;
    if (this.logging) {
      this.log.push([this.seq[i], this.claimed[i], this.claimedHead[i] === 1, hit, this.hitHead[i] === 1]);
      if (this.log.length > 5000) this.log.shift();
    }
    this.seq[i] = -1;
  }

  /** Share of on-screen hits the server denied (0..1), NaN before the first one. */
  get denyRate(): number {
    return this.counts.claimed > 0 ? this.counts.denied / this.counts.claimed : NaN;
  }

  reset(): void {
    this.seq.fill(-1);
    const c = this.counts;
    c.claimed = c.agreed = c.denied = c.surprise = c.headClaimed = c.headAgreed = c.shots = 0;
    this.log.length = 0;
  }
}
