import { type GameType, parseGameType } from '../modes/GameTypes';
import { profileToken } from './ProfileApi';

/**
 * Getting back into an arcade match after the connection dropped (network, reload, crash). The server keeps a
 * dropped player's seat, score and match XP for a while and hands every login a secret for the next drop; this
 * browser keeps the latest one together with the lobby it belongs to (a "ticket"). It lives in sessionStorage
 * (survives a reload of this tab) and localStorage (survives a crash or a closed browser), is replaced at every
 * login and thrown away when the player leaves on purpose.
 */
export interface RejoinTicket {
  /** The lobby's code. */
  code: string;
  /** The server this ticket is for (the page's own host or a direct-connect address). */
  host: string;
  /** The name the player had; a rejoin is for that name only. */
  name: string;
  /** The secret from the last welcome. */
  token: string;
  /** Seconds the server keeps a seat (from the welcome). */
  sec: number;
  gameType: GameType;
  /** When the ticket was last refreshed (ms). */
  savedAt: number;
}

const KEY = 'bunkcraft.rejoin';

function stores(): Storage[] {
  const out: Storage[] = [];
  try { if (typeof sessionStorage !== 'undefined') out.push(sessionStorage); } catch { /* blocked */ }
  try { if (typeof localStorage !== 'undefined') out.push(localStorage); } catch { /* blocked */ }
  return out;
}

function parse(raw: string | null): RejoinTicket | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<RejoinTicket>;
    if (typeof t.code !== 'string' || typeof t.host !== 'string' || typeof t.name !== 'string' || typeof t.token !== 'string') return null;
    if (t.token.length < 16 || t.token.length > 128) return null;
    return {
      code: t.code, host: t.host, name: t.name, token: t.token,
      sec: typeof t.sec === 'number' && Number.isFinite(t.sec) ? Math.max(0, Math.min(3600, t.sec)) : 120,
      gameType: parseGameType(t.gameType), savedAt: typeof t.savedAt === 'number' ? t.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveTicket(ticket: RejoinTicket): void {
  const raw = JSON.stringify(ticket);
  for (const s of stores()) {
    try { s.setItem(KEY, raw); } catch { /* storage full or blocked: the other copy may still work */ }
  }
}

/** The newest ticket of this browser (the tab's own copy wins when both exist and the browser's is not newer). */
export function loadTicket(): RejoinTicket | null {
  let best: RejoinTicket | null = null;
  for (const s of stores()) {
    let t: RejoinTicket | null = null;
    try { t = parse(s.getItem(KEY)); } catch { /* blocked */ }
    if (t && (!best || t.savedAt > best.savedAt)) best = t;
  }
  return best;
}

/** Throws the ticket away (the player left on purpose, was refused, or the seat is gone); `code` limits it to that lobby. */
export function clearTicket(code?: string): void {
  const have = loadTicket();
  if (code && have && have.code !== code) return;
  for (const s of stores()) {
    try { s.removeItem(KEY); } catch { /* blocked */ }
  }
}

/** The secret to send in `hello` when joining this lobby on this server, if the last visit left one. */
export function ticketToken(host: string, code: string): string | undefined {
  const t = loadTicket();
  return t && t.host === host && t.code === code ? t.token : undefined;
}

/** What the home screen shows: the lobby, and how long the server still keeps the seat. */
export interface RejoinOffer {
  ticket: RejoinTicket;
  secondsLeft: number;
  gameType: GameType;
  map?: string;
}

/**
 * Asks the server whether it still keeps this browser's seat. Nothing (and the ticket is dropped) when the seat is
 * gone or the lobby no longer exists; `null` without a ticket or without an answer (the ticket stays for a retry).
 */
export async function checkRejoin(host: string, doFetch: typeof fetch = fetch): Promise<RejoinOffer | null> {
  const ticket = loadTicket();
  if (!ticket || ticket.host !== host) return null;
  let res: Response;
  try {
    const profile = profileToken();
    res = await doFetch('/api/rejoin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(profile ? { authorization: `Bearer ${profile}` } : {}) },
      body: JSON.stringify({ code: ticket.code, token: ticket.token }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { state?: string; secondsLeft?: number; gameType?: string; map?: string } | null;
  if (!body) return null;
  if ((body.state !== 'kept' && body.state !== 'live') || !(typeof body.secondsLeft === 'number' && body.secondsLeft > 0)) {
    clearTicket(ticket.code);
    return null;
  }
  return { ticket, secondsLeft: Math.min(ticket.sec || 3600, Math.floor(body.secondsLeft)), gameType: parseGameType(body.gameType ?? ticket.gameType), map: body.map };
}

/** Pause before reconnect attempt `attempt` (1-based): 1 s, 2 s, 4 s, then 8 s at most. */
export function backoffMs(attempt: number, firstMs = 1000): number {
  return Math.min(8000, firstMs * 2 ** Math.max(0, attempt - 1));
}

/** "1:45" */
export function formatLeft(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
