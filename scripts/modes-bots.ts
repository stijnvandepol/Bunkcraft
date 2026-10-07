/**
 * Protocol-level run of the objective modes against a real server: for each mode it creates a room,
 * joins two bots over WebSocket, walks them (on a path over the map's floor, at running speed) and
 * shoots, and checks what the server says: gun game levels and gear, elimination rounds, hardpoint and
 * domination points, flag pick-up and capture. The newer modes are played to the end of the match:
 * kill confirmed (kill, walk over the tag), search and destroy (a detonation round, then a defuse round),
 * infected (the outbreak, one knife stab), sharpshooter (a weapon rotation, then kills to the limit) and
 * king of the hill (stand alone in the hill to the limit).
 *
 *   ROOM_CREATE_LIMIT=1000 npm run server          # in one terminal (port 3000)
 *   npx tsx scripts/modes-bots.ts [gungame|elimination|hardpoint|domination|ctf|killconfirmed|snd|infected|sharpshooter|koth ...] [--url=http://localhost:3000] [--map=quarter]
 *
 * Takes a few minutes (every mode has a 10 s warm-up; a bomb fuse is 35 s) and exits 0 when every check passed.
 */
import { WebSocket } from 'ws';
import { GUN_GAME_LADDER, type GameType } from '../src/modes/GameTypes';
import { ARENA_FLOOR_Y, type ArenaMap, getMap } from '../src/modes/maps';
import { PROTOCOL_VERSION, type ClientMessage, type ModeState, type ServerMessage } from '../src/net/protocol';
import { type RoutePoint, arenaPath, clientStep, follow } from './lib/arenaPath';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:3000';
/** The map of the elimination, zone and flag runs (it must have zones and flags). */
const MAP = args.find((a) => a.startsWith('--map='))?.slice(6) ?? 'quarter';
const ALL: GameType[] = ['gungame', 'elimination', 'hardpoint', 'domination', 'ctf', 'killconfirmed', 'snd', 'infected', 'sharpshooter', 'koth'];
const modes = args.filter((a) => !a.startsWith('--')) as GameType[];
const run = modes.length ? modes : ALL;

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPEED = 6; // blocks per second: under the arcade run speed (the server validates movement, see server/anticheat)

/**
 * Where a bot stands for an objective: the centre of the block cell it is in, with the objective's feet height.
 * (A zone centre on a block corner, like x=0, would put the body half inside the next cell, which can be solid.)
 */
const at = (o: { x: number; z: number; y: number }): [number, number, number] => [Math.floor(o.x) + 0.5, Math.floor(o.z) + 0.5, o.y];

class Bot {
  readonly log: ServerMessage[] = [];
  id = 0;
  x = 0; y = ARENA_FLOOR_Y + 1; z = 0;
  route: RoutePoint[] = [];
  /** Cover layout of the room (from the welcome seed): paths must use the server's blocks. */
  variant = 0;
  fresh = false;
  phase = '';
  team = '';
  mode: ModeState | null = null;
  scores = { red: 0, blue: 0 };
  /** Blocks per second this bot walks (the infected may run faster). */
  speed = SPEED;
  /** The server moved us back (a rejected move): must stay 0 when the bots walk within the rules. */
  corrections = 0;
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
        if (m.t === 'teleport') this.corrections++;
      });
      this.timer = setInterval(() => {
        if (!this.id) return;
        if (this.fresh) this.fresh = false;
        else {
          follow(this, this.route, this.speed / 10);
        }
        this.send({ t: 'pos', x: this.x, y: this.y, z: this.z, yaw: 0, pitch: 0, flags: 4, held: 0, step: clientStep() });
      }, 100);
    });
  }

  /** Walks to a point (x, z and optionally the feet height, for objectives on an upper level); resolves when there (or after `timeoutMs`). */
  async walk(to: [number, number, number?], timeoutMs = 20000): Promise<boolean> {
    const route = arenaPath(this.map(), this.variant, [this.x, this.z, this.y], to);
    if (!route) throw new Error(`no path to ${to.join(',')} on ${this.map().id}`);
    this.route = route;
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
  const next = arenaPath(shooter.map(), shooter.variant, [victim.x, victim.z, victim.y], [shooter.x, shooter.z, shooter.y]);
  if (!next) throw new Error(`no path to the shooter on ${shooter.map().id}`);
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
  const [a, b] = await pair('elimination', MAP, 2, 60);
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
  const mapId = MAP;
  const [a, b] = await pair(type, mapId);
  check(`${type}: goes live`, await waitFor(() => a.phase === 'live', 15000));
  check(`${type}: mode state with zones`, a.mode?.kind === 'zones' && a.mode.zones.length >= 3);
  const z = getMap(mapId).zones[type === 'hardpoint' ? 0 : getMap(mapId).dominationZones[0]];
  check(`${type}: a walks into ${z.name}`, await a.walk(at(z)));
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
  const mapId = MAP;
  const [a, b] = await pair('ctf', mapId);
  check('ctf: goes live', await waitFor(() => a.phase === 'live', 15000));
  check('ctf: both flags at home', a.mode?.kind === 'ctf' && a.mode.flags.every((f) => f.status === 'home'));
  const map = getMap(mapId);
  const own = map.flags.find((f) => f.team === a.team)!, enemy = map.flags.find((f) => f.team !== a.team)!;
  check('ctf: a reaches the enemy flag', await a.walk(at(enemy), 30000));
  check('ctf: a picks it up', await waitFor(() => a.events('flag-taken').some((e) => e.id === a.id), 2000));
  check('ctf: the mode state shows a as the carrier', a.mode?.kind === 'ctf' && a.mode.flags.some((f) => f.carrier === a.id && f.status === 'carried'));
  check('ctf: a carries it home', await a.walk(at(own), 30000));
  check('ctf: capture', await waitFor(() => a.events('flag-captured').some((e) => e.id === a.id), 2000));
  check('ctf: one capture on the board, both flags home', a.scores[a.team as 'red'] === 1 && a.mode?.kind === 'ctf' && a.mode.flags.every((f) => f.status === 'home'));
  a.close(); b.close();
}

const ended = (b: Bot) => b.of('matchend').length > 0;

/** Kill confirmed to the end: a kills b and walks over the tag, five times (limit 5). */
async function killconfirmed(): Promise<void> {
  const [a, b] = await pair('killconfirmed', 'quarter', 5);
  check('killconfirmed: goes live', await waitFor(() => a.phase === 'live', 15000));
  await sleep(2200);
  const team = a.team as 'red' | 'blue';
  let confirms = 0;
  for (let i = 0; i < 10 && !ended(a); i++) {
    await meet(a, b);
    if (!(await a.shoot(b))) continue;
    if (confirms === 0) check('killconfirmed: a kill alone does not score', a.scores[team] === 0);
    // The tag drops where b fell; when that is within reach a confirms it on the spot.
    const onGround = () => a.mode?.kind === 'tags' && a.mode.tags.length > 0;
    check(`killconfirmed: tag ${confirms + 1} dropped`, await waitFor(() => onGround() || a.events('tag-confirmed').length > confirms, 1500));
    if (onGround()) {
      const st = a.mode as Extract<ModeState, { kind: 'tags' }>;
      const tag = st.tags[st.tags.length - 1];
      await a.walk([tag.x, tag.z]);
    }
    check(`killconfirmed: confirm ${confirms + 1}`, await waitFor(() => a.events('tag-confirmed').length > confirms, 2000));
    confirms = a.events('tag-confirmed').length;
    const spawns = b.of('spawn').length;
    await waitFor(() => b.of('spawn').length > spawns || ended(a), 5000);
    await sleep(2200); // spawn protection
  }
  check('killconfirmed: the match ends at 5 confirms, a\'s team wins', await waitFor(() => ended(a), 3000) && a.of('matchend')[0].winnerTeam === team && a.scores[team] === 5);
  check('killconfirmed: no movement corrections', a.corrections + b.corrections === 0);
  a.close(); b.close();
}

/** Search and destroy to the end (2 rounds to win, sides swap every round): a detonation, then a defuse. */
async function snd(): Promise<void> {
  const mapId = 'quarter';
  const [a, b] = await pair('snd', mapId, 2, 90);
  const map = getMap(mapId);
  const site = map.sites[0];
  check('snd: the bots are on different teams', a.team !== '' && a.team !== b.team);
  check('snd: round 1 goes live', await waitFor(() => a.phase === 'live', 25000));
  const bomb = () => a.mode as Extract<ModeState, { kind: 'bomb' }> | null;
  const attacker = bomb()?.attackers === a.team ? a : b, defender = attacker === a ? b : a;
  check('snd: the attacker starts in the red half, the defender in the blue half', attacker.x < 0 && defender.x > 0);
  check(`snd: the attacker walks onto site ${site.name}`, await attacker.walk(at(site), 30000));
  check('snd: planted', await waitFor(() => a.events('bomb-planted').length === 1, 7000));
  check('snd: the round clock is the fuse now', a.mode?.kind === 'bomb' && a.mode.fuseIn > 25 && a.mode.sites.some((x) => x.planted));
  check('snd: the bomb goes off, the attackers take round 1', await waitFor(() => a.events('bomb-exploded').length === 1, 40000) && a.events('round-win').at(-1)?.team === attacker.team);
  // Round 2: the sides swap (round limit 2 = swap every round).
  check('snd: round 2 goes live with the sides swapped', await waitFor(() => a.phase === 'live' && bomb()?.attackers === defender.team, 20000) && a.events('side-swap').length === 1);
  const att2 = defender, def2 = attacker;
  check('snd: the new attacker spawned in the red half', att2.x < 0 && def2.x > 0);
  check(`snd: round 2: the attacker plants at ${site.name}`, await att2.walk(at(site), 30000) && await waitFor(() => a.events('bomb-planted').length === 2, 7000));
  // The attacker walks back to its spawn: off the site, so the defender defuses alone.
  const home = att2.of('spawn').at(-1)!;
  void att2.walk([home.x, home.z]);
  await sleep(1500);
  check('snd: the defender walks onto the bomb', await def2.walk(at(site), 30000));
  check('snd: defused', await waitFor(() => a.events('bomb-defused').length === 1, 9000));
  check('snd: the match ends 2-0 for the first attacker\'s team', await waitFor(() => ended(a), 3000) && a.of('matchend')[0].winnerTeam === def2.team);
  check('snd: the roster counts the plants and the defuse', (a.of('roster').at(-1)?.players.reduce((n, p) => n + (p.pts ?? 0), 0) ?? 0) === 3);
  check('snd: no movement corrections', a.corrections + b.corrections === 0);
  a.close(); b.close();
}

/** Infected to the end: the outbreak, the infected runs faster and kills the survivor with one stab. */
async function infected(): Promise<void> {
  const [a, b] = await pair('infected', 'quarter', undefined, 120);
  check('infected: both start as survivors', await waitFor(() => a.phase === 'live', 15000) && a.team === 'blue' && b.team === 'blue');
  check('infected: the outbreak comes after about 8 s', await waitFor(() => a.events('outbreak').length === 1, 11000));
  const first = a.events('outbreak')[0].id;
  const hunter = first === a.id ? a : b, prey = hunter === a ? b : a;
  check('infected: the infected holds the knife', await waitFor(() => hunter.of('gear').at(-1)?.primary === 'knife', 2000));
  check('infected: the mode state counts 1 survivor and 1 infected', a.mode?.kind === 'infected' && a.mode.survivors === 1 && a.mode.infected === 1);
  // The infected runs 10% faster than the bots normally walk: the server's movement check must allow it.
  hunter.speed = SPEED * 1.1;
  await meet(prey, hunter);
  const hits = () => hunter.of('hit').filter((h) => h.victim === prey.id).length;
  check('infected: one stab kills', await hunter.shoot(prey, 0, 20) && hits() === 1);
  check('infected: the infected win at once', await waitFor(() => ended(a), 3000) && a.of('matchend')[0].winnerTeam === 'red');
  check('infected: no movement corrections for the faster infected', hunter.corrections === 0);
  a.close(); b.close();
}

/** Sharpshooter to the end: the shared weapon rotates, then five kills (limit 5). */
async function sharpshooter(): Promise<void> {
  const [a, b] = await pair('sharpshooter', 'quarter', 5);
  check('sharpshooter: goes live', await waitFor(() => a.phase === 'live', 15000));
  const st = () => a.mode as Extract<ModeState, { kind: 'roulette' }> | null;
  check('sharpshooter: both carry the weapon of the mode state', st()?.kind === 'roulette' && a.of('spawn').at(-1)?.primary === st()!.weapon && b.of('spawn').at(-1)?.primary === st()!.weapon);
  const first = st()!.weapon;
  check('sharpshooter: the weapon rotates after 45 s', await waitFor(() => a.events('weapon-rotate').length === 1, 50000));
  check('sharpshooter: a new weapon for both at once', st()!.weapon !== first && a.of('gear').at(-1)?.primary === st()!.weapon && b.of('gear').at(-1)?.primary === st()!.weapon);
  for (let i = 0; i < 10 && !ended(a); i++) {
    await meet(a, b);
    // Sniper rounds are slow and may miss: the pistol is the same for everybody too.
    await a.shoot(b, 1, 40);
    await sleep(2600);
  }
  check('sharpshooter: the match ends at 5 kills, a wins', await waitFor(() => ended(a), 3000) && a.of('matchend')[0].winnerId === a.id);
  a.close(); b.close();
}

/** King of the hill to the end: a stands alone in the hill until the limit (5 points). */
async function koth(): Promise<void> {
  const mapId = 'quarter';
  const [a, b] = await pair('koth', mapId, 5);
  check('koth: goes live', await waitFor(() => a.phase === 'live', 15000));
  check('koth: free for all (no teams)', a.team === '' && b.team === '');
  const z = getMap(mapId).zones[0];
  check(`koth: a walks into ${z.name}`, await a.walk(at(z), 30000));
  check('koth: a holds the hill', await waitFor(() => a.mode?.kind === 'zones' && a.mode.zones[0].holder === a.id, 2000));
  check('koth: the match ends at 5 points, a wins', await waitFor(() => ended(a), 9000) && a.of('matchend')[0].winnerId === a.id);
  check('koth: the roster shows a\'s points', (a.of('roster').at(-1)?.players.find((p) => p.id === a.id)?.pts ?? 0) >= 5);
  a.close(); b.close();
}

async function main(): Promise<void> {
  for (const m of run) {
    console.log(`\n== ${m}`);
    if (m === 'gungame') await gungame();
    else if (m === 'elimination') await elimination();
    else if (m === 'hardpoint' || m === 'domination') await zones(m);
    else if (m === 'ctf') await ctf();
    else if (m === 'killconfirmed') await killconfirmed();
    else if (m === 'snd') await snd();
    else if (m === 'infected') await infected();
    else if (m === 'sharpshooter') await sharpshooter();
    else if (m === 'koth') await koth();
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
