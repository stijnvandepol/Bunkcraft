/**
 * MATCH_ISOLATION=container, unit level: the container spec and its validation, the runner pool's life cycle,
 * the remote room's seat accounting, the WebSocket bridge, the internal API keys and the tally clamp.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { type ContainerCreate, LABEL_OWNER, buildMatchSpec, validateMatchSpec } from '../server/match/ContainerSpec';
import type { MatchDriver, RunnerHandle } from '../server/match/Drivers';
import { authHeaders, authRunner, runnerKey, type RunnerStatus } from '../server/match/Internal';
import { MatchPool, type Runner } from '../server/match/MatchPool';
import { RemoteRoom, type RemoteHost } from '../server/match/RemoteRoom';
import { ControlPlane, adoptableCode, cleanTally, savedArcadeType } from '../server/match/ControlPlane';
import { RunnerProfiles } from '../server/match/MatchRunner';
import { ProfileService } from '../server/progression/ProfileService';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridge } from '../server/match/WsProxy';
import { parseMemoryMb } from '../server/Config';

const PARAMS = {
  id: 'abcdef0123456789', key: 'k'.repeat(43), image: 'ghcr.io/stijnvandepol/bunkcraft@sha256:' + 'a'.repeat(64), network: 'bunkcraft_match',
  controlUrl: 'http://bunkcraft:3001', owner: 'bunkcraft', cpus: 1, memoryMb: 256, pids: 64, logLevel: 'info', version: '1.1.42+abc1234',
};
const POLICY = { image: PARAMS.image, network: PARAMS.network, owner: PARAMS.owner, maxCpus: 1, maxMemoryMb: 256, maxPids: 64 };
const clone = (s: ContainerCreate): ContainerCreate & { body: Record<string, any> } => JSON.parse(JSON.stringify(s)); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('match container spec', () => {
  it('is locked down: our image, non-root, read-only, no capabilities, internal network, hard limits, no mounts or ports', () => {
    const s = buildMatchSpec(PARAMS);
    const h = s.body.HostConfig as Record<string, unknown>;
    expect(s.name).toBe('bunkcraft-match-abcdef0123456789');
    expect(s.body).toMatchObject({ Image: PARAMS.image, User: '1000:1000' });
    expect(h).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], NetworkMode: 'bunkcraft_match', NanoCpus: 1e9, Memory: 256 * 1048576, MemorySwap: 256 * 1048576, PidsLimit: 64, AutoRemove: true });
    for (const k of ['Binds', 'Mounts', 'Devices', 'Privileged', 'CapAdd', 'PortBindings', 'PublishAllPorts', 'PidMode', 'IpcMode', 'UsernsMode']) expect(h[k]).toBeUndefined();
    expect(() => validateMatchSpec(s, POLICY)).not.toThrow();
  });

  const unsafe: [string, (b: Record<string, any>) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['another image', (b) => { b.Image = 'alpine:latest'; }],
    ['a bind mount', (b) => { b.HostConfig.Binds = ['/:/host']; }],
    ['the docker socket', (b) => { b.HostConfig.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/s' }]; }],
    ['privileged', (b) => { b.HostConfig.Privileged = true; }],
    ['an added capability', (b) => { b.HostConfig.CapAdd = ['SYS_ADMIN']; }],
    ['the host network', (b) => { b.HostConfig.NetworkMode = 'host'; }],
    ['a writable root', (b) => { b.HostConfig.ReadonlyRootfs = false; }],
    ['root', (b) => { b.User = '0'; }],
    ['a published port', (b) => { b.HostConfig.PortBindings = { '3100/tcp': [{ HostPort: '80' }] }; }],
    ['more CPU than allowed', (b) => { b.HostConfig.NanoCpus = 4e9; }],
    ['more memory than allowed', (b) => { b.HostConfig.Memory = 8 * 1024 ** 3; b.HostConfig.MemorySwap = 8 * 1024 ** 3; }],
    ['swap on top', (b) => { b.HostConfig.MemorySwap = -1; }],
    ['no pids limit', (b) => { b.HostConfig.PidsLimit = 0; }],
    ['an extra env var', (b) => { b.Env.push('NODE_OPTIONS=--inspect=0.0.0.0'); }],
    ['an injected env value', (b) => { b.Env[1] = 'MATCH_ID=abcdef0123456789\nX=1'; }],
    ['a foreign owner label', (b) => { b.Labels[LABEL_OWNER] = 'snackspot'; }],
    ['a restart policy', (b) => { b.HostConfig.RestartPolicy = { Name: 'always' }; }],
    ['an unknown top-level field', (b) => { b.Entrypoint = ['sh', '-c', 'id']; }],
    ['a no-new-privileges opt-out', (b) => { b.HostConfig.SecurityOpt = ['seccomp=unconfined']; }],
    // Audit A2-04: log files and the in-memory /tmp are host resources too (disk, RAM).
    ['unbounded container logs', (b) => { b.HostConfig.LogConfig.Config['max-size'] = '500g'; }],
    ['thousands of log files', (b) => { b.HostConfig.LogConfig.Config['max-file'] = '100000'; }],
    ['a log size without unit', (b) => { b.HostConfig.LogConfig.Config['max-size'] = '99999999999'; }],
    ['a huge /tmp', (b) => { b.HostConfig.Tmpfs['/tmp'] = 'rw,noexec,nosuid,size=9999m'; }],
    ['a long stop timeout', (b) => { b.StopTimeout = 3600; }],
  ];
  for (const [what, change] of unsafe) {
    it(`refuses ${what}`, () => {
      const s = clone(buildMatchSpec(PARAMS));
      change(s.body);
      expect(() => validateMatchSpec(s, POLICY)).toThrow(/unsafe match container spec/);
    });
  }

  it('refuses a spec whose name and id do not agree, and ids that are not ours', () => {
    const s = clone(buildMatchSpec(PARAMS));
    s.name = 'bunkcraft-match-0000000000000000';
    expect(() => validateMatchSpec(s, POLICY)).toThrow();
    expect(() => buildMatchSpec({ ...PARAMS, id: 'ABC;rm -rf /' })).toThrow();
    expect(() => buildMatchSpec({ ...PARAMS, controlUrl: 'http://x/;curl evil' })).toThrow();
    expect(() => buildMatchSpec({ ...PARAMS, network: 'host' })).toThrow();
  });

  it('reads memory settings the Docker way', () => {
    expect(parseMemoryMb('256m', 1)).toBe(256);
    expect(parseMemoryMb('1g', 1)).toBe(1024);
    expect(parseMemoryMb('512', 1)).toBe(512);
    expect(parseMemoryMb('lots', 7)).toBe(7);
  });
});

describe('internal API keys', () => {
  it('a runner key belongs to one runner id and the secret', () => {
    const k = runnerKey('s'.repeat(32), 'abcdef0123456789');
    const req = (id: string, key: string) => ({ headers: { 'x-bc-runner': id, authorization: `Bearer ${key}` } }) as never;
    expect(authRunner(req('abcdef0123456789', k), 's'.repeat(32))).toBe('abcdef0123456789');
    expect(authRunner(req('abcdef0123456780', k), 's'.repeat(32))).toBeNull();
    expect(authRunner(req('abcdef0123456789', k), 't'.repeat(32))).toBeNull();
    expect(authRunner(req('../../etc', k), 's'.repeat(32))).toBeNull();
  });

  it('adopts a running lobby only under the code this control plane assigned, never what the runner claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-adopt-'));
    try {
      for (const c of ['AAAAAA', 'BBBBBB']) {
        mkdirSync(join(dir, c));
        writeFileSync(join(dir, c, 'world.json'), '{}');
      }
      const none = () => false;
      expect(adoptableCode('AAAAAA', 'AAAAAA', dir, new Set(), none)).toBe('AAAAAA');
      // Another lobby's code: a runner cannot take over a lobby it was not given.
      expect(adoptableCode('AAAAAA', 'BBBBBB', dir, new Set(), none)).toBeNull();
      expect(adoptableCode(undefined, 'BBBBBB', dir, new Set(), none)).toBeNull();
      // Path-like or non-canonical codes, even if they somehow ended up in the records.
      expect(adoptableCode('../../etc', '../../etc', dir, new Set(), none)).toBeNull();
      expect(adoptableCode('aaaaaa', 'aaaaaa', dir, new Set(), none)).toBeNull();
      expect(adoptableCode('', '', dir, new Set(), none)).toBeNull();
      // Duplicates: already adopted by another runner, or already loaded.
      expect(adoptableCode('AAAAAA', 'AAAAAA', dir, new Set(['AAAAAA']), none)).toBeNull();
      expect(adoptableCode('AAAAAA', 'AAAAAA', dir, new Set(), (c) => c === 'AAAAAA')).toBeNull();
      // A lobby without a world on disk (deleted meanwhile).
      expect(adoptableCode('CCCCCC', 'CCCCCC', dir, new Set(), none)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clamps what a runner says a player did', () => {
    const t = cleanTally({ kills: 1e9, deaths: -5, killXp: 'x', weapons: { rifle: { kills: 3, hits: 1e12 }, 'bad key!': { kills: 1 } }, evil: 1 });
    expect(t.kills).toBe(10_000);
    expect(t.deaths).toBe(0);
    expect(t.killXp).toBe(0);
    expect(t.weapons).toEqual({ rifle: { kills: 3, headshots: 0, assists: 0, shots: 0, hits: 10_000 } });
    expect((t as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});

/** A driver that starts nothing: the test plays the runner's part (ready, heartbeats). */
class FakeDriver implements MatchDriver {
  readonly kind = 'process' as const;
  readonly image = 'fake';
  started: string[] = [];
  stopped: string[] = [];
  failNext = false;
  async init(): Promise<void> {}
  async start(id: string): Promise<RunnerHandle> {
    if (this.failNext) { this.failNext = false; throw new Error('boom'); }
    this.started.push(id);
    return { id, ref: id };
  }
  urlFor(_h: RunnerHandle, port: number): string { return `http://127.0.0.1:${port}`; }
  async stop(h: RunnerHandle): Promise<void> { this.stopped.push(h.id); }
  async list(): Promise<RunnerHandle[]> { return []; }
  async stats(): Promise<null> { return null; }
  async logs(): Promise<[]> { return []; }
}

const flush = () => new Promise((r) => setImmediate(r));

describe('match runner pool', () => {
  let now = 0;
  const pool = (warm: number, max: number, onDead?: (r: Runner) => void) => {
    const driver = new FakeDriver();
    const p = new MatchPool({ driver, secret: 'x'.repeat(32), warm, max, now: () => now, startTimeoutMs: 1000, beatTimeoutMs: 1000, onDead });
    return { driver, p };
  };

  it('keeps the warm pool full and hands a warm runner out at once', async () => {
    const { driver, p } = pool(1, 3);
    p.ensureWarm();
    await flush();
    expect(driver.started).toHaveLength(1);
    expect(p.ready(driver.started[0], 4000, 'v')?.state).toBe('idle');
    const lease = p.lease()!;
    const r = await lease;
    expect(r.state).toBe('assigned');
    await flush();
    expect(driver.started).toHaveLength(2); // refilled behind it
    expect(p.count('starting')).toBe(1);
  });

  it('resizes at run time (ops dashboard): more warm runners start, surplus warm ones stop, assigned ones stay', async () => {
    const { driver, p } = pool(1, 4);
    p.ensureWarm();
    await flush();
    p.ready(driver.started[0], 4000, 'v');
    const busy = await p.lease()!;
    await flush();
    for (const id of driver.started) p.ready(id, 4000, 'v');
    expect(p.count('idle')).toBe(1);
    p.resize(3, 4);
    await flush();
    for (const id of driver.started) p.ready(id, 4000, 'v');
    expect([p.warm, p.max]).toEqual([3, 4]);
    expect(p.count('idle')).toBe(3); // 1 assigned + 3 warm = the cap
    p.resize(0, 2);
    await flush();
    expect(p.count('idle')).toBe(0);
    expect(driver.stopped).toHaveLength(3);
    expect(driver.stopped).not.toContain(busy.id);
    expect(p.runners.get(busy.id)?.state).toBe('assigned');
    // At the cap nothing new starts.
    p.resize(4, 1);
    await flush();
    expect(p.count()).toBe(1);
  });

  it('a smaller warm pool also trims warm runners that were still starting (they stop once ready)', async () => {
    const { driver, p } = pool(2, 4);
    p.ensureWarm();
    await flush();
    expect(p.count('starting')).toBe(2);
    p.resize(0, 4);
    await flush();
    for (const id of driver.started) p.ready(id, 4000, 'v');
    await flush();
    expect(p.count('idle')).toBe(0);
    expect(p.count()).toBe(0);
    expect(driver.stopped).toHaveLength(2);
  });

  it('starts a runner for a lease when none is warm, and says no at the cap', async () => {
    const { driver, p } = pool(0, 2);
    const a = p.lease()!;
    const b = p.lease()!;
    expect(p.lease()).toBeNull();
    expect(p.counters.capped).toBe(1);
    await flush();
    for (const id of driver.started) p.ready(id, 4000, 'v');
    expect((await a).state).toBe('assigned');
    expect((await b).state).toBe('assigned');
  });

  it('a warm runner still starting is taken over by a lease', async () => {
    const { driver, p } = pool(1, 1);
    p.ensureWarm();
    await flush();
    const lease = p.lease()!;
    expect(lease).not.toBeNull();
    p.ready(driver.started[0], 4000, 'v');
    expect((await lease).state).toBe('assigned');
  });

  it('gives up on a runner that never reports ready, and on one that stops beating', async () => {
    const dead: string[] = [];
    const { driver, p } = pool(0, 4, (r) => dead.push(r.id));
    now = 0;
    const lease = p.lease()!;
    await flush();
    now = 2000;
    p.sweep();
    await expect(lease).rejects.toThrow(/no ready/);
    expect(p.counters.startFailures).toBe(1);
    const l2 = p.lease()!;
    await flush();
    const id = driver.started.at(-1)!;
    p.ready(id, 4000, 'v');
    await l2;
    p.beat(id, { players: 3 } as RunnerStatus);
    now = 2500;
    p.sweep();
    expect(dead).toEqual([]);
    now = 4000;
    p.sweep();
    expect(dead).toEqual([id]);
    await flush();
    expect(driver.stopped).toContain(id);
  });

  it('a failed start rejects the lease and frees the slot', async () => {
    const { driver, p } = pool(0, 1);
    driver.failNext = true;
    const lease = p.lease()!;
    await expect(lease).rejects.toThrow('boom');
    expect(p.count()).toBe(0);
  });

  it('closing keeps the runners with a lobby and stops the warm ones', async () => {
    const { driver, p } = pool(1, 3);
    const lease = p.lease()!;
    p.ensureWarm();
    await flush();
    for (const id of driver.started) p.ready(id, 4000, 'v');
    const busy = await lease;
    await p.close();
    expect(driver.stopped).not.toContain(busy.id);
    expect(driver.stopped).toHaveLength(1);
    expect(p.runners.has(busy.id)).toBe(true);
  });
});

describe('audit A2-11: a runner never sees a player\'s profile token or account session', () => {
  it('the hello and the rejoin question carry a per-runner alias the runner can still verify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-alias-'));
    const profiles = new ProfileService({ dataDir: dir, maxProfiles: 10, secret: 'alias-test-secret-0123456789' });
    try {
      const made = profiles.create('Alice_1')!;
      const cp = new ControlPlane({
        dataDir: dir, roomsDir: join(dir, 'rooms'), secret: 'match-secret-for-alias-test-0123', warm: 0, max: 1, internalPort: 0, internalHost: '127.0.0.1',
        idleGraceSec: 30, roomMaxPlayers: 8, motd: '', binary: true, rejoinGraceSec: 60, version: 't', profiles, skins: null, driver: new FakeDriver(),
      });
      const runner = { id: 'abcdef0123456789', key: 'k'.repeat(43), url: 'http://127.0.0.1:1' } as Runner;
      const room = new RemoteRoom('ABCDEF', cp, Promise.resolve(runner), async () => { throw new Error('no runner'); },
        { name: 'x', gameType: 'tdm', gameMode: 'survival', players: 0, maxPlayers: 8, scoreLimit: 50, timeLimitSec: 600, locked: false }, () => undefined);
      const hello = JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Alice_1', profile: made.token });
      const out = cp.identify(room, runner, hello, '203.0.113.5');
      const sent = out.first ?? hello;
      expect(sent).not.toContain(made.token);
      // The runner (RunnerProfiles) still recognises the player from what it got.
      const rp = new RunnerProfiles(runner.id, async () => ({}));
      rp.register(out.ident);
      expect(rp.verify((JSON.parse(sent) as { profile: string }).profile)).toBe(made.profile.id);
      // Another runner cannot use the alias.
      const other = cp.identify(room, { ...runner, id: 'zzzzzz0123456789' } as Runner, hello, '203.0.113.5');
      expect((JSON.parse(other.first ?? hello) as { profile: string }).profile).not.toBe((JSON.parse(sent) as { profile: string }).profile);
    } finally {
      profiles.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('audit A2-16: a runner cannot hammer the disk through /internal/save', () => {
  it('coalesces saves to one write per interval (the last one wins) and caps the bytes per minute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-save-'));
    const lobbyDir = join(dir, 'rooms', 'ABCDEF');
    mkdirSync(lobbyDir, { recursive: true });
    const secret = 'match-secret-for-save-test-0123456';
    const cp = new ControlPlane({
      dataDir: dir, roomsDir: join(dir, 'rooms'), secret, warm: 0, max: 1, internalPort: 0, internalHost: '127.0.0.1',
      idleGraceSec: 30, roomMaxPlayers: 8, motd: '', binary: true, rejoinGraceSec: 60, version: 't', profiles: null, skins: null, driver: new FakeDriver(),
      saveIntervalMs: 300, saveBytesPerMin: 3 * 1024 * 1024,
    });
    await cp.start();
    const id = 'abcdef0123456789';
    // A lobby this control plane gave to the runner (normally set by the assignment).
    (cp as unknown as { lobbies: Map<string, unknown> }).lobbies.set('ABCDEF', { room: { code: 'ABCDEF', runner: { id } }, dir: lobbyDir, gameType: 'tdm' });
    const writes: string[] = [];
    const file = join(lobbyDir, 'world.json');
    const save = (n: number, pad = 0) => fetch(`http://127.0.0.1:${cp.internalPort}/internal/save`, {
      method: 'POST', headers: { ...authHeaders(id, runnerKey(secret, id)), 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCDEF', world: JSON.stringify({ gameType: 'tdm', n, pad: 'x'.repeat(pad) }) }),
    }).then((r) => r.status);
    try {
      const watch = setInterval(() => { try { const w = readFileSync(file, 'utf8'); if (writes.at(-1) !== w) writes.push(w); } catch { /* not yet */ } }, 5);
      for (let n = 1; n <= 20; n++) expect(await save(n)).toBe(200);
      await new Promise((r) => setTimeout(r, 700));
      clearInterval(watch);
      expect(writes.length).toBeLessThanOrEqual(3); // not 20
      expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(20); // nothing lost
      const big = 1024 * 1024;
      const statuses = [await save(21, big), await save(22, big), await save(23, big), await save(24, big)];
      expect(statuses).toContain(429);
    } finally {
      await cp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remote room seat accounting', () => {
  const host: RemoteHost = { identify: () => ({ ident: {} }), identOf: () => ({}), passwordBlocked: () => false, skinsFor: () => ({}), gone: () => undefined };
  const status = (o: Partial<RunnerStatus>): RunnerStatus => ({
    id: 'r', version: 'v', room: 'ABCDEF', players: 0, reservedSeats: 0, botCount: 0, playersInPlay: 0, listed: true, locked: false, maxPlayers: 4,
    info: { name: 'x', gameType: 'tdm', maxPlayers: 4 }, lobby: null, teams: { red: 0, blue: 0 }, holds: [], playerList: [], tickP99Ms: 0, cpu: 0, rssBytes: 0, heapBytes: 0, ...o,
  });
  // A lease that never resolves: changes queue up and reads come from heartbeats only.
  const room = () => new RemoteRoom('ABCDEF', host, new Promise<Runner>(() => undefined), async () => status({}), { name: 'x', gameType: 'tdm', gameMode: 'survival', players: 0, maxPlayers: 4, scoreLimit: 50, timeLimitSec: 600, locked: false }, () => undefined);

  it('counts a party hold as taken until the runner confirms it, and never overfills', () => {
    const r = room();
    r.apply(status({ players: 1 }));
    expect(r.reserve('k'.repeat(20), 'P1', 2, 60_000)).not.toBeNull();
    expect(r.reservedSeats).toBe(2);
    expect(r.reserve('j'.repeat(20), 'P2', 2, 60_000)).toBeNull(); // 1 + 2 + 2 > 4
    r.apply(status({ players: 1, reservedSeats: 2, holds: ['k'.repeat(20)] }));
    expect(r.reservedSeats).toBe(2); // confirmed: counted once, not twice
    r.release('k'.repeat(20));
  });

  it('answers from the fallback info before the first heartbeat', () => {
    const r = room();
    expect(r.info()).toMatchObject({ gameType: 'tdm', maxPlayers: 4, players: 0 });
    expect(r.maxPlayers).toBe(4);
    expect(r.playerCount).toBe(0);
  });

  it('audit A2-05: a lying runner cannot put junk into listings, matchmaking or the dashboard', () => {
    const r = room();
    const junk = {
      players: '9999', reservedSeats: -5, botCount: 1e12, listed: 'yes', locked: 1, maxPlayers: Infinity, holds: 5,
      info: { name: `${'A'.repeat(100_000)}\u202e\u0000`, gameType: 'tdm', maxPlayers: 1e9 }, lobby: 7, teams: { red: 'x', blue: NaN },
      playerList: [...new Array(5000).fill({ name: 'B'.repeat(5000), ip: { x: 1 } }), 'nope'],
    } as unknown as RunnerStatus;
    expect(() => r.apply(junk)).not.toThrow();
    expect(r.playerCount).toBe(0);
    expect(r.maxPlayers).toBe(4); // falls back to the lobby's own size
    expect(r.listed).toBe(false);
    expect(r.info().name.length).toBeLessThanOrEqual(32);
    expect(r.info().name).not.toMatch(/[\u0000\u202e]/);
    expect(r.lobbyStatus()).toBeNull();
    expect(r.playerList().length).toBeLessThanOrEqual(256);
    expect(r.playerList()[0].name.length).toBeLessThanOrEqual(32);
  });

  it('keeps its own game type whatever the runner reports', () => {
    const r = room();
    r.apply(status({ info: { name: 'x', gameType: 'survival', maxPlayers: 4 } }));
    expect(r.info().gameType).toBe('tdm');
  });
});

describe('savedArcadeType', () => {
  it('reads an arena type from the world file and refuses anything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-type-'));
    try {
      expect(savedArcadeType(dir)).toBeNull(); // no file
      writeFileSync(join(dir, 'world.json'), JSON.stringify({ gameType: 'tdm' }));
      expect(savedArcadeType(dir)).toBe('tdm');
      writeFileSync(join(dir, 'world.json'), JSON.stringify({ gameType: 'survival' }));
      expect(savedArcadeType(dir)).toBeNull();
      writeFileSync(join(dir, 'world.json'), JSON.stringify({ gameType: 'nonsense' }));
      expect(savedArcadeType(dir)).toBeNull();
      writeFileSync(join(dir, 'world.json'), '{broken');
      expect(savedArcadeType(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WebSocket bridge', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  /** An upstream that echoes, and a front server that bridges every connection to it. */
  async function setup(onUpstream?: (ws: WebSocket) => void): Promise<{ front: string; direct: string }> {
    const up = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    up.on('connection', (ws) => {
      onUpstream?.(ws);
      ws.on('message', (d, bin) => {
        if (!bin && d.toString() === 'close-me') { ws.close(4001, 'bye now'); return; }
        ws.send(d, { binary: bin });
      });
    });
    await new Promise((r) => up.once('listening', r));
    const upUrl = `ws://127.0.0.1:${(up.address() as AddressInfo).port}`;
    const http = createServer();
    const front = new WebSocketServer({ server: http });
    front.on('connection', (client) => bridge(client, {
      connect: async () => {
        const u = new WebSocket(upUrl, { autoPong: false });
        await new Promise((r, j) => { u.once('open', r); u.once('error', j); });
        return { upstream: u };
      },
    }));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    servers.push(up, { close: () => { front.close(); http.close(); } });
    return { front: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`, direct: upUrl };
  }

  const open = async (url: string) => {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    return ws;
  };
  const next = (ws: WebSocket) => new Promise<{ data: Buffer; bin: boolean }>((r) => ws.once('message', (data, bin) => r({ data: data as Buffer, bin })));

  it('passes text and binary frames through unchanged, in order, including those sent before upstream is open', async () => {
    const { front } = await setup();
    const ws = await open(front);
    const got: { data: Buffer; bin: boolean }[] = [];
    ws.on('message', (data, bin) => got.push({ data: data as Buffer, bin }));
    ws.send('{"t":"hello"}');
    ws.send(Buffer.from([1, 2, 3]));
    ws.send('second');
    await vi.waitFor(() => expect(got).toHaveLength(3));
    expect(got.map((g) => [g.bin, g.bin ? [...g.data] : g.data.toString()])).toEqual([[false, '{"t":"hello"}'], [true, [1, 2, 3]], [false, 'second']]);
    ws.close();
  });

  it('audit A2-10: a connection that never says hello is closed, like in-process games do', async () => {
    const http = createServer();
    const front = new WebSocketServer({ server: http });
    let connects = 0;
    front.on('connection', (client) => bridge(client, { helloTimeoutMs: 100, connect: async () => { connects++; throw new Error('never'); } }));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    servers.push({ close: () => { front.close(); http.close(); } });
    const ws = await open(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(1008);
    expect(connects).toBe(0);
  });

  it('propagates close codes both ways', async () => {
    let upClosed: number | null = null;
    const { front } = await setup((u) => u.on('close', (code) => { upClosed = code; }));
    const ws = await open(front);
    ws.send('hi');
    await next(ws);
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send('close-me');
    expect(await closed).toBe(4001);
    const ws2 = await open(front);
    ws2.send('hi');
    await next(ws2);
    ws2.close(4002, 'leaving');
    await vi.waitFor(() => expect(upClosed).toBe(4002));
  });

  it('forwards the runner pings to the player and their pongs back (so the runner measures the player)', async () => {
    let upstream: WebSocket | null = null;
    const { front } = await setup((u) => { upstream = u; });
    const ws = await open(front);
    ws.send('hello');
    await next(ws);
    const pong = new Promise<number>((r) => { const at = Date.now(); upstream!.once('pong', () => r(Date.now() - at)); });
    let pinged = false;
    ws.on('ping', () => { pinged = true; });
    upstream!.ping();
    await pong;
    expect(pinged).toBe(true);
    ws.close();
  });

  it('adds well under a millisecond per round trip on one host', async () => {
    const { front, direct } = await setup();
    const rtt = async (url: string) => {
      const ws = await open(url);
      ws.send('warm');
      await next(ws);
      const times: number[] = [];
      for (let i = 0; i < 300; i++) {
        const t0 = performance.now();
        ws.send(`p${i}`);
        await next(ws);
        times.push(performance.now() - t0);
      }
      ws.close();
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)];
    };
    const viaDirect = await rtt(direct);
    const viaProxy = await rtt(front);
    // Two extra hops (in and out) through one extra process boundary; generous bound for loaded CI machines.
    expect(viaProxy - viaDirect).toBeLessThan(2);
  });
});
