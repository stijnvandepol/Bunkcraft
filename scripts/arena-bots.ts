/**
 * Protocol-level smoke test for the arcade game types: creates a room on a running server, joins two
 * bots over WebSocket, waits for the match to go live, lets one bot shoot the other dead and checks
 * the messages on both sides (hit, damaged, kill, ammo, roster, respawn, rejected block edits).
 *
 *   ROOM_CREATE_LIMIT=1000 npm run server          # in one terminal (port 3000)
 *   npx tsx scripts/arena-bots.ts [tdm|ffa] [classic|suburb|quarter|dockyard|desert] [http://localhost:3000]
 *
 * Takes about 25 seconds (10 s warm-up, 2 s spawn protection) and exits 0 when everything passed.
 */
import { WebSocket } from 'ws';
import { ARENA_FLOOR_Y, MAP_IDS, getMap, parseMapId } from '../src/modes/maps';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { traceBlocks } from '../server/Combat';
import { BOT_SPEED, type RoutePoint, aimAt, arenaPath, clientStep, follow } from './lib/arenaPath';

const type = process.argv[2] === 'ffa' ? 'ffa' : 'tdm';
const mapArg = process.argv[3];
const mapId = parseMapId(mapArg) ?? 'classic';
const base = (mapArg && !parseMapId(mapArg) ? mapArg : process.argv[4]) ?? 'http://localhost:3000';

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
  route: RoutePoint[] = [];
  fresh = false;
  phase = '';
  private ws!: WebSocket;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly name: string) {}

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name }));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as ServerMessage;
        this.log.push(m);
        if (m.t === 'welcome') { this.id = m.id; resolve(); }
        if (m.t === 'spawn') { this.x = m.x; this.y = m.y; this.z = m.z; this.fresh = true; this.route = []; }
        if (m.t === 'match') this.phase = m.phase;
        if (m.t === 'kick') reject(new Error(m.reason));
      });
      // 10 Hz position updates; the first one after a spawn is the spawn itself.
      this.timer = setInterval(() => {
        if (!this.id) return;
        if (this.fresh) this.fresh = false;
        else follow(this, this.route, BOT_SPEED / 10); // honest pace on a path: the server validates movement
        this.send({ t: 'pos', x: this.x, y: this.y, z: this.z, yaw: 0, pitch: 0, flags: 4, held: 0, step: clientStep() });
      }, 100);
    });
  }

  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.log.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

/**
 * Two floor points 14 blocks apart with a clear line of sight at eye height that `reachable` accepts (both bots can walk
 * there: on maps like station the first clear line can lie on a closed-off track).
 */
function findDuelSpots(seed: number, reachable: (a: [number, number], b: [number, number]) => boolean): [[number, number], [number, number]] {
  const map = getMap(mapId);
  const v = map.variantFor(seed);
  const arenaBlockAt = (_v: number, x: number, y: number, z: number) => map.blockAt(v, x, y, z);
  const ARENA_BOUNDS = map.bounds;
  const world = { getBlock: (x: number, y: number, z: number) => arenaBlockAt(v, x, y, z) };
  const free = (x: number, z: number) =>
    arenaBlockAt(v, Math.floor(x), ARENA_FLOOR_Y, Math.floor(z)) !== 0
    && arenaBlockAt(v, Math.floor(x), ARENA_FLOOR_Y + 1, Math.floor(z)) === 0
    && arenaBlockAt(v, Math.floor(x), ARENA_FLOOR_Y + 2, Math.floor(z)) === 0;
  const e = ARENA_FLOOR_Y + 1 + 1.62;
  // Lines along x and along z; either bot may take either end.
  for (const [ax, az] of [[1, 0], [0, 1]]) {
    for (let z = ARENA_BOUNDS.minZ + 4; z < ARENA_BOUNDS.maxZ - 4 - 14 * az; z += 2) {
      for (let x = ARENA_BOUNDS.minX + 4; x < ARENA_BOUNDS.maxX - 4 - 14 * ax; x += 2) {
        const a: [number, number] = [x + 0.5, z + 0.5], b: [number, number] = [x + 0.5 + 14 * ax, z + 0.5 + 14 * az];
        if (!free(a[0], a[1]) || !free(b[0], b[1])) continue;
        const dist = 14;
        // A line at eye height and one at the body (both ways are clear when the walls are).
        if (traceBlocks(world, a[0], e, a[1], ax, 0, az, dist) < dist || traceBlocks(world, a[0], e - 0.7, a[1], ax, 0, az, dist) < dist) continue;
        if (reachable(a, b)) return [a, b];
        if (reachable(b, a)) return [b, a];
      }
    }
  }
  throw new Error('no duel spot found');
}

async function main(): Promise<void> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bot arena', gameMode: 'creative', seed: 'bots', gameType: type, scoreLimit: 5, timeLimitSec: 120, mapId }),
  });
  const { code } = (await res.json()) as { code: string };
  check(`created a ${type} room (${code})`, res.status === 201 && /^[A-Z0-9]{6}$/.test(code));
  const info = (await (await fetch(`${base}/api/rooms/${code}`)).json()) as { gameType: string; scoreLimit: number; timeLimitSec: number; map?: string };
  check('room info has the game type and limits', info.gameType === type && info.scoreLimit === 5 && info.timeLimitSec === 120);
  check(`room info has the map (${mapId})`, info.map === mapId);

  // A bad map id falls back to the default instead of failing.
  const bad = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad map', gameType: type, mapId: 'nope' }),
  });
  const badCode = ((await bad.json()) as { code: string }).code;
  check('an unknown map id becomes the default map', ((await (await fetch(`${base}/api/rooms/${badCode}`)).json()) as { map?: string }).map === 'classic');

  const wsUrl = base.replace(/^http/, 'ws') + `/ws/${code}`;
  const alice = new Bot('alicebot'), bob = new Bot('bobbybot');
  await alice.connect(wsUrl);
  await bob.connect(wsUrl);
  await sleep(300);
  const welcome = alice.of('welcome')[0];
  check('welcome is an arena of the right type', welcome.gameType === type && welcome.worldType === 'arena' && welcome.match?.type === type);
  check(`welcome announces the map (${mapId})`, welcome.match?.map === mapId);
  check('spawns lie inside that map', [alice, bob].every((b) => getMap(mapId).inBounds(b.x, b.z)));
  check('both bots got a spawn message', alice.of('spawn').length >= 1 && bob.of('spawn').length >= 1);
  if (type === 'tdm') check('the bots are on different teams', alice.of('spawn')[0].team !== bob.of('spawn')[0].team);

  // Building is not allowed.
  alice.send({ t: 'block', seq: 1, x: Math.floor(alice.x), y: ARENA_FLOOR_Y, z: Math.floor(alice.z), id: 0 });

  console.log(`waiting for the match to go live (warm-up 10 s)...`);
  for (let i = 0; i < 300 && !(alice.phase === 'live' && bob.phase === 'live'); i++) await sleep(100);
  check('the match goes live after the warm-up', alice.phase === 'live' && bob.phase === 'live');
  // Everybody respawned at the start: walk to the duel spots (spawn protection lasts 2 s).
  const map = getMap(mapId), variant = map.variantFor(welcome.seed);
  const [spotA, spotB] = findDuelSpots(welcome.seed, (a, b) =>
    !!arenaPath(map, variant, [alice.x, alice.z, alice.y], a) && !!arenaPath(map, variant, [bob.x, bob.z, bob.y], b));
  const routeA = arenaPath(map, variant, [alice.x, alice.z, alice.y], spotA), routeB = arenaPath(map, variant, [bob.x, bob.z, bob.y], spotB);
  check('there are walking paths to the duel spots', !!routeA && !!routeB);
  alice.route = routeA ?? []; bob.route = routeB ?? [];
  for (let i = 0; i < 400 && (alice.route.length || bob.route.length); i++) await sleep(100);
  await sleep(300);
  check('bots reached their duel spots', Math.hypot(alice.x - spotA[0], alice.z - spotA[1]) < 0.5 && Math.hypot(bob.x - spotB[0], bob.z - spotB[1]) < 0.5);
  check('no teleport corrections were needed (honest movement passes the validator)', alice.of('teleport').length === 0 && bob.of('teleport').length === 0);

  // Alice shoots bob until he is dead (rifle: 5 body hits).
  const killsBefore = alice.of('kill').length;
  const shotsBefore = alice.of('shot').length;
  for (let i = 0; i < 40 && alice.of('kill').length === killsBefore; i++) {
    alice.send({
      t: 'fire', slot: 0, ox: alice.x, oy: alice.y + 1.62, oz: alice.z,
      ...aimAt(alice.x, alice.y + 1.62, alice.z, bob.x, bob.y + 0.9, bob.z), ads: false,
    });
    await sleep(110);
  }
  await sleep(300);
  const hits = alice.of('hit');
  // Rifle: 20 per body hit, 40 per headshot, so a kill takes 3 to 5 hits (spread decides how many are headshots).
  check('alice got hit markers for bob', hits.length >= 3 && hits.every((h) => h.victim === bob.id && h.damage > 0));
  check('the hits add up to a kill', hits.reduce((sum, h) => sum + h.damage, 0) >= 100);
  check('the last hit killed', hits.at(-1)?.killed === true);
  check('bob was told he was damaged', bob.of('damaged').length >= 3 && bob.of('damaged')[0].from === alice.id);
  check('everyone sees the kill feed entry', [alice, bob].every((b) => b.of('kill').some((k) => k.killer === alice.id && k.victim === bob.id)));
  check('tracers were broadcast to both', alice.of('shot').length > shotsBefore && bob.of('shot').length >= 5);
  check('alice\'s magazine counts down', alice.of('ammo').some((a) => a.slot === 0 && a.mag <= 25));
  check('bob\'s health went to zero', bob.of('hp').at(-1)?.health === 0);
  const roster = alice.of('roster').at(-1)!.players;
  check('the roster shows the kill and the death',
    roster.find((p) => p.id === alice.id)?.kills === 1 && roster.find((p) => p.id === bob.id)?.deaths === 1);
  check('the block edit was rejected', alice.of('reject').some((r) => r.seq === 1));

  const spawnsBefore = bob.of('spawn').length;
  await sleep(3500);
  check('bob respawned with full health after about 3 s', bob.of('spawn').length > spawnsBefore && bob.of('spawn').at(-1)!.health === 100);

  alice.close();
  bob.close();
  void MAP_IDS;
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
