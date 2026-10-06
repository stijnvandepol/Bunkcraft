/**
 * Anti-cheat run against a real server: bots that cheat (noclip through a wall, flying, a speed
 * burst, a teleport, replayed packets, aimbot snaps, shooting from a fake origin) must be corrected or
 * rejected, while honest bots that wander and fight for two minutes must never be corrected.
 *
 *   ADMIN_TOKEN=secret ROOM_CREATE_LIMIT=1000 npm run server          # in one terminal (port 3000)
 *   ADMIN_TOKEN=secret npx tsx scripts/cheat-bots.ts [--url=http://localhost:3000] [--legit=120]
 *
 * Without ADMIN_TOKEN the suspicion score (admin API) is not checked. Exits 0 when every check passed.
 */
import { WebSocket } from 'ws';
import { ARENA_FLOOR_Y, type ArenaMap, getMap } from '../src/modes/maps';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { traceBlocks } from '../server/Combat';
import { BOT_SPEED, type RoutePoint, aimAt, arenaPath, follow } from './lib/arenaPath';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:3000';
const LEGIT_SECONDS = Number(args.find((a) => a.startsWith('--legit='))?.slice(8) ?? 120);
const token = process.env.ADMIN_TOKEN ?? '';
const MAP = 'classic';
const POS_MS = 33;

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  readonly log: ServerMessage[] = [];
  id = 0;
  x = 0; y = ARENA_FLOOR_Y + 1; z = 0;
  yaw = 0;
  route: RoutePoint[] = [];
  /** Honest bots move by themselves; cheaters are driven by the test. */
  auto = true;
  speed = BOT_SPEED;
  variant = 0;
  kicked = '';
  /** Shot dead and waiting for the respawn. */
  dead = false;
  readonly map: ArenaMap = getMap(MAP);
  private ws!: WebSocket;
  private timer: NodeJS.Timeout | null = null;
  readonly sentPos: ClientMessage[] = [];
  /** The physics clock sent with every report (60 Hz steps); a cheater can run it faster than real time. */
  clockRate = 1;
  private clock = 0;
  private clockAt = performance.now();

  constructor(readonly name: string) {}

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name }));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as ServerMessage;
        this.log.push(m);
        if (m.t === 'welcome') { this.id = m.id; this.variant = this.map.variantFor(m.seed); resolve(); }
        // Spawns and corrections put the bot where the server says (an honest client does the same).
        if (m.t === 'spawn' || m.t === 'teleport') { this.x = m.x; this.y = m.y; this.z = m.z; this.route = []; }
        if (m.t === 'spawn') this.dead = false;
        if (m.t === 'kill' && m.victim === this.id) this.dead = true;
        if (m.t === 'kick') { this.kicked = m.reason; reject(new Error(m.reason)); }
      });
      this.ws.on('close', () => { if (this.timer) clearInterval(this.timer); });
      this.timer = setInterval(() => {
        if (!this.id || !this.auto) return;
        follow(this, this.route, (this.speed * POS_MS) / 1000);
        this.pos();
      }, POS_MS);
    });
  }

  pos(x = this.x, y = this.y, z = this.z): void {
    const now = performance.now();
    this.clock += (now - this.clockAt) * 0.06 * this.clockRate;
    this.clockAt = now;
    const m: ClientMessage = { t: 'pos', x, y, z, yaw: this.yaw, pitch: 0, flags: 4, held: 0, step: Math.floor(this.clock) };
    this.sentPos.push(m);
    this.send(m);
  }

  send(m: ClientMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.log.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }

  /** Walks to (x, z) on a floor path; true when there. */
  async walk(to: [number, number], timeoutMs = 30000): Promise<boolean> {
    this.route = arenaPath(this.map, this.variant, [this.x, this.z, this.y], to) ?? [];
    for (let t = 0; t < timeoutMs && this.route.length; t += 100) await sleep(100);
    return Math.hypot(this.x - to[0], this.z - to[1]) < 0.6;
  }

  blocks() {
    return { getBlock: (x: number, y: number, z: number) => this.map.blockAt(this.variant, x, y, z) };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

async function room(type: 'tdm' | 'ffa'): Promise<string> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Cheat test', gameType: type, scoreLimit: 500, timeLimitSec: 900, mapId: MAP }),
  });
  return ((await res.json()) as { code: string }).code;
}

async function join(code: string, name: string): Promise<Bot> {
  const b = new Bot(name);
  await b.connect(base.replace(/^http/, 'ws') + `/ws/${code}`);
  await sleep(200);
  return b;
}

async function adminPlayers(code: string): Promise<{ name: string; suspicion?: number; strikes?: number }[] | null> {
  if (!token) return null;
  const res = await fetch(`${base}/api/admin/rooms/${code}/players`, { headers: { authorization: `Bearer ${token}` } });
  return res.ok ? ((await res.json()) as { players: { name: string; suspicion?: number; strikes?: number }[] }).players : null;
}

/** An open cell with a 1-thick, 2-high wall right next to it in +x and open floor behind (for noclip). */
function wallCell(b: Bot): [number, number] | null {
  const m = b.map, v = b.variant, bd = m.bounds;
  const open = (x: number, z: number) => m.blockAt(v, x, ARENA_FLOOR_Y + 1, z) === 0 && m.blockAt(v, x, ARENA_FLOOR_Y + 2, z) === 0 && m.inBounds(x + 0.5, z + 0.5);
  const solid = (x: number, z: number) => m.blockAt(v, x, ARENA_FLOOR_Y + 1, z) !== 0 && m.blockAt(v, x, ARENA_FLOOR_Y + 2, z) !== 0;
  let best: [number, number] | null = null, bestD = Infinity;
  for (let z = bd.minZ + 2; z < bd.maxZ - 2; z++) {
    for (let x = bd.minX + 2; x < bd.maxX - 3; x++) {
      if (!open(x, z) || !solid(x + 1, z) || !open(x + 2, z)) continue;
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < bestD && arenaPath(m, v, [b.x, b.z, b.y], [x + 0.5, z + 0.5])) { bestD = d; best = [x, z]; }
    }
  }
  return best;
}

const corrected = async (b: Bot, before: number, ms = 1500) => {
  for (let t = 0; t < ms; t += 50) { if (b.of('teleport').length > before || b.kicked) return true; await sleep(50); }
  return false;
};

// ------------------------------------------------------------ honest players

async function legit(): Promise<void> {
  const code = await room('tdm');
  const a = await join(code, 'honestA'), b = await join(code, 'honestB');
  const r = (() => { let s = 99; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
  const target = (bot: Bot): [number, number] => {
    const bd = bot.map.bounds;
    for (;;) {
      const x = Math.floor(bd.minX + 3 + r() * (bd.maxX - bd.minX - 6)), z = Math.floor(bd.minZ + 3 + r() * (bd.maxZ - bd.minZ - 6));
      if (arenaPath(bot.map, bot.variant, [bot.x, bot.z, bot.y], [x + 0.5, z + 0.5])) return [x + 0.5, z + 0.5];
    }
  };
  let shots = 0;
  const end = Date.now() + LEGIT_SECONDS * 1000;
  while (Date.now() < end && !a.kicked && !b.kicked) {
    for (const [me, other] of [[a, b], [b, a]] as const) {
      if (me.route.length === 0) me.route = arenaPath(me.map, me.variant, [me.x, me.z, me.y], target(me)) ?? [];
      // Shoot when the other one is in plain sight (a real player does not fire into walls).
      const ox = me.x, oy = me.y + 1.62, oz = me.z;
      const aim = aimAt(ox, oy, oz, other.x, other.y + 1.2, other.z), d = Math.hypot(other.x - ox, other.y + 1.2 - oy, other.z - oz);
      if (d < 60 && traceBlocks(me.blocks(), ox, oy, oz, aim.dx, aim.dy, aim.dz, d) >= d) {
        me.yaw = Math.atan2(-aim.dx, -aim.dz);
        me.send({ t: 'fire', slot: 0, ox, oy, oz, ...aim, ads: false });
        shots++;
      }
    }
    await sleep(150);
  }
  const strikes = await adminPlayers(code);
  check(`honest bots: ${LEGIT_SECONDS} s of wandering and ${shots} shots without a kick`, !a.kicked && !b.kicked);
  check('honest bots: no rubber band (teleport) ever', a.of('teleport').length === 0 && b.of('teleport').length === 0);
  if (strikes) check(`honest bots: 0 strikes, suspicion ${strikes.map((p) => p.suspicion).join('/')} (< 40)`, strikes.every((p) => (p.strikes ?? 0) === 0 && (p.suspicion ?? 0) < 40));
  check('honest bots: they actually fought', a.of('hit').length + b.of('hit').length > 0 || a.of('shot').length > 0);
  a.close(); b.close();
}

// ------------------------------------------------------------ cheaters

async function movementCheats(): Promise<void> {
  const code = await room('ffa');
  // A fresh cheater per kind of cheat (strikes are per player), all in one room.
  let c = await join(code, 'clipper');
  const fresh = async (name: string) => { c.close(); c = await join(code, name); };
  // Noclip: walk up to a wall, then report the other side of it.
  const cell = wallCell(c);
  check('found a wall to clip through', !!cell);
  if (cell) {
    check('walked to the wall honestly', await c.walk([cell[0] + 0.5, cell[1] + 0.5]));
    await sleep(300);
    c.auto = false;
    const n = c.of('teleport').length;
    c.pos(cell[0] + 2.5, c.y, cell[1] + 0.5);
    check('noclip through a wall is rubber-banded', await corrected(c, n));
    check('...back to this side of the wall', Math.abs(c.x - (cell[0] + 0.5)) < 0.6);
    c.pos();
    c.auto = true;
  }
  // Flying: straight up and stay.
  await fresh('flyer');
  c.auto = false;
  let n = c.of('teleport').length;
  for (let i = 1; i <= 40 && c.of('teleport').length === n; i++) { c.pos(c.x, c.y + Math.min(5, i * 0.3), c.z); await sleep(POS_MS); }
  check('flying is rubber-banded', await corrected(c, n, 500));
  c.pos();
  // Speed: three times the run speed along a path.
  await fresh('speeder');
  const far = c.map.spawns.ffa.map((s) => [s.x, s.z] as [number, number]).sort((p, q) => Math.hypot(q[0] - c.x, q[1] - c.z) - Math.hypot(p[0] - c.x, p[1] - c.z))[0];
  c.route = arenaPath(c.map, c.variant, [c.x, c.z, c.y], far) ?? [];
  n = c.of('teleport').length;
  c.speed = BOT_SPEED * 3;
  c.auto = true;
  check('a 3x speed burst is rubber-banded within 1.5 s', await corrected(c, n, 1500));
  c.speed = BOT_SPEED;
  c.route = [];
  await sleep(2500);
  // The same with a physics clock that runs three times as fast (so every report looks like legal pace).
  await fresh('clockspeeder');
  const far2 = c.map.spawns.ffa.map((s) => [s.x, s.z] as [number, number]).sort((p, q) => Math.hypot(q[0] - c.x, q[1] - c.z) - Math.hypot(p[0] - c.x, p[1] - c.z))[0];
  c.route = arenaPath(c.map, c.variant, [c.x, c.z, c.y], far2) ?? [];
  n = c.of('teleport').length;
  c.speed = BOT_SPEED * 3;
  c.clockRate = 3;
  c.auto = true;
  check('a 3x speed burst with a 3x clock is rubber-banded within 1.5 s', await corrected(c, n, 1500));
  c.speed = BOT_SPEED;
  c.clockRate = 1;
  c.route = [];
  await sleep(2500);
  // Teleport: 25 blocks in one report.
  await fresh('porter');
  c.auto = false;
  n = c.of('teleport').length;
  const away = c.map.spawns.ffa.map((p) => [p.x, p.z] as [number, number]).sort((p, q) => Math.hypot(q[0] - c.x, q[1] - c.z) - Math.hypot(p[0] - c.x, p[1] - c.z))[0];
  c.pos(away[0], c.y, away[1]);
  check('a teleport is rejected', await corrected(c, n));
  c.pos();
  c.auto = true;
  // Replay: two seconds of honest walking, then the same reports again at once.
  await fresh('replayer');
  const away2 = c.map.spawns.ffa.map((p) => [p.x, p.z] as [number, number]).sort((p, q) => Math.hypot(q[0] - c.x, q[1] - c.z) - Math.hypot(p[0] - c.x, p[1] - c.z))[0];
  c.route = arenaPath(c.map, c.variant, [c.x, c.z, c.y], away2) ?? [];
  const from = c.sentPos.length;
  await sleep(2000);
  c.auto = false;
  const replay = c.sentPos.slice(from, from + 60);
  n = c.of('teleport').length;
  for (const m of replay) c.send(m);
  check(`replaying ${replay.length} old position reports is rubber-banded`, await corrected(c, n));
  c.pos();
  c.auto = true;
  // Repeated teleport attempts end in a kick.
  await fresh('repeater');
  c.route = [];
  await sleep(500);
  for (let i = 0; i < 60 && !c.kicked; i++) {
    c.auto = false;
    c.pos(c.x + 25, c.y, c.z);
    await sleep(200);
    c.pos();
    await sleep(100);
  }
  check('repeated cheating ends in a kick', /anti-cheat/.test(c.kicked));
  c.close();
}

async function shotCheats(): Promise<void> {
  const code = await room('ffa');
  const s = await join(code, 'aimbotter'), v1 = await join(code, 'victimone'), v2 = await join(code, 'victimtwo');
  for (const b of [s, v1, v2]) b.auto = true;
  await sleep(500);
  // Fake origin: claims to shoot from 5 blocks away.
  const shotsBefore = s.of('shot').length;
  s.send({ t: 'fire', slot: 0, ox: s.x + 5, oy: s.y + 1.62, oz: s.z, dx: 0, dy: 0, dz: 1, ads: false });
  await sleep(300);
  const shot = s.of('shot')[shotsBefore];
  check('a shot from a fake origin starts at the server eye', !!shot && Math.hypot(shot.ox - s.x, shot.oz - s.z) < 0.7);
  // Not a unit vector: rejected.
  const ammoBefore = s.of('ammo').length;
  await sleep(600);
  s.send({ t: 'fire', slot: 0, ox: s.x, oy: s.y + 1.62, oz: s.z, dx: 0, dy: 0, dz: 7, ads: false });
  await sleep(300);
  check('a non-unit aim vector is rejected', s.of('ammo').length === ammoBefore);
  // Replayed fire messages: 20 copies at once only fire as fast as the weapon allows.
  await sleep(600);
  const before = s.of('ammo').length;
  const m: ClientMessage = { t: 'fire', slot: 0, ox: s.x, oy: s.y + 1.62, oz: s.z, dx: 0, dy: 0, dz: 1, ads: false };
  for (let i = 0; i < 20; i++) s.send(m);
  await sleep(400);
  check('20 replayed fire messages fire at most twice', s.of('ammo').length - before <= 2);
  // Aimbot: two victims in plain sight on either side, the camera (pos yaw) never moves, the shots snap between heads.
  // Wait for the match to go live first: the start respawns everybody.
  for (let i = 0; i < 150 && s.of('match').at(-1)?.phase !== 'live'; i++) await sleep(100);
  await sleep(1500);
  const spots = aimbotSpots(s);
  check('found two victim spots in sight on either side', !!spots);
  if (spots) await Promise.all([v1.walk(spots[0]), v2.walk(spots[1])]);
  await sleep(300);
  // The "aimbot" knows where everybody is and only fires at a victim in plain sight, alternating.
  const visible = (t: Bot) => {
    const ox = s.x, oy = s.y + 1.62, oz = s.z, d = Math.hypot(t.x - ox, t.y + 1.6 - oy, t.z - oz);
    const a = aimAt(ox, oy, oz, t.x, t.y + 1.6, t.z);
    return traceBlocks(s.blocks(), ox, oy, oz, a.dx, a.dy, a.dz, d) >= d;
  };
  let fired = 0;
  for (let i = 0; i < 600 && fired < 60 && !s.kicked; i++) {
    // Victims that died walk back to their spots.
    if (spots) {
      for (const [v, spot] of [[v1, spots[0]], [v2, spots[1]]] as const) {
        if (v.route.length === 0 && Math.hypot(v.x - spot[0], v.z - spot[1]) > 0.6) v.route = arenaPath(v.map, v.variant, [v.x, v.z, v.y], spot) ?? [];
      }
    }
    const t = [i % 2 ? v1 : v2, i % 2 ? v2 : v1].find((v) => !v.dead && visible(v));
    if (t) {
      const ox = s.x, oy = s.y + 1.62, oz = s.z;
      s.send({ t: 'fire', slot: 0, ox, oy, oz, ...aimAt(ox, oy, oz, t.x, t.y + 1.6, t.z), ads: true });
      fired++;
    }
    await sleep(110);
  }
  await sleep(500);
  console.log(`      aimbot: ${s.of('hit').length} hits (${s.of('hit').filter((h) => h.head).length} head), ${s.of('ammo').length} ammo updates, phase ${s.of('match').at(-1)?.phase}`);
  const players = await adminPlayers(code);
  if (players) {
    const p = players.find((q) => q.name === 'aimbotter');
    check(`aimbot snaps raise the suspicion score to ${p?.suspicion} (>= 40, the warning level)`, (p?.suspicion ?? 0) >= 40);
    check('...victims stay clean', players.filter((q) => q.name !== 'aimbotter').every((q) => (q.suspicion ?? 0) < 40));
  } else console.log('SKIP  suspicion score (set ADMIN_TOKEN to check it)');
  s.close(); v1.close(); v2.close();
}

/** Two open cells 6-10 blocks from the shooter, in plain sight, more than 90 degrees apart. */
function aimbotSpots(s: Bot): [[number, number], [number, number]] | null {
  const m = s.map, v = s.variant;
  const cands: [number, number, number][] = [];
  for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) {
    const d = Math.hypot(dx, dz);
    if (d < 6 || d > 10) continue;
    const x = Math.floor(s.x) + dx, z = Math.floor(s.z) + dz;
    const to: [number, number] = [x + 0.5, z + 0.5];
    if (!arenaPath(m, v, [s.x, s.z, s.y], to)) continue;
    const ox = s.x, oy = s.y + 1.62, oz = s.z;
    const a = aimAt(ox, oy, oz, to[0], s.y + 1.6, to[1]), dist = Math.hypot(to[0] - ox, s.y + 1.6 - oy, to[1] - oz);
    if (traceBlocks(s.blocks(), ox, oy, oz, a.dx, a.dy, a.dz, dist) < dist) continue;
    cands.push([to[0], to[1], Math.atan2(dz, dx)]);
  }
  for (const a of cands) for (const b of cands) {
    let diff = Math.abs(a[2] - b[2]);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > Math.PI / 2) return [[a[0], a[1]], [b[0], b[1]]];
  }
  return null;
}

async function main(): Promise<void> {
  console.log(`honest bots for ${LEGIT_SECONDS} s in parallel with the cheaters...`);
  await Promise.all([legit(), (async () => { await movementCheats(); await shotCheats(); })()]);
}

main()
  .then(() => {
    const failed = results.filter(([, ok]) => !ok).length;
    console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} of ${results.length} checks FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('cheat bot script crashed:', e);
    process.exit(1);
  });
