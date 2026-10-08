import type { GameType } from '../modes/GameTypes';
import { type PartyChange, type PartyError, type PartyStatus, type PartyTicket, type PartyView, partyChanges } from '../modes/Party';
import { profileToken } from './ProfileApi';

/**
 * The browser side of parties. The server keeps the party; this client holds the member token (in sessionStorage,
 * so a reload keeps the party and a new tab does not), polls the party every second or two and hands changes and
 * tickets to the menu. A ticket is the leader's "go": the lobby to join and the key that holds this member's seat
 * and team (it goes into the WebSocket hello, see NetClient). Nothing here changes party state by itself: the
 * server decides who leads, who is ready and where the party plays.
 */
const TOKEN_KEY = 'bunkcraft.party.';
/** The newest ticket this browser acted on, so a reload does not drag a player back into a lobby they just left. */
const TICKET_KEY = 'bunkcraft.party.ticket.';
/** Poll every this many ms in the menu and while playing a match. */
export const POLL_MENU_MS = 1500;
export const POLL_GAME_MS = 4000;
const POLL_RETRY_MS = 5000;

/** A failed party call; `code` is the server's error code (or 'network' / 'rate'). */
export class PartyCallError extends Error {
  constructor(message: string, readonly code: PartyError | 'network' | 'rate') {
    super(message);
  }
}

interface Reply { status: number; data: Record<string, unknown> }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PartyClientOptions {
  fetch?: Fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** The profile token of this browser (the rank icon, and finding the party again after the session token is gone). */
  profileToken?: () => string | undefined;
  now?: () => number;
  host?: string;
}

export class PartyClient {
  view: PartyView | null = null;
  private token: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inflight = false;
  /** Newest ticket id handed to `onTicket` for the party we are in. */
  private ticketSeen = 0;
  private held: { code: string; key: string; until: number } | null = null;
  private readonly changeFns = new Set<(v: PartyView | null) => void>();
  private readonly ticketFns = new Set<(t: PartyTicket) => void>();
  private readonly eventFns = new Set<(c: PartyChange) => void>();
  /** Where this browser is, as reported to the server: 'menu' (home screen) or 'game' (in a match). */
  statusOf: () => PartyStatus = () => 'menu';
  private readonly fetchFn: Fetch;
  private readonly storage: PartyClientOptions['storage'];
  private readonly profile: () => string | undefined;
  private readonly now: () => number;
  private readonly host: string;

  constructor(opts: PartyClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
    this.storage = opts.storage === undefined ? safeSession() : opts.storage;
    this.profile = opts.profileToken ?? (() => profileToken());
    this.now = opts.now ?? (() => Date.now());
    this.host = opts.host ?? (typeof location !== 'undefined' ? location.host : 'local');
    try { this.token = this.storage?.getItem(TOKEN_KEY + this.host) ?? null; } catch { this.token = null; }
  }

  get active(): boolean {
    return !!this.view;
  }

  get isLeader(): boolean {
    return !!this.view && this.view.leader === this.view.me;
  }

  /** Called with the view whenever it changes (and once right away). Returns the unsubscribe function. */
  onChange(fn: (v: PartyView | null) => void): () => void {
    this.changeFns.add(fn);
    fn(this.view);
    return () => this.changeFns.delete(fn);
  }

  /** Called once for every new ticket the party's leader makes (also for a ticket that is still valid after a reload). */
  onTicket(fn: (t: PartyTicket) => void): () => void {
    this.ticketFns.add(fn);
    return () => this.ticketFns.delete(fn);
  }

  /** People joined, left, a new leader, the party ended. */
  onEvent(fn: (c: PartyChange) => void): () => void {
    this.eventFns.add(fn);
    return () => this.eventFns.delete(fn);
  }

  // ---------------------------------------------------------------- calls

  async create(name: string, mode: GameType): Promise<PartyView> {
    return this.enter(await this.call('POST', '/api/party', { name, gameType: mode }, this.profile()));
  }

  async join(code: string, name: string): Promise<PartyView> {
    return this.enter(await this.call('POST', '/api/party/join', { code, name }, this.profile()));
  }

  /** At start-up: the party this browser was in (session token), else the one of its profile. Never throws. */
  async resume(name?: string): Promise<PartyView | null> {
    if (this.token) {
      const r = await this.send('GET', this.pollPath(), undefined, this.token);
      if (r.status === 200) { this.apply(r.data.party as PartyView); this.keepPolling(); return this.view; }
      if (r.status !== 0 && r.status !== 429) this.forget();
      else { this.keepPolling(); return this.view; }
    }
    const profile = this.profile();
    if (!profile) return null;
    const r = await this.send('POST', '/api/party/resume', { ...(name ? { name } : {}) }, profile);
    if (r.status === 200 && typeof r.data.token === 'string') {
      this.save(r.data.token);
      this.apply(r.data.party as PartyView);
      this.keepPolling();
    }
    return this.view;
  }

  private keepPolling(): void {
    if (this.running && this.token && !this.timer && !this.inflight) this.schedule(POLL_MENU_MS);
  }

  async leave(): Promise<void> {
    const token = this.token;
    this.forget();
    if (token) await this.send('POST', '/api/party/leave', {}, token);
  }

  async kick(memberId: string): Promise<void> {
    await this.act('/api/party/kick', { member: memberId });
  }

  async promote(memberId: string): Promise<void> {
    await this.act('/api/party/promote', { member: memberId });
  }

  async setReady(ready: boolean): Promise<void> {
    await this.act('/api/party/ready', { ready });
  }

  /** The leader's mode pick (members' screens follow it). */
  async setMode(mode: GameType): Promise<void> {
    await this.act('/api/party/mode', { gameType: mode });
  }

  /**
   * The leader takes the party into a lobby: a quick play of `gameType`, or one particular lobby by `code`. Returns
   * the ticket to join with; the other members get theirs on their next poll.
   */
  async play(target: { gameType: GameType } | { code: string }): Promise<PartyTicket> {
    const r = await this.call('POST', '/api/party/play', target, this.token ?? undefined);
    const ticket = r.ticket as PartyTicket;
    const view = r.party as PartyView;
    // The leader joins with the answer in hand: the ticket is not announced to the menu a second time.
    this.ticketSeen = Math.max(this.ticketSeen, ticket.id);
    this.storeTicket(view.code, ticket.id);
    this.apply(view);
    this.held = { code: ticket.code, key: ticket.key, until: this.now() + ticket.ttlMs };
    return ticket;
  }

  /** The key for the `hello` of a connection to this lobby: the seat held for this member, on the party's team. */
  keyFor(room: string): string | undefined {
    const h = this.held;
    return h && h.code === room && h.until > this.now() ? h.key : undefined;
  }

  // ---------------------------------------------------------------- polling

  /** Starts polling (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.token) this.schedule(POLL_MENU_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One poll now (tests and the menu after an action). */
  async poll(): Promise<void> {
    if (!this.token || this.inflight) return;
    this.inflight = true;
    let wait = this.status() === 'game' ? POLL_GAME_MS : POLL_MENU_MS;
    try {
      const r = await this.send('GET', this.pollPath(), undefined, this.token);
      if (r.status === 200) {
        this.apply(r.data.party as PartyView);
      } else if (r.status === 404 || r.status === 403) {
        // The party is gone (or this browser was removed from it).
        this.end(r.status === 403 ? 'kicked' : 'ended');
      } else {
        wait = POLL_RETRY_MS;
      }
    } finally {
      this.inflight = false;
      if (this.running && this.token) this.schedule(wait);
    }
  }

  // ---------------------------------------------------------------- internals

  private status(): PartyStatus {
    try { return this.statusOf(); } catch { return 'menu'; }
  }

  private pollPath(): string {
    return `/api/party?status=${this.status()}`;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, ms);
  }

  private async act(path: string, body: unknown): Promise<void> {
    const r = await this.call('POST', path, body, this.token ?? undefined);
    if (r.party) this.apply(r.party as PartyView);
    else void this.poll();
  }

  /** A create/join answer: keep the token, show the party, start polling. */
  private enter(r: Record<string, unknown>): PartyView {
    this.save(String(r.token));
    this.ticketSeen = 0;
    this.held = null;
    this.apply(r.party as PartyView);
    if (this.running) this.schedule(POLL_MENU_MS);
    return this.view!;
  }

  private apply(next: PartyView): void {
    const prev = this.view;
    if (this.ticketSeen === 0) this.ticketSeen = this.storedTicket(next.code);
    const changed = !prev || JSON.stringify(strip(prev)) !== JSON.stringify(strip(next));
    this.view = next;
    if (changed) {
      for (const c of partyChanges(prev, next)) for (const fn of this.eventFns) fn(c);
      for (const fn of this.changeFns) fn(next);
    }
    if (next.ticket) this.take(next.ticket);
  }

  /** A ticket: remember its key for the hello, and tell the menu once. */
  private take(ticket: PartyTicket): void {
    this.held = { code: ticket.code, key: ticket.key, until: this.now() + ticket.ttlMs };
    if (ticket.id <= this.ticketSeen) return;
    this.ticketSeen = ticket.id;
    if (this.view) this.storeTicket(this.view.code, ticket.id);
    for (const fn of this.ticketFns) fn(ticket);
  }

  private end(why: 'ended' | 'kicked'): void {
    const prev = this.view;
    this.forget();
    if (prev) for (const fn of this.eventFns) fn({ kind: why });
  }

  private forget(): void {
    this.token = null;
    this.held = null;
    this.ticketSeen = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.storage?.removeItem(TOKEN_KEY + this.host); this.storage?.removeItem(TICKET_KEY + this.host); } catch { /* nothing stored */ }
    if (this.view) {
      this.view = null;
      for (const fn of this.changeFns) fn(null);
    }
  }

  private storedTicket(code: string): number {
    try {
      const v = JSON.parse(this.storage?.getItem(TICKET_KEY + this.host) ?? 'null') as { code?: string; id?: number } | null;
      return v && v.code === code && typeof v.id === 'number' ? v.id : 0;
    } catch {
      return 0;
    }
  }

  private storeTicket(code: string, id: number): void {
    try { this.storage?.setItem(TICKET_KEY + this.host, JSON.stringify({ code, id })); } catch { /* private mode */ }
  }

  private save(token: string): void {
    this.token = token;
    try { this.storage?.setItem(TOKEN_KEY + this.host, token); } catch { /* private mode: a reload loses the party, the profile finds it */ }
  }

  /** A call whose failure is an error for the menu to show. */
  private async call(method: 'GET' | 'POST', path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    const r = await this.send(method, path, body, token);
    if (r.status >= 200 && r.status < 300) return r.data;
    if (r.status === 0) throw new PartyCallError('Could not reach the server', 'network');
    if (r.status === 429) throw new PartyCallError(String(r.data.error ?? 'Too many requests'), 'rate');
    throw new PartyCallError(String(r.data.error ?? `Server error (${r.status})`), (r.data.code as PartyError) ?? 'bad_request');
  }

  /** The raw call: status 0 = the network failed. */
  private async send(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<Reply> {
    try {
      const res = await this.fetchFn(path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    } catch {
      return { status: 0, data: {} };
    }
  }
}

/** The view without what changes every poll (the ticket's remaining time). */
function strip(v: PartyView): unknown {
  return { ...v, ticket: v.ticket ? { ...v.ticket, ttlMs: 0 } : undefined };
}

function safeSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** The party of this browser (one per page). */
export const party = new PartyClient();

/** The ticket key to send in the hello when joining `room` (NetClient). */
export function partyKey(room: string | undefined): string | undefined {
  return room ? party.keyFor(room) : undefined;
}
