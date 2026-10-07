import { describe, expect, it } from 'vitest';
import { ARENA_SPAWNS } from '../src/modes/arena';
import { getMap } from '../src/modes/maps';
import { TACTICAL_RELOAD, WEAPONS, fireInterval, reloadTimeFor, weaponDef } from '../src/modes/Weapons';
import type { ClientMessage, MatchInfo, ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { ENDED_SECONDS, Match, type MatchHost, SPAWN_PROTECTION, WARMUP_SECONDS } from '../server/Match';
import { RESPAWN_SECONDS } from '../src/modes/Weapons';
import { POSE } from '../src/player/ArcadeMove';

type Fire = Extract<ClientMessage, { t: 'fire' }>;

class StubHost implements MatchHost {
  t = 1000;
  sent: { id: number; msg: ServerMessage }[] = [];
  casts: ServerMessage[] = [];
  blockMap = new Map<string, number>();
  blocks = { getBlock: (x: number, y: number, z: number) => this.blockMap.get(`${x},${y},${z}`) ?? BLOCK.AIR };
  pings = new Map<number, number>();
  moved: number[] = [];
  nextMap?: (current: string) => string | null;
  /** 0 = no spread, tests that need randomness override it. */
  rng = () => 0;

  now() { return this.t; }
  send(id: number, msg: ServerMessage) { this.sent.push({ id, msg }); }
  broadcast(msg: ServerMessage) { this.casts.push(msg); }
  random() { return this.rng(); }
  ping(id: number) { return this.pings.get(id) ?? 0; }
  moveTo(id: number) { this.moved.push(id); }

  of<T extends ServerMessage['t']>(t: T, id?: number): Extract<ServerMessage, { t: T }>[] {
    const all = [
      ...this.casts,
      ...this.sent.filter((s) => id === undefined || s.id === id).map((s) => s.msg),
    ];
    return all.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
  clear() { this.sent = []; this.casts = []; }
}

function setup(type: 'tdm' | 'ffa' = 'tdm', scoreLimit = 30, timeLimitSec = 600) {
  const host = new StubHost();
  const info: MatchInfo = { type, scoreLimit, timeLimitSec };
  const match = new Match(host, info);
  const advance = (sec: number, step = 0.05) => {
    for (let t = 0; t < sec - 1e-9; t += step) { host.t += step; match.tick(); }
  };
  return { host, match, advance };
}

/** Two players in a live match with spawn protection over, standing 10 blocks apart along +z. */
function liveDuel(type: 'tdm' | 'ffa' = 'tdm', scoreLimit = 30, timeLimitSec = 600) {
  const s = setup(type, scoreLimit, timeLimitSec);
  s.match.join(1, 'alice');
  s.match.join(2, 'bob');
  s.match.ready(1);
  s.match.ready(2);
  s.advance(WARMUP_SECONDS + 0.2);
  expect(s.match.phase).toBe('live');
  s.advance(SPAWN_PROTECTION + 0.2);
  const place = (id: number, x: number, y: number, z: number) => s.match.setPosition(id, x, y, z, 0, 0);
  place(1, 0.5, 65, 0.5);
  place(2, 0.5, 65, 10.5);
  s.advance(0.5); // let lag compensation history catch up with the new positions
  s.host.clear();
  return { ...s, place };
}

/** A fire message from the shooter's eye straight at a point. */
function aim(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, slot: 0 | 1 | 2 = 0, ads = false): Fire {
  const ox = from.x, oy = from.y + 1.62, oz = from.z;
  return { t: 'fire', slot, ox, oy, oz, dx: to.x - ox, dy: to.y - oy, dz: to.z - oz, ads };
}

const body = (z: number) => ({ x: 0.5, y: 65.9, z });
const head = (z: number) => ({ x: 0.5, y: 66.6, z });

describe('team balance and phases', () => {
  it('puts every joiner on the smaller team', () => {
    const { match } = setup('tdm');
    const teams = [1, 2, 3, 4, 5].map((id) => match.join(id, `p${id}`).team);
    expect(teams).toEqual(['red', 'blue', 'red', 'blue', 'red']);
    match.leave(1);
    match.leave(3);
    expect(match.join(6, 'p6').team).toBe('red');
  });

  it('free for all has no teams', () => {
    const { match } = setup('ffa');
    expect(match.join(1, 'a').team).toBe('');
    expect(match.join(2, 'b').team).toBe('');
  });

  it('waits in warm-up for a second player, then counts down 10 s and goes live', () => {
    const { host, match, advance } = setup('tdm');
    match.join(1, 'a');
    match.ready(1);
    advance(30);
    expect(match.phase).toBe('warmup');
    expect(match.timeLeft()).toBe(WARMUP_SECONDS);
    match.join(2, 'b');
    match.ready(2);
    advance(1);
    expect(match.timeLeft()).toBeLessThanOrEqual(WARMUP_SECONDS - 0);
    advance(WARMUP_SECONDS);
    expect(match.phase).toBe('live');
    expect(host.of('match').some((m) => m.phase === 'live')).toBe(true);
    // Everybody respawns when it goes live.
    expect(host.of('spawn', 1).length).toBeGreaterThanOrEqual(2);
  });

  it('sends the welcome extras on ready: spawn, match, roster, ammo and holds', () => {
    const { host, match } = setup('tdm');
    match.join(1, 'a');
    match.ready(1);
    const spawn = host.of('spawn', 1)[0];
    expect(spawn.team).toBe('red');
    expect(spawn.health).toBe(100);
    expect(spawn.primary).toBe('rifle');
    expect(host.of('match', 1)[0].phase).toBe('warmup');
    expect(host.of('roster')[0].players[0].name).toBe('a');
    expect(host.sent.filter((s) => s.msg.t === 'ammo').length).toBe(3);
  });
});

describe('late joiners and uneven teams', () => {
  it('a player who joins a live game lands on the smaller team and spawns at once', () => {
    const { host, match } = liveDuel('tdm');
    host.clear();
    const carol = match.join(3, 'carol');
    const dave = match.join(4, 'dave');
    expect(carol.team).toBe('red');
    expect(dave.team).toBe('blue');
    match.join(5, 'erin');
    match.ready(5);
    expect(match.players.get(5)!.team).toBe('red');
    expect(match.players.get(5)!.alive).toBe(true);
    expect(host.of('spawn', 5)).toHaveLength(1);
    expect(host.of('spawn', 5)[0].team).toBe('red');
    expect(match.phase).toBe('live');
  });

  it('on equal team sizes a late joiner goes to the team that is behind', () => {
    const { match, advance } = liveDuel('tdm');
    for (let i = 0; i < 5; i++) { match.fire(1, aim(match.players.get(1)!, body(10.5))); advance(0.11); }
    expect(match.teamScore('red')).toBe(1);
    advance(RESPAWN_SECONDS + 0.2); // bob is back: 1 v 1, red leads
    expect(match.join(3, 'carol').team).toBe('blue');
    expect(match.join(4, 'dave').team).toBe('red');
  });

  it('moves the latest joiner of the larger team over at their next respawn and says so in chat', () => {
    const { host, match, advance } = setup('tdm');
    for (const [id, name] of [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e'], [6, 'f']] as const) { match.join(id, name); match.ready(id); }
    // red: 1, 3, 5   blue: 2, 4, 6
    advance(WARMUP_SECONDS + 0.2);
    advance(SPAWN_PROTECTION + 0.2);
    match.leave(1); match.leave(3); // red: 5, blue: 2, 4, 6
    host.clear();
    expect(match.players.get(6)!.team).toBe('blue');
    // Nothing changes in the middle of a life.
    advance(1);
    expect(match.players.get(6)!.team).toBe('blue');
    expect(host.of('chat').filter((m) => m.system && /moved to/.test(m.text))).toHaveLength(0);
    // Player 6 (the last to join of blue) dies and respawns on red.
    match.players.get(6)!.health = 1;
    match.setPosition(5, 0.5, 65, 0.5);
    match.setPosition(6, 0.5, 65, 8.5);
    advance(0.5);
    match.fire(5, aim({ x: 0.5, y: 65, z: 0.5 }, body(8.5)));
    advance(RESPAWN_SECONDS + 0.3);
    expect(match.players.get(6)!.team).toBe('red');
    expect(host.of('chat').some((m) => m.system && m.text === 'f moved to the red team to even the teams')).toBe(true);
    expect(host.of('spawn', 6).at(-1)!.team).toBe('red');
    expect(host.of('roster').at(-1)!.players.find((p) => p.id === 6)!.team).toBe('red');
    // 2 against 2 now: nobody else moves.
    expect([...match.players.values()].filter((p) => p.team === 'red')).toHaveLength(2);
  });

  it('does not move anybody when the teams differ by one, or after a joiner evened them', () => {
    const { host, match, advance } = setup('tdm');
    for (const id of [1, 2, 3, 4, 5]) { match.join(id, `p${id}`); match.ready(id); }
    match.leave(2); // red 1, 3, 5 against blue 4: a difference of two
    match.join(6, 'p6'); // goes to blue: 3 v 2, the planned move is cancelled by the check at respawn time
    match.ready(6);
    host.clear();
    advance(WARMUP_SECONDS + 0.2);
    expect([...match.players.values()].map((p) => p.team).sort()).toEqual(['blue', 'blue', 'red', 'red', 'red']);
    expect(host.of('chat').filter((m) => /moved to/.test(m.text))).toHaveLength(0);
  });

  it('free for all never moves anybody', () => {
    const { host, match } = setup('ffa');
    for (const id of [1, 2, 3]) match.join(id, `p${id}`);
    match.leave(1);
    expect(host.of('chat')).toHaveLength(0);
    expect(match.players.get(2)!.team).toBe('');
  });
});

describe('scoring and the match flow', () => {
  it('a kill scores for the killer team, feeds the kill list and the roster', () => {
    const { host, match, advance } = liveDuel();
    const bobBefore = match.players.get(2)!;
    expect(bobBefore.alive).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(match.fire(1, aim(match.players.get(1)!, body(10.5)))).toBe(true);
      advance(0.11);
    }
    expect(match.players.get(2)!.alive).toBe(false);
    expect(match.teamScore('red')).toBe(1);
    expect(match.players.get(1)!.kills).toBe(1);
    expect(match.players.get(2)!.deaths).toBe(1);
    const kill = host.of('kill')[0];
    expect(kill).toMatchObject({ killer: 1, victim: 2, weapon: 'rifle', head: false });
    expect(host.of('hit', 1).filter((h) => h.killed).length).toBe(1);
    const last = host.of('roster').at(-1)!.players;
    expect(last.find((p) => p.id === 1)!.kills).toBe(1);
  });

  it('respawns the victim after RESPAWN_SECONDS at a spawn of their own team', () => {
    const { host, match, advance } = liveDuel();
    for (let i = 0; i < 5; i++) { match.fire(1, aim(match.players.get(1)!, body(10.5))); advance(0.11); }
    expect(match.players.get(2)!.alive).toBe(false);
    host.clear();
    advance(RESPAWN_SECONDS - 0.5);
    expect(match.players.get(2)!.alive).toBe(false);
    advance(0.7);
    const bob = match.players.get(2)!;
    expect(bob.alive).toBe(true);
    expect(bob.health).toBe(100);
    const spawn = host.of('spawn', 2).at(-1)!;
    expect(spawn.team).toBe('blue');
    expect(ARENA_SPAWNS.blue.some((s) => s.x === spawn.x && s.z === spawn.z)).toBe(true);
    expect(host.moved).toContain(2);
  });

  it('ends at the score limit with the winning team', () => {
    const { host, match, advance } = liveDuel('tdm', 5);
    for (let k = 0; k < 5; k++) {
      match.setPosition(2, 0.5, 65, 10.5);
      match.players.get(2)!.protectedUntil = 0;
      advance(0.5);
      for (let i = 0; i < 5; i++) { match.fire(1, aim(match.players.get(1)!, body(10.5))); advance(0.11); }
      advance(RESPAWN_SECONDS + 0.2);
      match.players.get(1)!.protectedUntil = 0;
    }
    expect(match.phase).toBe('ended');
    expect(host.of('matchend')[0]).toEqual({ t: 'matchend', winnerTeam: 'red', winnerId: 0, restartIn: ENDED_SECONDS });
  });

  it('ends at the time limit: more kills wins, a tie is a draw', () => {
    const a = liveDuel('tdm', 30, 120);
    a.advance(121);
    expect(a.match.phase).toBe('ended');
    expect(a.host.of('matchend')[0]).toMatchObject({ winnerTeam: '', winnerId: 0 });

    const b = liveDuel('ffa', 30, 120);
    for (let i = 0; i < 5; i++) { b.match.fire(1, aim(b.match.players.get(1)!, body(10.5))); b.advance(0.11); }
    b.advance(121);
    expect(b.host.of('matchend')[0]).toMatchObject({ winnerTeam: '', winnerId: 1 });
  });

  it('free for all ends when someone reaches the score limit', () => {
    const { host, match, advance } = liveDuel('ffa', 5);
    for (let k = 0; k < 5; k++) {
      match.setPosition(2, 0.5, 65, 10.5);
      match.players.get(2)!.protectedUntil = 0;
      advance(0.5);
      for (let i = 0; i < 5; i++) { match.fire(1, aim(match.players.get(1)!, body(10.5))); advance(0.11); }
      advance(RESPAWN_SECONDS + 0.2);
    }
    expect(match.phase).toBe('ended');
    expect(host.of('matchend')[0]).toMatchObject({ winnerTeam: '', winnerId: 1 });
  });

  it('restarts after the result: scores reset, everyone respawns, teams stay balanced', () => {
    const { host, match, advance } = liveDuel('tdm', 30, 120);
    match.join(3, 'carol');
    match.ready(3);
    match.join(4, 'dave');
    match.ready(4);
    match.leave(2);
    match.leave(4); // red: alice, carol; blue: nobody
    advance(121);
    expect(match.phase).toBe('ended');
    host.clear();
    advance(ENDED_SECONDS + 0.5);
    expect(match.phase).toBe('warmup');
    expect(match.teamScore('red')).toBe(0);
    const counts = { red: 0, blue: 0 };
    for (const p of match.players.values()) { counts[p.team as 'red' | 'blue']++; expect(p.alive).toBe(true); }
    expect(Math.abs(counts.red - counts.blue)).toBeLessThanOrEqual(1);
    expect(host.of('spawn').length).toBe(2);
  });

  it('spawn protection absorbs bullets', () => {
    const s = setup('tdm');
    s.match.join(1, 'a');
    s.match.join(2, 'b');
    s.advance(WARMUP_SECONDS + 0.2);
    s.match.setPosition(1, 0.5, 65, 0.5);
    s.match.setPosition(2, 0.5, 65, 10.5);
    s.advance(0.3);
    s.match.fire(1, aim(s.match.players.get(1)!, body(10.5)));
    expect(s.match.players.get(2)!.health).toBe(100);
  });
});

describe('health', () => {
  it('regenerates after REGEN_DELAY without damage', () => {
    const { host, match, advance } = liveDuel();
    match.fire(1, aim(match.players.get(1)!, body(10.5)));
    expect(match.players.get(2)!.health).toBe(80);
    advance(4.5);
    expect(match.players.get(2)!.health).toBe(80);
    advance(2);
    expect(match.players.get(2)!.health).toBe(100);
    expect(host.of('hp', 2).at(-1)!.health).toBe(100);
  });
});

describe('hitscan', () => {
  it('hits the body, headshots multiply, misses do nothing', () => {
    const { host, match } = liveDuel();
    const alice = match.players.get(1)!;
    match.fire(1, aim(alice, body(10.5)));
    expect(host.of('hit', 1)[0]).toMatchObject({ victim: 2, damage: 20, head: false, killed: false });
    expect(host.of('damaged', 2)[0]).toMatchObject({ from: 1, damage: 20 });
    expect(host.of('damaged', 2)[0].dz).toBeLessThan(0); // the shooter is on the -z side of the victim

    const s2 = liveDuel();
    s2.match.fire(1, aim(s2.match.players.get(1)!, head(10.5)));
    expect(s2.host.of('hit', 1)[0]).toMatchObject({ damage: 40, head: true });

    const s3 = liveDuel();
    s3.match.fire(1, aim(s3.match.players.get(1)!, { x: 3.5, y: 65.9, z: 10.5 }));
    expect(s3.host.of('hit', 1)).toHaveLength(0);
    expect(s3.host.of('shot')).toHaveLength(1);
  });

  it('a wall (or glass) stops the bullet, plants do not', () => {
    for (const [id, blocked] of [[BLOCK.STONE_BRICKS, true], [BLOCK.GLASS, true], [BLOCK.TALL_GRASS, false]] as const) {
      const { host, match } = liveDuel();
      for (const y of [65, 66, 67]) host.blockMap.set(`0,${y},5`, id);
      match.fire(1, aim(match.players.get(1)!, body(10.5)));
      expect(host.of('hit', 1).length).toBe(blocked ? 0 : 1);
      if (blocked) {
        const shot = host.of('shot')[0];
        expect(shot.ez).toBeCloseTo(5, 1);
      }
    }
  });

  it('friendly fire is off in tdm but on in free for all; bullets pass teammates', () => {
    const tdm = liveDuel('tdm');
    tdm.match.players.get(2)!.team = 'red';
    tdm.match.fire(1, aim(tdm.match.players.get(1)!, body(10.5)));
    expect(tdm.host.of('hit', 1)).toHaveLength(0);
    const ffa = liveDuel('ffa');
    ffa.match.fire(1, aim(ffa.match.players.get(1)!, body(10.5)));
    expect(ffa.host.of('hit', 1)).toHaveLength(1);
  });

  it('damage falls off with distance', () => {
    const near = liveDuel('ffa');
    const far = liveDuel('ffa');
    far.place(2, 0.5, 65, 80.5);
    far.advance(0.5);
    near.match.fire(1, aim(near.match.players.get(1)!, body(10.5)));
    far.match.fire(1, aim(far.match.players.get(1)!, body(80.5)));
    const dn = near.host.of('hit', 1)[0].damage, df = far.host.of('hit', 1)[0].damage;
    expect(dn).toBe(20);
    expect(df).toBeLessThan(dn);
    expect(df).toBeGreaterThanOrEqual(11); // minDamage 0.55
  });

  it('the shotgun fires pellets that add up at close range, and the knife needs to be close', () => {
    const s = setup('ffa');
    s.match.join(1, 'a');
    s.match.setLoadout(1, 'shotgun');
    s.match.join(2, 'b');
    s.advance(WARMUP_SECONDS + 0.2 + SPAWN_PROTECTION + 0.2);
    s.match.setPosition(1, 0.5, 65, 0.5);
    s.match.setPosition(2, 0.5, 65, 4.5);
    s.advance(0.5);
    s.host.rng = () => 0;
    s.match.fire(1, aim(s.match.players.get(1)!, body(4.5)));
    expect(s.host.of('hit', 1)[0].damage).toBe(144); // 8 pellets × 18 at point blank: one shot kills

    const k = liveDuel('ffa');
    k.place(2, 0.5, 65, 2.2);
    k.advance(0.5);
    k.match.switchWeapon(1, 2);
    k.advance(0.3);
    k.match.fire(1, aim(k.match.players.get(1)!, { x: 0.5, y: 65.9, z: 2.2 }, 2));
    expect(k.host.of('hit', 1)[0]).toMatchObject({ damage: 100, killed: true }); // one stab
    k.place(2, 0.5, 65, 6.5);
    k.advance(0.5);
    k.host.clear();
    k.advance(1);
    k.match.fire(1, aim(k.match.players.get(1)!, { x: 0.5, y: 65.9, z: 6.5 }, 2));
    expect(k.host.of('hit', 1)).toHaveLength(0);
  });

  it('one-shot weapons kill in one server hit: bolt-action sniper to the body at 60 blocks, shotgun at 8 blocks every time', () => {
    const duel = (primary: string, dist: number) => {
      const d = setup('ffa');
      d.match.join(1, 'a');
      d.match.join(2, 'b');
      d.match.setLoadout(1, primary); // warm-up: applies at once
      d.match.ready(1);
      d.match.ready(2);
      d.advance(WARMUP_SECONDS + 0.2 + SPAWN_PROTECTION + 0.2);
      d.match.setPosition(1, 0.5, 65, 0.5, 0, 0);
      d.match.setPosition(2, 0.5, 65, 0.5 + dist, 0, 0);
      d.advance(0.5);
      d.host.clear();
      return d;
    };
    const sn = duel('sniper', 60);
    sn.match.fire(1, aim(sn.match.players.get(1)!, body(60.5), 0, true));
    expect(sn.host.of('hit', 1)[0]).toMatchObject({ killed: true, head: false });
    // The shotgun's fixed pellet pattern: whatever the turn of the pattern and the jitter, a centred pump at 8 blocks kills.
    // (A random cone, the old way, left a pump at 8 blocks without a kill in about a third of these seeds.)
    for (let seed = 1; seed <= 30; seed++) {
      const sg = duel('shotgun', 8);
      let x = seed * 7919;
      sg.host.rng = () => { x = (x * 48271) % 2147483647; return x / 2147483647; };
      sg.match.fire(1, aim(sg.match.players.get(1)!, body(8.5)));
      expect(sg.host.of('hit', 1)[0], `seed ${seed}`).toMatchObject({ killed: true });
    }
  });

  it('lag compensation tests where the shooter saw the target', () => {
    const { host, match, advance, place } = liveDuel('ffa');
    host.pings.set(1, 200); // rewind 0.3 s
    // Bob stood at x 0.5 and just stepped to x 6.5 within the last 0.1 s.
    place(2, 6.5, 65, 10.5);
    const shot = aim(match.players.get(1)!, body(10.5));
    advance(0.0);
    const hist = host.t;
    expect(hist).toBeGreaterThan(0);
    match.fire(1, shot); // aims at x 0.5: only a rewound position can be hit
    expect(host.of('hit', 1)).toHaveLength(1);
    const noLag = liveDuel('ffa');
    noLag.place(2, 6.5, 65, 10.5);
    noLag.advance(0.5);
    noLag.match.fire(1, aim(noLag.match.players.get(1)!, body(10.5)));
    expect(noLag.host.of('hit', 1)).toHaveLength(0);
  });

  it('rejects a shot origin far from the server eye', () => {
    const { host, match } = liveDuel('ffa');
    const alice = match.players.get(1)!;
    // The client claims to shoot from 5 blocks to the side, straight along z: the server uses its own eye.
    const m = aim(alice, body(10.5));
    m.ox += 5;
    match.fire(1, m);
    expect(host.of('hit', 1)).toHaveLength(1);
    expect(host.of('shot')[0].ox).toBeCloseTo(0.5, 1);
  });
});

describe('weapon handling', () => {
  it('limits the fire rate to the weapon cadence', () => {
    const { host, match, advance } = liveDuel('ffa');
    const alice = match.players.get(1)!;
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(match.fire(1, aim(alice, body(10.5))));
    expect(results).toEqual([true, false, false, false]); // all within the same instant
    advance(fireInterval(weaponDef('rifle')!) + 0.01);
    expect(match.fire(1, aim(alice, body(10.5)))).toBe(true);
    expect(host.of('shot').length).toBe(2);
  });

  it('counts the magazine down, reloads on request and refuses to fire while reloading', () => {
    const { host, match, advance } = liveDuel('ffa');
    const alice = match.players.get(1)!;
    for (let i = 0; i < 3; i++) { match.fire(1, { ...aim(alice, { x: 8.5, y: 65, z: 0.5 }) }); advance(0.11); }
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ slot: 0, mag: 27, reloading: false });
    match.reload(1, 0);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ slot: 0, mag: 27, reloading: true });
    expect(match.fire(1, aim(alice, body(10.5)))).toBe(false);
    // A tactical reload (rounds left): 75% of the rifle's 1.3 s empty reload.
    const tactical = reloadTimeFor(weaponDef('rifle')!, 27);
    expect(tactical).toBeCloseTo(1.3 * TACTICAL_RELOAD, 9);
    advance(tactical - 0.15);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ mag: 27, reloading: true });
    advance(0.2);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ mag: 30, reloading: false });
    expect(match.fire(1, aim(alice, body(10.5)))).toBe(true);
  });

  it('reload timing matches the client: empty is slower than tactical, and a shot right at the end of the animation counts', () => {
    const { host, match, advance } = liveDuel('ffa');
    const alice = match.players.get(1)!;
    for (let i = 0; i < 30; i++) { match.fire(1, aim(alice, { x: 8.5, y: 65, z: 0.5 })); advance(0.11); }
    match.reload(1, 0);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ mag: 0, reloading: true });
    const empty = reloadTimeFor(weaponDef('rifle')!, 0);
    expect(empty).toBe(weaponDef('rifle')!.reloadSec);
    // The client ends its animation on its own clock and fires: that shot arrives a little before the server's timer
    // (jitter). It must not be thrown away (QA round 3: "a visible wait after the animation").
    advance(empty - 0.08);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ reloading: true });
    expect(match.fire(1, aim(alice, body(10.5)))).toBe(true);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ mag: 29, reloading: false });
  });

  it('reloads are arcade fast: at most 2.1 s, except the heavy LMG and anti-materiel rifle; the LMG and bolt-actions are the slowest', () => {
    const guns = WEAPONS.filter((w) => w.magazine > 0);
    for (const w of guns) if (w.id !== 'lmg' && w.id !== 'antimat') expect(w.reloadSec, w.id).toBeLessThanOrEqual(2.1);
    const slowest = [...guns].sort((a, b) => b.reloadSec - a.reloadSec).slice(0, 3).map((w) => w.id);
    expect(slowest.sort()).toEqual(['antimat', 'lmg', 'sniper']);
    for (const w of guns) expect(reloadTimeFor(w, 1), w.id).toBeLessThan(reloadTimeFor(w, 0));
  });

  it('an empty magazine starts a reload instead of firing', () => {
    const { host, match, advance } = liveDuel('ffa');
    const alice = match.players.get(1)!;
    for (let i = 0; i < 30; i++) { match.fire(1, aim(alice, { x: 8.5, y: 65, z: 0.5 })); advance(0.11); }
    expect(host.of('ammo', 1).filter((a) => a.slot === 0).at(-1)).toMatchObject({ mag: 0 });
    expect(match.fire(1, aim(alice, body(10.5)))).toBe(false);
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ slot: 0, reloading: true });
  });

  it('switching weapons costs 0.25 s, cancels a reload and tells everyone what you hold', () => {
    const { host, match, advance } = liveDuel('ffa');
    const alice = match.players.get(1)!;
    match.fire(1, aim(alice, { x: 8.5, y: 65, z: 0.5 }));
    match.reload(1, 0);
    match.switchWeapon(1, 1);
    expect(host.of('holds').at(-1)).toEqual({ t: 'holds', id: 1, weapon: 'pistol' });
    expect(host.of('ammo', 1).at(-1)).toMatchObject({ slot: 0, reloading: false });
    expect(match.fire(1, aim(alice, body(10.5), 1))).toBe(false);
    advance(0.3);
    expect(match.fire(1, aim(alice, body(10.5), 1))).toBe(true);
    expect(host.of('hit', 1)[0].damage).toBe(18);
  });

  it('applies the chosen primary at the next spawn once the life has started (a shot went out)', () => {
    const { host, match, advance } = liveDuel('ffa');
    match.fire(1, aim(match.players.get(1)!, { x: 20, y: 66, z: 0.5 }));
    match.setLoadout(1, 'nonsense'); // invalid: the default
    match.setLoadout(1, 'sniper');
    expect(match.players.get(1)!.primary).toBe('rifle');
    for (let i = 0; i < 5; i++) { match.fire(2, aim(match.players.get(2)!, { x: 0.5, y: 65.9, z: 0.5 })); advance(0.11); }
    advance(RESPAWN_SECONDS + 0.2);
    expect(host.of('spawn', 1).at(-1)!.primary).toBe('sniper');
  });
});

describe('pose hitboxes (arcade crouch and slide)', () => {
  it('a sliding player is hit low and missed at standing head height; the head moves down with the pose', () => {
    const { host, match, advance } = liveDuel('tdm');
    match.setPosition(2, 0.5, 65, 10.5, 0, 0, POSE.SLIDE_HEIGHT);
    advance(0.4);
    host.clear();
    // Standing head height (66.6) passes over a slider (hitbox 1.15 tall: top at 66.15).
    match.fire(1, aim(match.players.get(1)!, head(10.5)));
    expect(host.of('hit', 1)).toHaveLength(0);
    advance(0.2);
    // The slider's own head (top 0.4 of 1.15) is a headshot.
    match.fire(1, aim(match.players.get(1)!, { x: 0.5, y: 65 + POSE.SLIDE_HEIGHT - 0.15, z: 10.5 }));
    expect(host.of('hit', 1)[0]?.head).toBe(true);
  });

  it('a pose change in the rewind window counts with the taller hitbox (never in the shooter\'s disfavour)', () => {
    const { host, match, advance } = liveDuel('tdm');
    host.pings.set(1, 200); // rewinds 0.2 s
    match.setPosition(2, 0.5, 65, 10.5, 0, 0, POSE.SLIDE_HEIGHT);
    advance(0.05);
    host.clear();
    match.fire(1, aim(match.players.get(1)!, head(10.5)));
    expect(host.of('hit', 1)).toHaveLength(1);
  });
});

describe('killstreak radar', () => {
  it('every fifth kill in one life sweeps the opponents for the killer\'s team; a death resets the streak', () => {
    const { host, match, advance } = setup('tdm');
    for (const [id, name] of [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']] as const) { match.join(id, name); match.ready(id); }
    advance(WARMUP_SECONDS + SPAWN_PROTECTION + 0.4);
    const killer = match.players.get(1)!;
    const victim = [...match.players.values()].find((p) => p.team !== killer.team)!;
    const killOnce = () => {
      match.setPosition(1, 0.5, 65, 0.5);
      match.setPosition(victim.id, 0.5, 65, 10.5);
      advance(0.5);
      for (let i = 0; i < 8 && victim.alive; i++) { match.fire(1, aim(killer, body(10.5))); advance(0.11); }
      expect(victim.alive).toBe(false);
      advance(RESPAWN_SECONDS + SPAWN_PROTECTION + 0.3);
    };
    host.clear();
    for (let k = 0; k < 4; k++) killOnce();
    expect(host.of('radar')).toHaveLength(0);
    killOnce();
    const radar = host.sent.filter((s) => s.msg.t === 'radar');
    // The killer and its teammates, not the opponents.
    expect(radar.map((s) => s.id).sort()).toEqual([...match.players.values()].filter((p) => p.team === killer.team).map((p) => p.id).sort());
    const msg = radar[0].msg as Extract<ServerMessage, { t: 'radar' }>;
    expect(msg.by).toBe(1);
    // The other (living) opponent is on it; the one just killed is not.
    expect(msg.pts.length).toBe(2);
  });
});

describe('spawn selection', () => {
  it('tdm spawns on the team side, ffa furthest from the others', () => {
    const { match } = setup('tdm');
    const p = match.join(1, 'a');
    expect(ARENA_SPAWNS.red.some((s) => s.x === p.x && s.z === p.z)).toBe(true);
    const f = setup('ffa');
    const a = f.match.join(1, 'a');
    // Put the first player in the middle of a spawn; the next one must pick a spawn far away from it.
    f.match.setPosition(1, a.x, a.y, a.z, 0, 0);
    const b = f.match.join(2, 'b');
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const best = Math.max(...ARENA_SPAWNS.ffa.map((s) => Math.hypot(s.x - a.x, s.z - a.z)));
    expect(dist).toBeGreaterThan(best - 5.01);
    expect(dist).toBeGreaterThan(40);
  });

  it('tdm avoids the spawn next to a living enemy', () => {
    const { match } = setup('tdm');
    match.join(1, 'a'); // red
    match.join(2, 'b'); // blue
    const enemyOnRedSpawn = ARENA_SPAWNS.red[0];
    match.setPosition(2, enemyOnRedSpawn.x + 1, 65, enemyOnRedSpawn.z);
    for (let i = 0; i < 20; i++) {
      const s = match.pickSpawn(match.players.get(1)!);
      expect(Math.hypot(s.x - enemyOnRedSpawn.x, s.z - enemyOnRedSpawn.z)).toBeGreaterThan(5);
    }
  });
});

describe('maps in the match', () => {
  it('spawns on the spawns of the match map and announces it', () => {
    for (const id of ['suburb', 'dockyard']) {
      const host = new StubHost();
      const match = new Match(host, { type: 'tdm', scoreLimit: 30, timeLimitSec: 600, map: id });
      const p = match.join(1, 'alice');
      const map = getMap(id);
      expect(map.spawns[p.team as 'red' | 'blue'].some((s) => s.x === p.x && s.z === p.z)).toBe(true);
      expect(match.info.map).toBe(id);
      expect(match.inBounds(0, 0)).toBe(true);
      expect(match.inBounds(map.bounds.maxX, 0)).toBe(false);
    }
    expect(new Match(new StubHost(), { type: 'ffa', scoreLimit: 5, timeLimitSec: 60 }).info.map).toBe('classic');
  });

  it('keeps the map between matches unless the host rotates it', () => {
    const { host, match, advance } = setup('ffa', 1, 600);
    match.join(1, 'a'); match.join(2, 'b');
    match.ready(1); match.ready(2);
    advance(WARMUP_SECONDS + 0.2);
    match.setPosition(1, 0.5, 65, 0.5); match.setPosition(2, 0.5, 65, 10.5);
    advance(2.5);
    host.clear();
    // Kill b to end the match (score limit 1).
    for (let i = 0; i < 40 && match.phase === 'live'; i++) { match.fire(1, aim({ x: 0.5, y: 65, z: 0.5 }, body(10.5))); advance(0.15); }
    expect(match.phase).toBe('ended');
    advance(ENDED_SECONDS + 0.5);
    expect(match.info.map).toBe('classic');
    expect(host.of('match').at(-1)?.info.map).toBe('classic');
  });

  it('switches to the map the host picks when a new match starts', () => {
    const { host, match, advance } = setup('ffa', 1, 600);
    host.nextMap = (current) => (current === 'classic' ? 'suburb' : 'dockyard');
    match.join(1, 'a'); match.join(2, 'b');
    match.ready(1); match.ready(2);
    advance(WARMUP_SECONDS + 0.2);
    match.setPosition(1, 0.5, 65, 0.5); match.setPosition(2, 0.5, 65, 10.5);
    advance(2.5);
    for (let i = 0; i < 40 && match.phase === 'live'; i++) { match.fire(1, aim({ x: 0.5, y: 65, z: 0.5 }, body(10.5))); advance(0.15); }
    expect(match.phase).toBe('ended');
    advance(ENDED_SECONDS + 0.5);
    expect(match.phase).toBe('warmup');
    expect(match.info.map).toBe('suburb');
    expect(host.of('match').at(-1)?.info.map).toBe('suburb');
    // The respawn after the switch uses the new map's spawns.
    const spawn = host.of('spawn', 1).at(-1)!;
    expect(getMap('suburb').spawns.ffa.some((s) => s.x === spawn.x && s.z === spawn.z)).toBe(true);
  });
});

describe('weapon data', () => {
  it('has the contract weapons', () => {
    expect(WEAPONS.map((w) => w.id)).toEqual([
      'rifle', 'smg', 'shotgun', 'lmg', 'burst', 'dmr', 'semisniper', 'sniper', 'battle', 'lever', 'antimat', 'pistol', 'mpistol', 'revolver', 'knife',
    ]);
  });
});
