/**
 * Protocol-level run of the objective modes against a real server: for each mode it creates a room,
 * joins two bots over WebSocket, walks them (on a path over the map's floor, at running speed) and
 * shoots, and checks what the server says: gun game levels and gear, elimination rounds, hardpoint and
 * domination points, flag pick-up and capture.
 *
 *   ROOM_CREATE_LIMIT=1000 npm run server          # in one terminal (port 3000)
 *   npx tsx scripts/modes-bots.ts [gungame|elimination|hardpoint|domination|ctf ...] [--url=http://localhost:3000]
 *
 * Takes a minute or two (every mode has a 10 s warm-up) and exits 0 when every check passed.
 */
import { WebSocket } from 'ws';
import { GUN_GAME_LADDER, type GameType } from '../src/modes/GameTypes';
import { ARENA_FLOOR_Y, type ArenaMap, getMap } from '../src/modes/maps';
import { PROTOCOL_VERSION, type ClientMessage, type ModeState, type ServerMessage } from '../src/net/protocol';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:3000';
const ALL: GameType[] = ['gungame', 'elimination', 'hardpoint', 'domination', 'ctf'];
const modes = args.filter((a) => !a.startsWith('--')) as GameType[];
const run = modes.length ? modes : ALL;

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPEED = 6; // blocks per second: under the arcade run speed (the server validates movement, see server/anticheat)

/** A walking path over open floor cells (4-neighbour BFS), as cell centres. */
function path(map: ArenaMap, from: [number, number], to: [number, number], variant = 0): [number, number][] {
  const b = map.bounds, w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  const open = (x: number, z: number) => map.inBounds(x + 0.5, z + 0.5)
    && map.blockAt(variant, x, ARENA_FLOOR_Y + 1, z) === 0 && map.blockAt(variant, x, ARENA_FLOOR_Y + 2, z) === 0;
  const idx = (x: number, z: number) => (x - b.minX) * d + (z - b.minZ);
  const prev = new Int32Array(w * d).fill(-1);
  const sx = Math.floor(from[0]), sz = Math.floor(from[1]), tx = Math.floor(to[0]), tz = Math.floor(to[1]);
  const q = [idx(sx, sz)];
  prev[q[0]] = q[0];
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = Math.floor(c / d) + b.minX, z = (c % d) + b.minZ;
    if (x === tx && z === tz) break;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!open(nx, nz) || prev[idx(nx, nz)] >= 0) continue;
      prev[idx(nx, nz)] = c;
      q.push(idx(nx, nz));
    }
  }
  if (prev[idx(tx, tz)] < 0) throw new Error(`no path to ${tx},${tz} on ${map.id}`);
  const out: [number, number][] = [[to[0], to[1]]];
  for (let c = prev[idx(tx, tz)]; c !== prev[c]; c = prev[c]) out.push([Math.floor(c / d) + b.minX + 0.5, (c % d) + b.minZ + 0.5]);
  return out.reverse();
}

class Bot {
  readonly log: ServerMessage[] = [];
  id = 0;
  x = 0; y = ARENA_FLOOR_Y + 1; z = 0;
  route: [number, number][] = [];
  /** Cover layout of the room (from the welcome seed): paths must use the server's blocks. */
  variant = 0;
  fresh = false;
  phase = '';
  team = '';
  mode: ModeState | null = null;
  scores = { red: 0, blue: 0 };
  private ws!: WebSocket;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly name: string, readonly map: () => ArenaMap) {}

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name }));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as ServerMessage;
        this.log.push(m);
        if (m.t === 'welcome') { this.id = m.id; this.variant = this.map().variantFor(m.seed); resolve(); }
        if (m.t === 'spawn') { this.x = m.x; this.y = m.y; this.z = m.z; this.team = m.team; this.fresh = true; this.route = []; }
        if (m.t === 'match') { this.phase = m.phase; this.scores = m.scores; }
        if (m.t === 'mode') this.mode = m.state;
        if (m.t === 'kick') reject(new Error(m.reason));
      });
      this.timer = setInterval(() => {
        if (!this.id) return;
        if (this.fresh) this.fresh = false;
        else {
          let step = SPEED / 10;
          while (step > 0 && this.route.length) {
            const [tx, tz] = this.route[0];
            const dx = tx - this.x, dz = tz - this.z, dist = Math.hypot(dx, dz);
            if (dist <= step) { this.x = tx; this.z = tz; this.route.shift(); step -= dist; } else { this.x += (dx / dist) * step; this.z += (dz / dist) * step; step = 0; }
          }
        }
        this.send({ t: 'pos', x: this.x, y: this.y, z: this.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
      }, 100);
    });
  }

  /** Walks to a floor point; resolves when there (or after `timeoutMs`). */
  async walk(to: [number, number], timeoutMs = 20000): Promise<boolean> {
    this.route = path(this.map(), [this.x, this.z], to, this.variant);
    for (let t = 0; t < timeoutMs && this.route.length; t += 100) await sleep(100);
    return Math.hypot(this.x - to[0], this.z - to[1]) < 0.6;
  }

  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.log.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }

  events(kind: string) {
    return this.of('event').filter((e) => e.kind === kind);
  }

  /** Fires at another bot's body until it dies (or `tries` shots). */
  async shoot(target: Bot, slot: 0 | 1 | 2 = 0, tries = 30): Promise<boolean> {
    const before = this.of('kill').filter((k) => k.victim === target.id).length;
    for (let i = 0; i < tries; i++) {
      // The server only accepts a unit aim vector.
      const dx = target.x - this.x, dy = target.y + 0.9 - (this.y + 1.62), dz = target.z - this.z, d = Math.hypot(dx, dy, dz) || 1;
      this.send({ t: 'fire', slot, ox: this.x, oy: this.y + 1.62, oz: this.z, dx: dx / d, dy: dy / d, dz: dz / d, ads: true });
      await sleep(250);
      if (this.of('kill').filter((k) => k.victim === target.id).length > before) return true;
    }
    return false;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

async function room(type: GameType, mapId: string, scoreLimit?: number, timeLimitSec?: number): Promise<string> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Bots ${type}`, gameType: type, mapId, scoreLimit, timeLimitSec }),
  });
  const { code } = (await res.json()) as { code: string };
  check(`${type}: created a room on ${mapId} (${code})`, res.status === 201);
  return code;
}

async function pair(type: GameType, mapId: string, scoreLimit?: number, timeLimitSec?: number): Promise<[Bot, Bot, string]> {
  const code = await room(type, mapId, scoreLimit, timeLimitSec);
  const url = base.replace(/^http/, 'ws') + `/ws/${code}`;
  const map = () => getMap(mapId);
  const a = new Bot(`${type.slice(0, 5)}a`.padEnd(4, 'x'), map), b = new Bot(`${type.slice(0, 5)}b`.padEnd(4, 'x'), map);
  await a.connect(url);
  await b.connect(url);
  const info = (await (await fetch(`${base}/api/rooms/${code}`)).json()) as { gameType: string; map?: string };
  check(`${type}: room info has the type and map`, info.gameType === type && info.map === mapId);
  return [a, b, code];
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

/** Brings the victim next to the shooter on open floor (2 blocks apart). */
async function meet(shooter: Bot, victim: Bot): Promise<void> {
  const spot: [number, number] = [shooter.x, shooter.z];
  const next = path(shooter.map(), [victim.x, victim.z], spot, shooter.variant);
  const near = next.length > 3 ? next[next.length - 3] : next[0];
  await victim.walk(near);
}

async function gungame(): Promise<void> {
  const [a, b] = await pair('gungame', 'classic');
  check('gungame: spawn carries the first ladder weapon and the knife', a.of('spawn')[0]?.primary === GUN_GAME_LADDER[0] && a.of('spawn')[0]?.secondary === 'knife');
  check('gungame: goes live after the warm-up', await waitFor(() => a.phase === 'live', 15000));
  await sleep(1200); // spawn protection 1 s
  await meet(a, b);
  check('gungame: a kills b with the level weapon', await a.shoot(b));
  await sleep(400);
  check('gungame: the killer gets the next weapon at once (gear)', a.of('gear').at(-1)?.primary === GUN_GAME_LADDER[1]);
  check('gungame: the roster shows level 1', a.of('roster').at(-1)?.players.find((p) => p.id === a.id)?.pts === 1);
  check('gungame: b respawns after about 1.5 s', await waitFor(() => b.of('spawn').length >= 3, 3000));
  a.close(); b.close();
}

async function elimination(): Promise<void> {
  const [a, b] = await pair('elimination', 'quarter', 2, 60);
  check('elimination: the bots are on different teams', a.team !== '' && a.team !== b.team);
  check('elimination: warm-up, then the intermission of round 1', await waitFor(() => a.phase === 'intermission', 15000));
  check('elimination: countdown, then live', await waitFor(() => a.phase === 'countdown', 8000) && await waitFor(() => a.phase === 'live', 6000));
  await meet(a, b);
  check('elimination: a eliminates b', await a.shoot(b));
  await sleep(300);
  check('elimination: the round goes to a\'s team', a.events('round-win').at(-1)?.team === a.team && a.phase === 'roundend');
  const spawns = b.of('spawn').length;
  await sleep(2500);
  check('elimination: b stays dead during the round end', b.of('spawn').length === spawns);
  check('elimination: next round: everybody back at spawn', await waitFor(() => a.phase === 'intermission' && b.of('spawn').length > spawns, 6000));
  check('elimination: the mode state shows round 2 and the win', a.mode?.kind === 'rounds' && a.mode.round === 2 && a.mode.wins[a.team as 'red'] === 1);
  a.close(); b.close();
}

async function zones(type: 'hardpoint' | 'domination'): Promise<void> {
  const mapId = 'quarter';
  const [a, b] = await pair(type, mapId);
  check(`${type}: goes live`, await waitFor(() => a.phase === 'live', 15000));
  check(`${type}: mode state with zones`, a.mode?.kind === 'zones' && a.mode.zones.length >= 3);
  const z = getMap(mapId).zones[type === 'hardpoint' ? 0 : getMap(mapId).dominationZones[0]];
  check(`${type}: a walks into ${z.name}`, await a.walk([z.x + 0.5, z.z + 0.5]));
  const team = a.team as 'red' | 'blue';
  if (type === 'hardpoint') {
    await sleep(500);
    const st = a.mode;
    check('hardpoint: the hill is held by a\'s team', st?.kind === 'zones' && st.zones[0].owner === team && st.zones[0][team] === 1);
    const before = a.scores[team];
    await sleep(5000);
    check('hardpoint: about a point per second', a.scores[team] - before >= 3 && a.scores[team] - before <= 7);
  } else {
    check('domination: captured in about 6 s', await waitFor(() => a.events('zone-captured').some((e) => e.team === team), 9000));
    const before = a.scores[team];
    await sleep(4500);
    check('domination: the owned point scores', a.scores[team] > before);
  }
  a.close(); b.close();
}

async function ctf(): Promise<void> {
  const mapId = 'quarter';
  const [a, b] = await pair('ctf', mapId);
  check('ctf: goes live', await waitFor(() => a.phase === 'live', 15000));
  check('ctf: both flags at home', a.mode?.kind === 'ctf' && a.mode.flags.every((f) => f.status === 'home'));
  const map = getMap(mapId);
  const own = map.flags.find((f) => f.team === a.team)!, enemy = map.flags.find((f) => f.team !== a.team)!;
  check('ctf: a reaches the enemy flag', await a.walk([enemy.x, enemy.z], 30000));
  check('ctf: a picks it up', await waitFor(() => a.events('flag-taken').some((e) => e.id === a.id), 2000));
  check('ctf: the mode state shows a as the carrier', a.mode?.kind === 'ctf' && a.mode.flags.some((f) => f.carrier === a.id && f.status === 'carried'));
  check('ctf: a carries it home', await a.walk([own.x, own.z], 30000));
  check('ctf: capture', await waitFor(() => a.events('flag-captured').some((e) => e.id === a.id), 2000));
  check('ctf: one capture on the board, both flags home', a.scores[a.team as 'red'] === 1 && a.mode?.kind === 'ctf' && a.mode.flags.every((f) => f.status === 'home'));
  a.close(); b.close();
}

async function main(): Promise<void> {
  for (const m of run) {
    console.log(`\n== ${m}`);
    if (m === 'gungame') await gungame();
    else if (m === 'elimination') await elimination();
    else if (m === 'hardpoint' || m === 'domination') await zones(m);
    else if (m === 'ctf') await ctf();
  }
}

main()
  .then(() => {
    const failed = results.filter(([, ok]) => !ok).length;
    console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} of ${results.length} checks FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('bot script crashed:', e);
    process.exit(1);
  });
