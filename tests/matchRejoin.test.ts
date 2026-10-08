import type { Team } from "../src/modes/GameTypes";
import { describe, expect, it } from 'vitest';
import { COMBAT_LOG_SECONDS, ENDED_SECONDS, type ParkRequest, REJOIN_RESPAWN_SECONDS, SPAWN_PROTECTION, WARMUP_SECONDS } from '../server/Match';
import { RESPAWN_SECONDS } from '../src/modes/Weapons';
import { type Setup, live, setup, shootDead, started } from './helpers/matchHost';

const GRACE = 120;
/** Kills the victim `n` times, waiting out the respawn in between. */
function killTimes(s: Setup, killer: number, victim: number, n: number): void {
  for (let i = 0; i < n; i++) {
    shootDead(s, killer, victim);
    s.advance(RESPAWN_SECONDS + 1.5);
  }
}

const keep = (token: string, limit = 6): ParkRequest => ({ proof: { token }, graceSec: GRACE, limit });

/** Counts the seats that were given up (time ran out, or room was needed). */
function watchExpiry(s: Setup): number[] {
  const ids: number[] = [];
  (s.host as unknown as { onParkedExpired: (id: number) => void }).onParkedExpired = (id) => ids.push(id);
  return ids;
}

describe('a match keeps the seat of a player whose connection dropped', () => {
  it('keeps team, score, class and streak, and gives them back on a rejoin', () => {
    const s = live('tdm', 4);
    const alice = s.match.players.get(1)!;
    s.match.setLoadout(1, 'smg', 'revolver', 'iron', 'ninja');
    killTimes(s, 1, 2, 2);
    expect(alice.kills).toBe(2);
    const team = alice.team as Team;
    const next = { ...alice.next };
    const streak = alice.streak;
    const deaths = alice.deaths;

    const kept = s.match.leave(1, keep('tok'))!;
    expect(kept).toMatchObject({ id: 1, name: 'p1', team, kills: 2, deaths, streak });
    expect(s.match.players.has(1)).toBe(false);
    // The seat is somebody's: the team still counts it when it picks a side for a newcomer or balances.
    expect(s.match.seatedTeamSize(team)).toBe(s.match.teamSize(team) + 1);

    const back = s.match.join(1, 'p1', false, s.match.parked.get(1));
    expect(s.match.parked.size).toBe(0);
    expect(back).toMatchObject({ id: 1, team, kills: 2, deaths, streak });
    expect(back.next).toEqual(next);
    expect(back.next.perk).toBe('ninja');
  });

  it('puts a returning player on a fresh life that starts only after a short wait (no free heal or reload)', () => {
    const s = live('tdm');
    s.match.leave(1, keep('t'));
    s.advance(10);
    const back = s.match.join(1, 'p1', false, s.match.parked.get(1));
    s.match.ready(1);
    expect(back.alive).toBe(false);
    s.advance(REJOIN_RESPAWN_SECONDS - 0.5);
    expect(back.alive).toBe(false);
    s.advance(1);
    expect(back.alive).toBe(true);
    expect(back.health).toBe(100);
    // Spawn protection is the normal one of a respawn, not more.
    expect(back.protectedUntil - s.host.t).toBeLessThanOrEqual(SPAWN_PROTECTION);
    expect(back.deaths).toBe(0);
  });

  it('does not let a drop in the middle of a fight dodge the death', () => {
    const s = live('ffa');
    const bob = s.match.players.get(2)!;
    bob.health = 20;
    bob.lastDamageAt = s.host.t - 1;
    s.match.leave(2, keep('t'));
    const back = s.match.join(2, 'p2', false, s.match.parked.get(2));
    expect(back.deaths).toBe(1);
    expect(back.streak).toBe(0);
  });

  it('does not charge a death to a player who dropped when nothing was happening', () => {
    const s = live('ffa');
    s.advance(COMBAT_LOG_SECONDS + 1);
    s.match.leave(2, keep('t'));
    expect(s.match.join(2, 'p2', false, s.match.parked.get(2)).deaths).toBe(0);
  });

  it('keeps the respawn a dead player was waiting for', () => {
    const s = live('ffa');
    shootDead(s, 1, 2);
    const left = s.match.players.get(2)!.respawnAt - s.host.t;
    expect(left).toBeGreaterThan(0);
    s.match.leave(2, keep('t'));
    const back = s.match.join(2, 'p2', false, s.match.parked.get(2));
    expect(back.deaths).toBe(1);
    expect(back.alive).toBe(false);
    expect(back.respawnAt - s.host.t).toBeGreaterThanOrEqual(Math.max(left, REJOIN_RESPAWN_SECONDS) - 0.01);
  });

  it('gun game: the level (and so the weapon) comes back', () => {
    const s = live('gungame', 2);
    killTimes(s, 1, 2, 2);
    const level = s.match.players.get(1)!.pts;
    expect(level).toBeGreaterThanOrEqual(2);
    s.match.leave(1, keep('t'));
    const back = s.match.join(1, 'p1', false, s.match.parked.get(1));
    expect(back.pts).toBe(level);
    expect(s.match.logic.loadoutFor?.(s.match, back)?.primary).toBe(back.primary);
  });

  it('frees the seat when the grace period ends, and tells whoever tracks the XP', () => {
    const s = live('tdm', 4);
    const expired = watchExpiry(s);
    const team = s.match.players.get(3)!.team as Team;
    s.match.leave(3, keep('t'));
    expect(s.match.parked.size).toBe(1);
    expect(s.match.seatSecondsLeft(3)).toBe(GRACE);
    s.advance(GRACE - 2);
    expect(s.match.parked.size).toBe(1);
    expect(expired).toEqual([]);
    s.advance(3);
    expect(s.match.parked.size).toBe(0);
    expect(expired).toEqual([3]);
    expect(s.match.seatedTeamSize(team)).toBe(s.match.teamSize(team));
    // Too late: the player is just a newcomer now.
    expect(s.match.join(3, 'p3').kills).toBe(0);
  });

  it('a seat that was never kept (a bot, no room, no grace) is free at once', () => {
    const s = live('ffa');
    expect(s.match.leave(1)).toBeNull();
    expect(s.match.parked.size).toBe(0);
    s.match.join(9, 'robot', true);
    expect(s.match.leave(9, keep('t'))).toBeNull();
    expect(s.match.leave(2, { proof: { token: 't' }, graceSec: 0, limit: 6 })).toBeNull();
    expect(s.match.parked.size).toBe(0);
  });

  it('keeps the teams even: a newcomer does not take the side a dropped player will come back to', () => {
    const s = started('tdm', 4);
    const red = [...s.match.players.values()].filter((p) => p.team === 'red');
    s.match.leave(red[0].id, keep('t'));
    s.match.leave(red[1].id, keep('t2'));
    // Two kept seats on red: red 2/blue 2 when counted, so the newcomer goes to the side with fewer, not to "red because it is empty".
    expect(s.match.seatedTeamSize('red')).toBe(2);
    expect(s.match.seatedTeamSize('blue')).toBe(2);
    const a = s.match.join(20, 'newA');
    const b = s.match.join(21, 'newB');
    expect(new Set([a.team, b.team]).size).toBe(2);
    // The two who were away still fit their side.
    s.match.join(red[0].id, 'x', false, s.match.parked.get(red[0].id));
    expect(s.match.players.get(red[0].id)!.team).toBe('red');
  });

  it('gives up the oldest seat when a lobby keeps more than its limit', () => {
    const s = live('ffa', 4);
    const expired = watchExpiry(s);
    s.match.leave(1, keep('a', 2));
    s.match.leave(2, keep('b', 2));
    s.match.leave(3, keep('c', 2));
    expect([...s.match.parked.keys()]).toEqual([2, 3]);
    expect(expired).toEqual([1]);
  });

  it('a new match starts from nothing for kept seats too, and they are placed again', () => {
    const s = live('tdm', 4, 2, 600);
    watchExpiry(s);
    shootDead(s, 1, 2);
    const killer = s.match.players.get(1)!;
    const victimTeam = s.match.players.get(2)!.team;
    s.match.leave(1, keep('t'));
    expect(s.match.parked.get(1)!.kills).toBe(1);
    shootDead(s, 3, 4);
    shootDead(s, 3, 4);
    s.advance(ENDED_SECONDS + 0.5);
    expect(s.match.phase).toBe('warmup');
    const seat = s.match.parked.get(1)!;
    expect(seat).toMatchObject({ kills: 0, deaths: 0, pts: 0, streak: 0, team: '' });
    const back = s.match.join(1, 'p1', false, seat);
    expect(back.kills).toBe(0);
    expect(back.next).toEqual(killer.next);
    expect(['red', 'blue']).toContain(back.team);
    expect(victimTeam).toBeTruthy();
  });

  it('with only kept seats left the match stands still, and an expired empty lobby starts over', () => {
    const s = live('ffa', 2, 50, 300);
    watchExpiry(s);
    const before = s.match.timeLeft();
    s.match.leave(1, keep('a'));
    s.match.leave(2, keep('b'));
    expect(s.match.phase).toBe('live');
    s.advance(60);
    expect(s.match.phase).toBe('live');
    expect(s.match.timeLeft()).toBeGreaterThanOrEqual(before - 1);
    s.advance(GRACE);
    expect(s.match.parked.size).toBe(0);
    expect(s.match.phase).toBe('warmup');
  });

  it('a kept seat of a round mode comes back as a spectator for the rest of the round', () => {
    const s = live('elimination', 4);
    s.advance(12);
    expect(s.match.phase).toBe('live');
    const alice = s.match.players.get(1)!;
    expect(alice.alive).toBe(true);
    s.match.leave(1, keep('t'));
    const back = s.match.join(1, 'p1', false, s.match.parked.get(1));
    expect(back.alive).toBe(false);
    expect(back.respawnAt).toBe(Infinity);
  });

  it('warm-up is a normal place to drop from: nothing is lost and the match is not started for one', () => {
    const s = setup('tdm');
    s.match.join(1, 'a'); s.match.ready(1);
    s.match.join(2, 'b'); s.match.ready(2);
    s.advance(WARMUP_SECONDS / 2);
    s.match.leave(2, keep('t'));
    s.advance(WARMUP_SECONDS);
    expect(s.match.phase).toBe('warmup');
    s.match.join(2, 'b', false, s.match.parked.get(2));
    s.match.ready(2);
    s.advance(WARMUP_SECONDS + 0.5);
    expect(s.match.phase).toBe('live');
  });
});
