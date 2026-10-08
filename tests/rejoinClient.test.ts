import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetClient } from '../src/net/NetClient';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { type RejoinTicket, backoffMs, checkRejoin, clearTicket, formatLeft, loadTicket, saveTicket, ticketToken } from '../src/net/Rejoin';

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
  removeItem(k: string): void { this.data.delete(k); }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data) as ClientMessage); }
  close(): void { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(msg: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const SECRET = 's'.repeat(32);
const ticket = (over: Partial<RejoinTicket> = {}): RejoinTicket => ({
  code: 'K7QM2X', host: 'localhost:5173', name: 'alice', token: SECRET, sec: 120, gameType: 'tdm', savedAt: 1000, ...over,
});
const welcome = (extra: Partial<Extract<ServerMessage, { t: 'welcome' }>> = {}): ServerMessage => ({
  t: 'welcome', id: 1, worldName: 'W', seed: 1, gameMode: 'survival', time: 0, gameType: 'tdm', worldType: 'arena',
  spawn: { x: 0, y: 70, z: 0 }, edits: [], player: null, players: [], motd: '', ...extra,
});
const last = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

let session: MemoryStorage;
let local: MemoryStorage;
beforeEach(() => {
  FakeWebSocket.instances = [];
  session = new MemoryStorage();
  local = new MemoryStorage();
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the rejoin ticket', () => {
  it('lives in both the tab and the browser, so it survives a reload and a crash', () => {
    saveTicket(ticket());
    expect(loadTicket()).toMatchObject({ code: 'K7QM2X', token: SECRET, name: 'alice' });
    session = new MemoryStorage();
    vi.stubGlobal('sessionStorage', session); // a new tab / a crashed browser: only localStorage is left
    expect(loadTicket()).toMatchObject({ code: 'K7QM2X' });
    local.setItem('bunkcraft.rejoin', 'garbage');
    expect(loadTicket()).toBeNull();
  });

  it('is for one host and lobby only, and is thrown away on request', () => {
    saveTicket(ticket());
    expect(ticketToken('localhost:5173', 'K7QM2X')).toBe(SECRET);
    expect(ticketToken('localhost:5173', 'ABCDEF')).toBeUndefined();
    expect(ticketToken('example.org', 'K7QM2X')).toBeUndefined();
    clearTicket('ABCDEF');
    expect(loadTicket()).not.toBeNull();
    clearTicket('K7QM2X');
    expect(loadTicket()).toBeNull();
    saveTicket(ticket());
    clearTicket();
    expect(loadTicket()).toBeNull();
  });

  it('refuses a ticket with a secret of the wrong size', () => {
    saveTicket(ticket({ token: 'short' }));
    expect(loadTicket()).toBeNull();
  });

  it('works without any storage (private mode)', () => {
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
    expect(() => saveTicket(ticket())).not.toThrow();
    expect(loadTicket()).toBeNull();
    expect(() => clearTicket()).not.toThrow();
  });
});

describe('the rejoin offer for the home screen', () => {
  const answer = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('shows the seat and the time left when the server keeps it', async () => {
    saveTicket(ticket());
    const f = answer({ state: 'kept', secondsLeft: 105, gameType: 'tdm', map: 'classic' });
    const offer = await checkRejoin('localhost:5173', f as unknown as typeof fetch);
    expect(offer).toMatchObject({ secondsLeft: 105, gameType: 'tdm', map: 'classic', ticket: { code: 'K7QM2X' } });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rejoin');
    // The secret goes in the body, never in the address.
    expect(url).not.toContain(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ code: 'K7QM2X', token: SECRET });
  });

  it('forgets the ticket when the seat is gone, but keeps it when the server cannot be reached', async () => {
    saveTicket(ticket());
    expect(await checkRejoin('localhost:5173', vi.fn().mockRejectedValue(new TypeError('offline')) as unknown as typeof fetch)).toBeNull();
    expect(loadTicket()).not.toBeNull();
    expect(await checkRejoin('localhost:5173', answer({ state: 'none', secondsLeft: 0 }) as unknown as typeof fetch)).toBeNull();
    expect(loadTicket()).toBeNull();
  });

  it('does nothing for a ticket of another server or without one', async () => {
    const f = answer({ state: 'kept', secondsLeft: 50 });
    expect(await checkRejoin('localhost:5173', f as unknown as typeof fetch)).toBeNull();
    saveTicket(ticket({ host: 'other.example.org' }));
    expect(await checkRejoin('localhost:5173', f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('formats the clock and the retry pauses', () => {
    expect(formatLeft(105)).toBe('1:45');
    expect(formatLeft(0)).toBe('0:00');
    expect(formatLeft(59.2)).toBe('1:00');
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(backoffMs(1, 1500)).toBe(1500);
  });
});

describe('NetClient and the ticket', () => {
  it('sends the secret of the last visit, stores the fresh one from the welcome, and tells a fatal refusal from a missing server', async () => {
    saveTicket(ticket());
    const c = new NetClient();
    const p = c.connect('', 'alice', 'K7QM2X');
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'hello', v: PROTOCOL_VERSION, name: 'alice', rejoin: SECRET });
    last().receive(welcome({ rejoin: 'n'.repeat(32), rejoinSec: 90, rejoined: true }));
    const w = await p;
    expect(w.rejoined).toBe(true);
    expect(loadTicket()).toMatchObject({ code: 'K7QM2X', token: 'n'.repeat(32), sec: 90, name: 'alice', gameType: 'tdm' });

    const refused = new NetClient().connect('', 'alice', 'K7QM2X');
    last().open();
    last().receive({ t: 'kick', reason: 'The server is full', code: 'full' });
    await expect(refused).rejects.toMatchObject({ message: 'The server is full', fatal: true });
    const gone = new NetClient().connect('', 'alice', 'K7QM2X');
    last().onerror?.();
    await expect(gone).rejects.toMatchObject({ fatal: false });
  });

  it('sends no secret for a lobby it has none for, and none outside a lobby', async () => {
    saveTicket(ticket());
    const other = new NetClient();
    void other.connect('', 'alice', 'ABCDEF');
    last().open();
    expect(last().sent[0]).not.toHaveProperty('rejoin');
    const main = new NetClient();
    void main.connect('', 'alice');
    last().open();
    expect(last().sent[0]).not.toHaveProperty('rejoin');
  });

  it('a dropped connection keeps the ticket and says it was lost; leaving says goodbye and throws it away', async () => {
    const c = new NetClient();
    const p = c.connect('', 'alice', 'K7QM2X');
    last().open();
    last().receive(welcome({ rejoin: SECRET, rejoinSec: 120 }));
    await p;
    const closes: Array<[string, number | undefined, boolean | undefined]> = [];
    c.onClose = (r, ms, lost) => closes.push([r, ms, lost]);
    last().onclose?.();
    expect(closes).toEqual([['Connection lost', undefined, true]]);
    expect(loadTicket()).not.toBeNull();

    const d = new NetClient();
    const q = d.connect('', 'alice', 'K7QM2X');
    last().open();
    last().receive(welcome({ rejoin: SECRET, rejoinSec: 120 }));
    await q;
    const ws = last();
    d.leave();
    expect(ws.sent.at(-1)).toEqual({ t: 'bye' });
    expect(loadTicket()).toBeNull();
    expect(d.connected).toBe(false);
  });

  it('a server that asks to come back is not a lost connection', async () => {
    const c = new NetClient();
    const p = c.connect('', 'alice', 'K7QM2X');
    last().open();
    last().receive(welcome({ rejoin: SECRET, rejoinSec: 120 }));
    await p;
    const closes: Array<[string, number | undefined, boolean | undefined]> = [];
    c.onClose = (r, ms, lost) => closes.push([r, ms, lost]);
    last().receive({ t: 'kick', reason: 'Lagging', reconnect: 1500 });
    expect(closes).toEqual([['Lagging', 1500, undefined]]);
    expect(loadTicket()).not.toBeNull();
  });
});
