import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { GameType } from '../src/modes/GameTypes';
import {
  LEADER_AWAY_MS, MAX_PARTY, MEMBER_DROP_MS, MEMBER_ONLINE_MS, PARTY_CODE_LENGTH, PARTY_IDLE_MS, type PartyError, type PartyMemberView, type PartyStatus,
  type PartyTicket, type PartyView, TICKET_MS, normalizePartyCode,
} from '../src/modes/Party';
import { CODE_ALPHABET, NAME_PATTERN } from '../src/net/protocol';

/**
 * Parties on the server: friends group up with a short code, the leader picks the mode and presses PLAY, and the
 * whole party goes into one lobby (see Rooms.quickPlay for the seats). Everything lives in memory and expires: a
 * party is gone when nobody has polled it for a while, a member that stays away is dropped, a leader that stays
 * away hands over the crown. No accounts and no personal data: a member is a gamertag, an optional profile id (for
 * the rank icon and to find the party again after a reload) and a random token that only its own browser holds.
 *
 * Clients poll (`view`); the server never pushes. The pure rules sit here, with an injectable clock, so they are
 * unit tested without sockets (tests/party.test.ts); server/App.ts adds the HTTP API and the rate limits.
 */

export type PartyResult<T = object> = ({ ok: true } & T) | { ok: false; error: PartyError; message: string };

interface Member {
  id: string;
  tokenHash: string;
  name: string;
  profileId?: string;
  ready: boolean;
  status: PartyStatus;
  joinedAt: number;
  seenAt: number;
}

interface Ticket { id: number; code: string; gameType: GameType; key: string; expires: number }

interface Party {
  id: string;
  code: string;
  leader: string;
  mode: GameType;
  members: Member[];
  seq: number;
  ticket: Ticket | null;
  ticketSeq: number;
}

export interface PartyServiceOptions {
  /** Clock in milliseconds (tests move it). */
  now?: () => number;
  /** Most parties kept at once (default 2000). */
  maxParties?: number;
  /** Rank code of a profile (0 = unknown), for the rank icon. */
  rank?: (profileId: string) => number;
  /** A ticket's seats are not needed any more (the party picked another lobby, or disbanded): give them back. */
  release?: (code: string, key: string) => void;
}

/** What the lobby finder is asked: seats for `size` people, held under `key`, for the party with this id. */
export interface SeatRequest { key: string; party: string; size: number; ttlMs: number }

const fail = (error: PartyError, message: string): { ok: false; error: PartyError; message: string } => ({ ok: false, error, message });
const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export class PartyService {
  private readonly parties = new Map<string, Party>();
  private readonly byCode = new Map<string, Party>();
  private readonly byToken = new Map<string, { party: Party; member: Member }>();
  private readonly byProfile = new Map<string, Party>();
  /** Tokens of members the leader removed, so they learn why they are out instead of "no party". */
  private readonly kicked = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxParties: number;

  constructor(private readonly opts: PartyServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxParties = opts.maxParties ?? 2000;
  }

  get count(): number {
    return this.parties.size;
  }

  // ---------------------------------------------------------------- joining and leaving

  /** A new party with the caller as leader; the token is shown once. */
  create(name: unknown, mode: GameType, profileId?: string): PartyResult<{ token: string; view: PartyView }> {
    const clean = this.cleanName(name);
    if (!clean) return fail('name', 'Pick a name of 3-16 letters, digits or underscores first');
    this.sweep();
    if (this.parties.size >= this.maxParties) return fail('unavailable', 'There are too many parties right now, try again later');
    if (profileId) this.leaveProfile(profileId);
    const now = this.now();
    const party: Party = { id: randomBytes(6).toString('hex'), code: this.freshCode(), leader: '', mode, members: [], seq: 1, ticket: null, ticketSeq: 0 };
    const { member, token } = this.addMember(party, clean, profileId, now);
    party.leader = member.id;
    this.parties.set(party.id, party);
    this.byCode.set(party.code, party);
    return { ok: true, token, view: this.viewOf(party, member, now) };
  }

  /** Joins a party by its code (or comes back to it: the same profile gets a fresh token and keeps its place). */
  join(rawCode: string, name: unknown, profileId?: string): PartyResult<{ token: string; view: PartyView }> {
    const code = normalizePartyCode(String(rawCode ?? ''));
    const clean = this.cleanName(name);
    if (!clean) return fail('name', 'Pick a name of 3-16 letters, digits or underscores first');
    const party = code ? this.byCode.get(code) : undefined;
    if (!party) return fail('not_found', 'Party not found. Check the code.');
    const now = this.now();
    this.upkeep(party, now);
    if (!this.parties.has(party.id)) return fail('not_found', 'Party not found. Check the code.');
    const again = profileId ? party.members.find((m) => m.profileId === profileId) : undefined;
    if (again) return this.reissue(party, again, clean, now);
    if (party.members.length >= MAX_PARTY) return fail('full', `This party is full (${MAX_PARTY} players)`);
    if (party.members.some((m) => m.name.toLowerCase() === clean.toLowerCase())) return fail('name', 'Somebody in this party already has that name');
    if (profileId) this.leaveProfile(profileId);
    const { member, token } = this.addMember(party, clean, profileId, now);
    party.seq++;
    return { ok: true, token, view: this.viewOf(party, member, now) };
  }

  /** The party of a profile (after the sessionStorage token is lost: another tab, a browser restart), with a fresh token. */
  resume(profileId: string, name: unknown): PartyResult<{ token: string; view: PartyView }> {
    const party = this.byProfile.get(profileId);
    const member = party?.members.find((m) => m.profileId === profileId);
    if (!party || !member) return fail('no_party', 'You are not in a party');
    return this.reissue(party, member, this.cleanName(name) ?? member.name, this.now());
  }

  leave(token: string): PartyResult {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    this.removeMember(hit.party, hit.member);
    return { ok: true };
  }

  kick(token: string, memberId: string): PartyResult {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    if (hit.party.leader !== hit.member.id) return fail('forbidden', 'Only the party leader can remove players');
    const target = hit.party.members.find((m) => m.id === memberId);
    if (!target || target === hit.member) return fail('not_found', 'That player is not in the party');
    this.kicked.set(target.tokenHash, this.now());
    this.removeMember(hit.party, target);
    return { ok: true };
  }

  /** The leader hands the crown to somebody else. */
  promote(token: string, memberId: string): PartyResult {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    if (hit.party.leader !== hit.member.id) return fail('forbidden', 'Only the party leader can do that');
    const target = hit.party.members.find((m) => m.id === memberId);
    if (!target || target === hit.member) return fail('not_found', 'That player is not in the party');
    hit.party.leader = target.id;
    hit.party.seq++;
    return { ok: true };
  }

  // ---------------------------------------------------------------- state

  /** The party as this member sees it. Every call counts as the member being here; `status` says where (menu or in a match). */
  view(token: string, status?: PartyStatus): PartyResult<{ view: PartyView }> {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    const now = this.now();
    hit.member.seenAt = now;
    if (status && status !== hit.member.status) {
      hit.member.status = status;
      hit.party.seq++;
    }
    this.upkeep(hit.party, now);
    // upkeep may have promoted somebody or (never for the caller, who was just seen) removed others.
    return { ok: true, view: this.viewOf(hit.party, hit.member, now) };
  }

  setReady(token: string, ready: boolean): PartyResult<{ view: PartyView }> {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    const now = this.now();
    hit.member.seenAt = now;
    if (hit.member.ready !== ready) {
      hit.member.ready = ready;
      hit.party.seq++;
    }
    return { ok: true, view: this.viewOf(hit.party, hit.member, now) };
  }

  /** The leader's pick of mode: what PLAY starts, and what everybody sees selected. */
  setMode(token: string, mode: GameType): PartyResult<{ view: PartyView }> {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    if (hit.party.leader !== hit.member.id) return fail('forbidden', 'Only the party leader picks the mode');
    const now = this.now();
    hit.member.seenAt = now;
    if (hit.party.mode !== mode) {
      hit.party.mode = mode;
      hit.party.seq++;
    }
    return { ok: true, view: this.viewOf(hit.party, hit.member, now) };
  }

  // ---------------------------------------------------------------- playing

  /**
   * The leader takes the party into a lobby. `find` gets the seats to hold (one per member that is here) and
   * answers with the lobby it found or opened, or an error; on success every member's next poll carries a
   * ticket for it, and everybody's ready flag is cleared for the next round.
   */
  play(
    token: string,
    find: (seats: SeatRequest) => { code: string; gameType: GameType } | { error: PartyError; message: string },
  ): PartyResult<{ view: PartyView; ticket: PartyTicket }> {
    const hit = this.lookup(token);
    if (!hit.ok) return hit;
    const { party, member } = hit;
    if (party.leader !== member.id) return fail('forbidden', 'Only the party leader can start the match');
    const now = this.now();
    member.seenAt = now;
    this.upkeep(party, now);
    // Members that went away, or are still in another match, are not waited for or given seats.
    const size = party.members.filter((m) => m.id === member.id || (m.status === 'menu' && now - m.seenAt <= MEMBER_ONLINE_MS)).length;
    const key = randomBytes(16).toString('hex');
    const previous = party.ticket;
    const found = find({ key, party: party.id, size, ttlMs: TICKET_MS });
    if ('error' in found) return fail(found.error, found.message);
    if (previous) this.opts.release?.(previous.code, previous.key);
    party.ticket = { id: ++party.ticketSeq, code: found.code, gameType: found.gameType, key, expires: now + TICKET_MS };
    party.mode = found.gameType;
    for (const m of party.members) m.ready = false;
    party.seq++;
    const view = this.viewOf(party, member, now);
    return { ok: true, view, ticket: view.ticket! };
  }

  // ---------------------------------------------------------------- housekeeping

  /** Drops absent members, hands over the crown, and removes parties nobody polls any more. Returns the parties removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const party of [...this.parties.values()]) {
      this.upkeep(party, now);
      if (!this.parties.has(party.id)) { removed++; continue; }
      const last = Math.max(...party.members.map((m) => m.seenAt));
      if (now - last > PARTY_IDLE_MS) {
        this.disband(party);
        removed++;
      }
    }
    for (const [h, at] of this.kicked) if (now - at > 120_000) this.kicked.delete(h);
    return removed;
  }

  /** Gives every held ticket back (shutdown). */
  close(): void {
    for (const p of [...this.parties.values()]) this.disband(p);
  }

  // ---------------------------------------------------------------- internals

  private cleanName(name: unknown): string | null {
    return typeof name === 'string' && NAME_PATTERN.test(name) ? name : null;
  }

  private freshCode(): string {
    for (;;) {
      const code = Array.from({ length: PARTY_CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (!this.byCode.has(code)) return code;
    }
  }

  private addMember(party: Party, name: string, profileId: string | undefined, now: number): { member: Member; token: string } {
    const token = randomBytes(24).toString('base64url');
    const member: Member = {
      id: randomBytes(4).toString('hex'), tokenHash: hashOf(token), name, ...(profileId ? { profileId } : {}),
      ready: false, status: 'menu', joinedAt: now, seenAt: now,
    };
    party.members.push(member);
    this.byToken.set(member.tokenHash, { party, member });
    if (profileId) this.byProfile.set(profileId, party);
    return { member, token };
  }

  /** The same person comes back: the old token stops working, the place in the party stays. */
  private reissue(party: Party, member: Member, name: string, now: number): PartyResult<{ token: string; view: PartyView }> {
    this.byToken.delete(member.tokenHash);
    const token = randomBytes(24).toString('base64url');
    member.tokenHash = hashOf(token);
    member.seenAt = now;
    if (member.name !== name && !party.members.some((m) => m !== member && m.name.toLowerCase() === name.toLowerCase())) member.name = name;
    this.byToken.set(member.tokenHash, { party, member });
    party.seq++;
    return { ok: true, token, view: this.viewOf(party, member, now) };
  }

  private lookup(token: string): { ok: true; party: Party; member: Member } | { ok: false; error: PartyError; message: string } {
    const h = typeof token === 'string' && token.length > 0 && token.length <= 128 ? hashOf(token) : '';
    const hit = h ? this.byToken.get(h) : undefined;
    if (!hit) {
      return h && this.kicked.has(h) ? fail('forbidden', 'You were removed from the party') : fail('no_party', 'You are not in a party');
    }
    return { ok: true, party: hit.party, member: hit.member };
  }

  private leaveProfile(profileId: string): void {
    const party = this.byProfile.get(profileId);
    const member = party?.members.find((m) => m.profileId === profileId);
    if (party && member) this.removeMember(party, member);
    this.byProfile.delete(profileId);
  }

  private removeMember(party: Party, member: Member): void {
    party.members = party.members.filter((m) => m !== member);
    this.byToken.delete(member.tokenHash);
    if (member.profileId && this.byProfile.get(member.profileId) === party) this.byProfile.delete(member.profileId);
    if (party.members.length === 0) { this.disband(party); return; }
    if (party.leader === member.id) this.crown(party, this.now());
    party.seq++;
  }

  /** The crown goes to the member who has been in the party longest, online ones first. */
  private crown(party: Party, now: number): void {
    const pool = party.members.filter((m) => now - m.seenAt <= MEMBER_ONLINE_MS);
    const next = [...(pool.length ? pool : party.members)].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) party.leader = next.id;
  }

  private upkeep(party: Party, now: number): void {
    if (!this.parties.has(party.id)) return;
    for (const m of [...party.members]) {
      if (now - m.seenAt > MEMBER_DROP_MS) this.removeMember(party, m);
    }
    if (!this.parties.has(party.id)) return;
    const leader = party.members.find((m) => m.id === party.leader);
    if (leader && now - leader.seenAt > LEADER_AWAY_MS && party.members.some((m) => m !== leader && now - m.seenAt <= MEMBER_ONLINE_MS)) {
      this.crown(party, now);
      party.seq++;
    }
    if (party.ticket && party.ticket.expires <= now) party.ticket = null;
  }

  private disband(party: Party): void {
    if (party.ticket) this.opts.release?.(party.ticket.code, party.ticket.key);
    for (const m of party.members) {
      this.byToken.delete(m.tokenHash);
      if (m.profileId && this.byProfile.get(m.profileId) === party) this.byProfile.delete(m.profileId);
    }
    this.byCode.delete(party.code);
    this.parties.delete(party.id);
  }

  private viewOf(party: Party, me: Member, now: number): PartyView {
    const members: PartyMemberView[] = party.members.map((m) => ({
      id: m.id, name: m.name, rank: m.profileId ? this.opts.rank?.(m.profileId) ?? 0 : 0, leader: m.id === party.leader,
      // The leader starts the match, so the leader is always ready.
      ready: m.id === party.leader || m.ready, online: now - m.seenAt <= MEMBER_ONLINE_MS, status: m.status,
    }));
    const t = party.ticket && party.ticket.expires > now ? party.ticket : null;
    return {
      code: party.code, seq: party.seq, max: MAX_PARTY, leader: party.leader, me: me.id, mode: party.mode, members,
      ...(t ? { ticket: { id: t.id, code: t.code, gameType: t.gameType, key: t.key, ttlMs: t.expires - now } } : {}),
    };
  }
}
