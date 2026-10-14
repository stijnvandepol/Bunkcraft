/**
 * What the control plane remembers across its own restarts about matches in containers: the profiles it let into each
 * lobby (XP may only go to them, also after a lobby is adopted) and the XP grants it paid (a retry after a restart
 * never pays twice).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlane } from '../server/match/ControlPlane';
import type { MatchDriver, RunnerHandle } from '../server/match/Drivers';
import { AdmissionLedger, GrantLedger } from '../server/match/Ledgers';
import type { Rooms } from '../server/Rooms';
import type { ProfileService } from '../server/progression/ProfileService';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'bunk-ledger-')); dirs.push(d); return d; };

describe('admission ledger', () => {
  it('remembers the admitted profiles per lobby across a restart, bounded, and forgets ended lobbies', () => {
    const file = join(tmp(), 'admitted.json');
    const a = new AdmissionLedger(file, 2, 3);
    a.admit('AAAAAA', 'p1');
    a.admit('AAAAAA', 'p2');
    a.admit('BBBBBB', 'p3');
    expect(new AdmissionLedger(file, 2, 3).admitted('AAAAAA').sort()).toEqual(['p1', 'p2']);
    for (const p of ['p4', 'p5', 'p6']) a.admit('AAAAAA', p);
    expect(a.admitted('AAAAAA')).toHaveLength(3);
    a.admit('CCCCCC', 'p7'); // a third lobby: the oldest record goes
    expect(a.admitted('AAAAAA')).toEqual([]);
    a.forget('BBBBBB');
    const b = new AdmissionLedger(file, 2, 3);
    expect(b.admitted('BBBBBB')).toEqual([]);
    expect(b.admitted('CCCCCC')).toEqual(['p7']);
    a.retain([]);
    expect(new AdmissionLedger(file).admitted('CCCCCC')).toEqual([]);
  });

  it('ignores junk in the file', () => {
    const file = join(tmp(), 'admitted.json');
    writeFileSync(file, JSON.stringify({ '../x': ['p1'], AAAAAA: ['ok', 'bad id!', 5], aaaaaa: ['p2'] }));
    const a = new AdmissionLedger(file);
    expect(a.admitted('AAAAAA')).toEqual(['ok']);
    expect(a.admitted('aaaaaa')).toEqual([]);
  });
});

describe('grant ledger', () => {
  it('remembers paid grants across a restart until the TTL, bounded', () => {
    const file = join(tmp(), 'grants.json');
    let now = 1000;
    const g = new GrantLedger(file, 10_000, 3, () => now);
    g.record('abcdef0123456789.1');
    expect(new GrantLedger(file, 10_000, 3, () => now).has('abcdef0123456789.1')).toBe(true);
    for (let i = 2; i <= 4; i++) g.record(`abcdef0123456789.${i}`);
    expect(g.has('abcdef0123456789.1')).toBe(false); // the oldest went for room
    expect(g.has('abcdef0123456789.4')).toBe(true);
    now += 10_001;
    expect(new GrantLedger(file, 10_000, 3, () => now).has('abcdef0123456789.4')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ the control plane

class FakeDriver implements MatchDriver {
  readonly kind = 'process' as const;
  readonly image = 'fake';
  handles: RunnerHandle[] = [];
  url = '';
  async init(): Promise<void> {}
  async start(id: string): Promise<RunnerHandle> { return { id, ref: id }; }
  urlFor(): string { return this.url; }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerHandle[]> { return this.handles; }
  async stats(): Promise<null> { return null; }
  async logs(): Promise<[]> { return []; }
}

const RUNNER = 'abcdef0123456789';
const CODE = 'AAAAAA';

function profiles(awards: string[]): ProfileService {
  return {
    verify: (t: unknown) => (typeof t === 'string' && t.startsWith('tok-') ? t.slice(4) : null),
    get: (id: string) => ({ id }),
    rank: () => 101,
    reservedProfile: () => null,
    seen: () => undefined,
    award: (pid: string) => { awards.push(pid); return null; },
  } as unknown as ProfileService;
}

function plane(dataDir: string, driver: FakeDriver, awards: string[]): ControlPlane {
  return new ControlPlane({
    dataDir, roomsDir: join(dataDir, 'rooms'), secret: 's'.repeat(32), warm: 0, max: 4, internalPort: 0, internalHost: '127.0.0.1',
    idleGraceSec: 60, roomMaxPlayers: 12, motd: '', binary: false, rejoinGraceSec: 60, version: 'test',
    profiles: profiles(awards), skins: null, driver,
  });
}

/** A runner that already runs lobby CODE (what a control plane finds after its restart). */
async function runningRunner(driver: FakeDriver): Promise<void> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: RUNNER, version: 'test', room: CODE, players: 1, reservedSeats: 0, botCount: 0, playersInPlay: 1, listed: false, locked: false, maxPlayers: 12,
      info: { name: 'x', gameType: 'tdm', players: 1, maxPlayers: 12 }, lobby: null, teams: null, holds: [], playerList: [],
    }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  servers.push(srv);
  driver.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  driver.handles = [{ id: RUNNER, ref: RUNNER }];
}

function roomsStub(): Rooms {
  return { isLoaded: () => false, adopt: () => undefined, metaChanged: () => undefined, forget: () => undefined } as unknown as Rooms;
}

type Award = (id: string, body: Record<string, unknown>) => [number, unknown];
const award = (cp: ControlPlane, grantId: string, pid: string) => (cp as unknown as { award: Award }).award(RUNNER, { grantId, pid, tally: {}, outcome: {} });

describe('control plane XP records survive its restart', () => {
  async function adoptedPlane(dataDir: string, awards: string[]): Promise<ControlPlane> {
    const driver = new FakeDriver();
    await runningRunner(driver);
    const cp = plane(dataDir, driver, awards);
    await (cp as unknown as { tryInit(): Promise<void> }).tryInit();
    await cp.attach(roomsStub());
    return cp;
  }

  function setupLobby(dataDir: string): void {
    mkdirSync(join(dataDir, 'rooms', CODE), { recursive: true });
    writeFileSync(join(dataDir, 'rooms', CODE, 'world.json'), JSON.stringify({ gameType: 'tdm' }));
    writeFileSync(join(dataDir, 'match-runners.json'), JSON.stringify({ [RUNNER]: CODE }));
  }

  it('an adopted lobby still pays the players this control plane let in (and only them), once per grant', async () => {
    const dataDir = tmp();
    setupLobby(dataDir);
    const awards: string[] = [];
    const first = await adoptedPlane(dataDir, awards);
    const room = (first as unknown as { lobbies: Map<string, { room: Parameters<ControlPlane['identOf']>[0] }> }).lobbies.get(CODE)!.room;
    first.identOf(room, 'tok-alice');
    expect(award(first, `${RUNNER}.1`, 'alice')[0]).toBe(200);
    expect(awards).toEqual(['alice']);

    // The control plane restarts (an update) and adopts the same lobby again.
    const second = await adoptedPlane(dataDir, awards);
    // The grant the runner retries because its answer was lost: not paid again.
    expect(award(second, `${RUNNER}.1`, 'alice')[0]).toBe(200);
    expect(awards).toEqual(['alice']);
    // A new grant for the admitted player: paid. A profile nobody let in: refused, whatever the runner says.
    expect(award(second, `${RUNNER}.2`, 'alice')[0]).toBe(200);
    expect(award(second, `${RUNNER}.3`, 'mallory')[0]).toBe(403);
    expect(awards).toEqual(['alice', 'alice']);
    expect(JSON.parse(readFileSync(join(dataDir, 'match-grants.json'), 'utf8'))).toHaveProperty(`${RUNNER}.2`);
  });

  it('the records of a lobby go when it ends', async () => {
    const dataDir = tmp();
    setupLobby(dataDir);
    const cp = await adoptedPlane(dataDir, []);
    const room = (cp as unknown as { lobbies: Map<string, { room: Parameters<ControlPlane['identOf']>[0] }> }).lobbies.get(CODE)!.room;
    cp.identOf(room, 'tok-alice');
    expect(JSON.parse(readFileSync(join(dataDir, 'match-admitted.json'), 'utf8'))).toEqual({ [CODE]: ['alice'] });
    cp.gone(room);
    expect(JSON.parse(readFileSync(join(dataDir, 'match-admitted.json'), 'utf8'))).toEqual({});
  });
});
