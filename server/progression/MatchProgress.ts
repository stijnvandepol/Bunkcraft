import type { ClassSpec } from '../../src/modes/Loadouts';
import { parseRank } from '../../src/modes/progression/Levels';
import type { MatchOutcome, MatchResultKind } from '../../src/modes/progression/XpRules';
import { lockClass } from '../../src/modes/progression/Unlocks';
import type { ServerMessage } from '../../src/net/protocol';
import type { Match, MatchHost } from '../Match';
import type { MatchResult } from '../modes/ModeLogic';
import { MatchRecorder } from './MatchRecorder';
import type { ProfileService } from './ProfileService';

/** Reports of matches that ended while the player was away are kept this long (ms) for when they come back. */
const PENDING_REPORT_MS = 10 * 60_000;
type Report = NonNullable<ReturnType<ProfileService['award']>>;

/** What MatchProgress needs from the game server. */
export interface ProgressHost {
  match(): Match;
  /** Wall clock in seconds (the match clock). */
  now(): number;
  send(id: number, msg: ServerMessage): void;
}

/**
 * Glue between one arcade game and the profile service: binds connected players to their profiles, feeds the
 * MatchRecorder from the Match hooks, grants XP exactly once per player and match (at the end, or when the
 * player leaves a live match), keeps the roster ranks current and keeps Create-a-Class within the unlocks.
 * Players without a profile (guests, bots) are counted by nobody and earn nothing.
 */
export class MatchProgress {
  readonly recorder = new MatchRecorder((id) => this.host.match().players.get(id)?.bot === true);
  /** Most human players seen in this match: below MIN_HUMANS it is a bot lobby and pays less (XpRules). */
  private peakHumans = 0;
  /** Connected player id → profile id. */
  private readonly profiles = new Map<number, string>();
  /** Player id → profile id of players whose connection dropped and whose seat is kept (see Match.parked). */
  private readonly away = new Map<number, string>();
  /** Profile id → the XP report of a match that ended while they were away, shown when they are back. */
  private readonly pending = new Map<string, { report: Report; at: number }>();

  constructor(private readonly service: ProfileService, private readonly host: ProgressHost) {}

  /** The Match hooks that feed the recorder (spread into the MatchHost). */
  hooks(): Pick<MatchHost, 'onMatchStart' | 'onDamage' | 'onKill' | 'onObjective' | 'onMatchEnd' | 'onParkedExpired'> {
    return {
      onMatchStart: () => {
        this.peakHumans = 0;
        this.countHumans();
        this.recorder.start(this.host.match().players.keys(), this.host.now());
      },
      onDamage: (a, v, _amount, weapon) => this.recorder.damage(a, v, weapon, this.host.now()),
      onKill: (k, v, weapon, head) => this.recorder.kill(k || null, v, weapon, head, this.host.now()),
      onObjective: (id, kind, amount) => this.recorder.objective(id, kind, amount),
      onMatchEnd: (r) => this.end(r),
      onParkedExpired: (id) => this.expire(id),
    };
  }

  /**
   * A player joined with a profile token: the profile id when the token is valid, the profile exists and nobody
   * in this game already plays on it (two tabs in one lobby would double the XP); null otherwise.
   */
  bind(id: number, token: unknown, name: string): string | null {
    const pid = this.service.verify(token);
    if (!pid || !this.service.get(pid)) return null;
    for (const other of this.profiles.values()) if (other === pid) return null;
    for (const other of this.away.values()) if (other === pid) return null; // that profile has a kept seat: its owner comes back to it
    this.attach(id, pid, name);
    return pid;
  }

  private attach(id: number, pid: string, name: string): void {
    this.profiles.set(id, pid);
    this.service.seen(pid, name);
    const p = this.host.match().players.get(id);
    if (p) p.rank = this.service.rank(pid);
    this.recorder.join(id, this.host.now());
    this.countHumans();
  }

  /** Sends the XP report of a match that ended while this player was away (once the connection is registered). */
  flushReport(id: number): void {
    const pid = this.profiles.get(id);
    const waiting = pid ? this.pending.get(pid) : undefined;
    if (!pid || !waiting) return;
    this.pending.delete(pid);
    this.host.send(id, { t: 'progress', report: waiting.report });
  }

  /** The profile whose seat is kept under this player id, if any. */
  profileAway(id: number): string | undefined {
    return this.away.get(id);
  }

  /**
   * The player's connection dropped and their seat is kept: the tally stays (its clock stops), the profile stays
   * theirs. Nothing is granted yet: that happens at the end of the match, or when the seat is given up.
   */
  park(id: number): void {
    const pid = this.profiles.get(id);
    this.profiles.delete(id);
    if (pid) this.away.set(id, pid);
    this.recorder.pause(id, this.host.now());
    this.countHumans();
  }

  /** The player came back to their kept seat: same profile, same tally, the time away not counted. */
  unpark(id: number, name: string): void {
    const pid = this.away.get(id);
    this.away.delete(id);
    this.recorder.resume(id, this.host.now());
    if (pid && this.service.get(pid)) this.attach(id, pid, name);
    else this.recorder.join(id, this.host.now());
  }

  profileOf(id: number): string | undefined {
    return this.profiles.get(id);
  }

  /** The profile a token belongs to (signed by this server and still existing), or null. */
  verify(token: unknown): string | null {
    const pid = this.service.verify(token);
    return pid && this.service.get(pid) ? pid : null;
  }

  /** Notes how many humans (everyone but bots) are in the match now. */
  private countHumans(): void {
    let n = 0;
    for (const p of this.host.match().players.values()) if (!p.bot) n++;
    this.peakHumans = Math.max(this.peakHumans, n);
  }

  /** A fired shot (live phase only): accuracy per weapon. */
  shot(shooter: number, weapon: string, hit: boolean): void {
    if (this.host.match().phase === 'live') this.recorder.shot(shooter, weapon, hit);
  }

  /** A class request within the player's unlocks (fields the request leaves out keep the current choice). */
  lockClass(id: number, req: { primary: string; secondary?: string; optic?: string; perk?: string }): ClassSpec {
    const cur = this.host.match().players.get(id)?.next;
    const rank = parseRank(this.service.rank(this.profiles.get(id))) ?? { level: 1, prestige: 0 };
    const keepOptic = req.optic === undefined && cur && req.primary === cur.primary;
    return lockClass({
      primary: req.primary, secondary: req.secondary ?? cur?.secondary, optic: keepOptic ? cur!.optic : req.optic, perk: req.perk ?? cur?.perk,
    }, rank);
  }

  /** A player leaves: a live match still pays what they did (no completion or win bonus). */
  leave(id: number): void {
    const pid = this.profiles.get(id);
    this.profiles.delete(id);
    this.countHumans();
    const taken = this.recorder.take(id, this.host.now());
    const m = this.host.match();
    if (!pid || !taken || !this.recorder.counting || m.phase === 'warmup' || m.phase === 'ended') return;
    this.grant(id, pid, taken.tally, { mode: m.def.id, map: m.map.id, result: 'loss', completed: false, humans: this.peakHumans }, false);
  }

  /** A kept seat ran out: what the player did in the live match is paid like a player who left it (no completion or win bonus). */
  private expire(id: number): void {
    const pid = this.away.get(id);
    this.away.delete(id);
    const taken = this.recorder.take(id, this.host.now());
    const m = this.host.match();
    if (m.players.size === 0 && m.parked.size === 0) this.recorder.stop();
    if (!pid || !taken || !this.recorder.counting || m.phase === 'warmup' || m.phase === 'ended') return;
    this.grant(id, pid, taken.tally, { mode: m.def.id, map: m.map.id, result: 'loss', completed: false, humans: this.peakHumans }, false);
  }

  /** The server stops: nobody's tally may be lost with it (connected players and kept seats alike). */
  settleAll(): void {
    for (const id of [...this.away.keys()]) this.expire(id);
    for (const id of [...this.profiles.keys()]) this.leave(id);
  }

  /** The match is over: everybody still in it, kept seats included, gets their XP, once. */
  private end(r: MatchResult): void {
    const m = this.host.match();
    const now = this.host.now();
    this.countHumans();
    const ids = this.recorder.ids();
    for (const id of ids) {
      const taken = this.recorder.take(id, now);
      const live = m.players.get(id);
      const seat = m.parked.get(id);
      const team = live ? live.team : seat?.team;
      const pid = this.profiles.get(id) ?? this.away.get(id);
      if (!taken || !pid || team === undefined) continue;
      const result: MatchResultKind = !r.winnerTeam && !r.winnerId ? 'draw'
        : (r.winnerTeam ? team === r.winnerTeam : r.winnerId === id) ? 'win' : 'loss';
      // A kept seat's player is not connected: their report waits for them.
      this.grant(id, pid, taken.tally, { mode: m.def.id, map: m.map.id, result, completed: taken.completed, humans: this.peakHumans }, !!live);
    }
    this.recorder.stop();
    m.broadcastRoster();
  }

  private grant(id: number, pid: string, tally: Parameters<ProfileService['award']>[1], outcome: MatchOutcome, connected: boolean): void {
    const report = this.service.award(pid, tally, outcome);
    if (!report) return;
    const p = this.host.match().players.get(id);
    if (p) p.rank = this.service.rank(pid);
    if (connected) {
      this.host.send(id, { t: 'progress', report });
      return;
    }
    // Away (a kept seat or a seat just given up): keep the report for the next time this profile is in the lobby.
    const now = Date.now();
    for (const [key, v] of this.pending) if (now - v.at > PENDING_REPORT_MS) this.pending.delete(key);
    this.pending.set(pid, { report, at: now });
  }
}
