import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetClient } from '../src/net/NetClient';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data) as ClientMessage); }
  // Like a real socket, the close event arrives asynchronously.
  close(): void { this.closed = true; this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(msg: ServerMessage | string): void { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
}

const welcome = (id = 7): ServerMessage => ({
  t: 'welcome', id, worldName: 'W', seed: 1, gameMode: 'survival', time: 0, gameType: 'minecraft', worldType: 'terrain',
  spawn: { x: 0, y: 70, z: 0 }, edits: [], player: null, players: [], motd: '',
});

const last = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('NetClient.urlFor', () => {
  it('uses the page host, honouring https, and the room path', () => {
    expect(NetClient.urlFor('', undefined)).toBe('ws://localhost:5173/ws');
    expect(NetClient.urlFor('', 'K7QM2X')).toBe('ws://localhost:5173/ws/K7QM2X');
    vi.stubGlobal('location', { protocol: 'https:', host: 'play.example.com' });
    expect(NetClient.urlFor('  ', 'ABCDEF')).toBe('wss://play.example.com/ws/ABCDEF');
  });

  it('accepts host:port and full ws URLs, replacing an existing /ws path', () => {
    expect(NetClient.urlFor('example.org:3000')).toBe('ws://example.org:3000/ws');
    expect(NetClient.urlFor('wss://example.org')).toBe('wss://example.org/ws');
    expect(NetClient.urlFor('wss://example.org/ws', 'ABCDEF')).toBe('wss://example.org/ws/ABCDEF');
    expect(NetClient.urlFor('ws://example.org/ws/ZZZZZZ', 'ABCDEF')).toBe('ws://example.org/ws/ABCDEF');
    expect(NetClient.urlFor('ws://example.org/ws/ZZZZZZ')).toBe('ws://example.org/ws');
  });
});

describe('NetClient.connect', () => {
  it('sends hello with the protocol version on open and resolves with the welcome', async () => {
    const c = new NetClient();
    const p = c.connect('', 'alice', 'K7QM2X');
    const ws = last();
    expect(ws.url).toBe('ws://localhost:5173/ws/K7QM2X');
    ws.open();
    expect(ws.sent[0]).toEqual({ t: 'hello', v: PROTOCOL_VERSION, name: 'alice' });
    ws.receive(welcome(9));
    const w = await p;
    expect(w.id).toBe(9);
    expect(c.id).toBe(9);
    expect(c.connected).toBe(true);
  });

  it('rejects with the kick reason when the server refuses the login', async () => {
    const c = new NetClient();
    const p = c.connect('', 'x');
    last().open();
    last().receive({ t: 'kick', reason: 'Outdated client' });
    await expect(p).rejects.toThrow('Outdated client');
  });

  it('times out after 10 s without a welcome', async () => {
    const c = new NetClient();
    const p = c.connect('', 'x');
    const assertion = expect(p).rejects.toThrow('timed out');
    vi.advanceTimersByTime(10_001);
    await assertion;
    expect(last().closed).toBe(true);
  });

  it('explains a missing game when the room socket errors out before the welcome', async () => {
    const c = new NetClient();
    const p = c.connect('', 'x', 'ZZZZZZ');
    last().onerror?.();
    await expect(p).rejects.toThrow(/Game not found/);
    const q = new NetClient().connect('', 'x');
    last().onerror?.();
    await expect(q).rejects.toThrow(/Could not connect/);
  });

  it('rejects when the WebSocket constructor throws', async () => {
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('blocked by CSP'); } });
    await expect(new NetClient().connect('', 'x')).rejects.toThrow('blocked by CSP');
  });

  it('ignores malformed frames before and after the welcome', async () => {
    const c = new NetClient();
    const got: ServerMessage[] = [];
    c.onMessage = (m) => got.push(m);
    const p = c.connect('', 'x');
    last().open();
    last().receive('{broken');
    last().receive(welcome());
    await p;
    last().receive('not json');
    last().receive({ t: 'time', time: 0.5 });
    expect(got).toEqual([{ t: 'time', time: 0.5 }]);
  });
});

async function connected(): Promise<{ c: NetClient; ws: FakeWebSocket }> {
  const c = new NetClient();
  const p = c.connect('', 'tester');
  const ws = last();
  ws.open();
  ws.receive(welcome());
  await p;
  ws.sent.length = 0;
  return { c, ws };
}

describe('NetClient after login', () => {
  it('rolls back a rejected edit to the block it replaced, and only that one', async () => {
    const { c, ws } = await connected();
    const reverted: number[][] = [];
    c.onRevert = (x, y, z, id, meta) => reverted.push([x, y, z, id, meta]);
    c.sendBlock(1, 2, 3, 5, 0, 1, 0);
    c.sendBlock(4, 5, 6, 9, 3, 2, 1);
    const [a, b] = ws.sent as Extract<ClientMessage, { t: 'block' }>[];
    expect(a.seq).not.toBe(b.seq);
    expect(a).not.toHaveProperty('meta'); // default state is left out
    expect(b.meta).toBe(3);
    ws.receive({ t: 'reject', seq: b.seq, x: 4, y: 5, z: 6, id: 9, meta: 3 });
    expect(reverted).toEqual([[4, 5, 6, 2, 1]]);
    ws.receive({ t: 'reject', seq: b.seq, x: 4, y: 5, z: 6, id: 9 }); // a second reject of the same seq does nothing
    ws.receive({ t: 'reject', seq: 9999, x: 0, y: 0, z: 0, id: 0 });
    expect(reverted).toHaveLength(1);
  });

  it('keeps only the 256 most recent edits for rollback', async () => {
    const { c, ws } = await connected();
    const reverted: number[] = [];
    c.onRevert = (x) => reverted.push(x);
    for (let i = 0; i < 300; i++) c.sendBlock(i, 1, 1, 1, 0, 0, 0);
    const seqs = (ws.sent as Extract<ClientMessage, { t: 'block' }>[]).map((m) => m.seq);
    ws.receive({ t: 'reject', seq: seqs[0], x: 0, y: 1, z: 1, id: 1 });
    expect(reverted).toEqual([]); // forgotten
    ws.receive({ t: 'reject', seq: seqs[299], x: 299, y: 1, z: 1, id: 1 });
    expect(reverted).toEqual([299]);
  });

  it('a kick message closes without "Connection lost" and reports its reason', async () => {
    const { c, ws } = await connected();
    const reasons: string[] = [];
    c.onClose = (r) => reasons.push(r);
    ws.receive({ t: 'kick', reason: 'You logged in from another location' });
    ws.close();
    await Promise.resolve();
    expect(reasons).toEqual(['You logged in from another location']);
  });

  it('reports a dropped connection, but not when the user closed it', async () => {
    const a = await connected();
    const reasons: string[] = [];
    a.c.onClose = (r) => reasons.push(r);
    a.ws.onclose?.();
    expect(reasons).toEqual(['Connection lost']);
    const b = await connected();
    b.c.onClose = (r) => reasons.push(r);
    b.c.close();
    await Promise.resolve();
    expect(reasons).toEqual(['Connection lost']);
    expect(b.c.connected).toBe(false);
  });

  it('throttles position updates to 20 per second', async () => {
    const { c, ws } = await connected();
    for (let i = 0; i < 10; i++) c.update(0.01, i, 70, 0, 0, 0, 0, 0);
    // 100 ms of frames at 10 ms: the first goes out at once, the next after 50 ms, and so on.
    const sent = ws.sent.filter((m) => m.t === 'pos');
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(3);
  });

  it('sends nothing while the socket is not open', async () => {
    const { c, ws } = await connected();
    ws.readyState = 3;
    c.sendChat('hi');
    expect(ws.sent).toHaveLength(0);
  });

  it('builds the other messages exactly like the protocol expects', async () => {
    const { c, ws } = await connected();
    c.sendChat('hello');
    c.sendAttack(3);
    c.sendTake(4);
    c.sendIgnite(1, 2, 3);
    c.sendShoot(0, 1, 2, 0, 0, 1, 0.5);
    c.sendDrop(5, 2, undefined, 1, 2, 3, 0.5, 10);
    c.sendState([[1, 2, 0]], [20, 20]);
    expect(ws.sent.map((m) => m.t)).toEqual(['chat', 'attack', 'take', 'ignite', 'shoot', 'drop', 'state']);
    expect(ws.sent[0]).toEqual({ t: 'chat', text: 'hello' });
  });
});
