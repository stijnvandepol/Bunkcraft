import type { GameType } from './GameTypes';
import { CODE_ALPHABET } from '../net/protocol';

/**
 * Parties: friends group up and queue together. Pure data and rules shared by the server (server/Parties.ts) and
 * the menu (src/net/PartyApi.ts, src/ui/PartyPanel.ts), so both agree and both can be unit tested.
 *
 * A party is short-lived server memory (no accounts, no personal data: a gamertag and a rank icon). Its leader
 * picks the mode and presses PLAY; the server finds (or opens) one lobby with room for the whole party, reserves
 * the seats and hands every member a ticket for it. Members that connect with the ticket's key land on the same team.
 */

/** Most people in one party. */
export const MAX_PARTY = 6;
/** Party codes are shorter than lobby codes (6) so the two can be told apart when typed into the same box. */
export const PARTY_CODE_LENGTH = 5;
const PARTY_CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${PARTY_CODE_LENGTH}}$`);

/** Normalises user input ("k7qm2", " K7Q-M2 ", an invite link with ?party=) to a party code, or null. */
export function normalizePartyCode(raw: string): string | null {
  const fromLink = /[?&]party=([^&#\s]+)/i.exec(raw)?.[1] ?? raw;
  const code = fromLink.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PARTY_CODE_PATTERN.test(code) ? code : null;
}

/** A member is "online" while its client polled within this many milliseconds. */
export const MEMBER_ONLINE_MS = 12_000;
/** The leader that is offline for this long hands the crown to an online member. */
export const LEADER_AWAY_MS = 20_000;
/** A member that was not seen for this long is removed (a closed tab; a reload comes back within seconds). */
export const MEMBER_DROP_MS = 5 * 60_000;
/** A party nobody polled for this long is gone. */
export const PARTY_IDLE_MS = 10 * 60_000;
/** Seats a ticket holds in its lobby, and how long a ticket can be used. */
export const TICKET_MS = 45_000;

export type PartyStatus = 'menu' | 'game';

/** What every member sees of another member (the id is public, the token that proves it is not). */
export interface PartyMemberView {
  id: string;
  name: string;
  /** Realms rank code (prestige * 100 + level, see modes/progression/Levels.ts); 0 = a guest without a profile. */
  rank: number;
  leader: boolean;
  ready: boolean;
  online: boolean;
  status: PartyStatus;
}

/** The way into the lobby the leader picked. `key` goes into the `hello` of the game connection. */
export interface PartyTicket {
  id: number;
  code: string;
  gameType: GameType;
  key: string;
  /** Milliseconds this ticket stays valid, counted from the moment the view was made. */
  ttlMs: number;
}

export interface PartyView {
  code: string;
  /** Changes whenever anything in the party changes. */
  seq: number;
  max: number;
  /** Member id of the leader and of the viewer. */
  leader: string;
  me: string;
  /** The mode PLAY starts (the leader's pick). */
  mode: GameType;
  members: PartyMemberView[];
  ticket?: PartyTicket;
}

/** Error codes of the party API (the message is for people, the code for the client). */
export type PartyError = 'no_party' | 'full' | 'name' | 'forbidden' | 'no_room' | 'locked' | 'not_found' | 'bad_request' | 'unavailable';

/** Link that opens the game and joins this party. */
export function partyLink(origin: string, code: string): string {
  return `${origin}/?party=${code}`;
}

/** Whether the members of a party must land on one team in this mode (team modes; infected assigns roles itself). */
export function partyTeamed(teams: boolean, mode: GameType): boolean {
  return teams && mode !== 'infected';
}
