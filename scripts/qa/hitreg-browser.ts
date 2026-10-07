/**
 * Hit registration in real matches: what the shooter's screen showed vs what the server counted.
 *
 * Starts its own game server, a lag proxy (latency + jitter for the browsers) and a QA Vite server, creates a free
 * for all on Classic, lets two bots (honest movement, 30 position reports a second) walk up to the shooter and
 * strafe in the open, and opens two Chromium pages (`--use-angle=metal`): the shooter and a second player who
 * strafes and jumps in place. The shooter's page aims like a perfect human: every frame it puts the *crosshair*
 * on a random point of a drawn enemy model (head, torso, arm or leg, as the renderer poses it) with a clear line,
 * holds the trigger, and records per shot whether the line through the crosshair met a drawn model (the claim)
 * and what the server said (`ammo` acknowledges a shot, `hit` follows it).
 *
 *   npx tsx scripts/qa/hitreg-browser.ts [--root=.] [--rtt=100] [--jitter=20] [--seconds=60] [--ports=3491] [--weapon=0]
 *
 * `--root` runs the server and client of another checkout (an old commit unpacked with `git archive`), so the
 * same measurement runs before and after a change. Prints one JSON line with the counts at the end.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import { getMap } from '../../src/modes/maps';
import { BLOCK } from '../../src/world/BlockRegistry';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../src/net/protocol';
import { traceBlocks } from '../../server/Combat';
import { BOT_SPEED, arenaPath, clientStep, follow } from '../lib/arenaPath';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const ROOT = resolve(arg('root', '.'));
const RTT = Number(arg('rtt', '100')), JITTER = Number(arg('jitter', '20')), SECONDS = Number(arg('seconds', '60'));
const BASE_PORT = Number(arg('ports', '3491'));
const SP = BASE_PORT, LP = BASE_PORT + 1, VP = BASE_PORT + 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ChildProcess[] = [];

function start(cmd: string, args: string[], env: Record<string, string>, cwd = ROOT): ChildProcess {
  // Own process group: stopping it stops npx and the server / Vite it started (and nothing else).
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  p.stderr?.on('data', (d) => { if (process.env.HITREG_VERBOSE) process.stderr.write(d); });
  procs.push(p);
  return p;
}

async function waitHttp(url: string, ms = 60000): Promise<void> {
  for (let t = 0; t < ms; t += 300) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

// ---------------------------------------------------------------- bots

const map = getMap('classic');

class Bot {
  id = 0;
  pos = { x: 0, y: 65, z: 0 };
  route: [number, number, number?][] = [];
  variant = 0;
  alive = false;
  phase = '';
  yaw = 0;
  /** Where to strafe: two cells, and the shooter to face. */
  goal: { a: [number, number, number]; b: [number, number, number] } | null = null;
  private ws!: WebSocket;
  private timer: NodeJS.Timeout | null = null;
  private pauseUntil = 0;

  constructor(readonly name: string, readonly target: () => { x: number; y: number; z: number } | null) {}

  connect(url: string): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name }));
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as ServerMessage;
        if (m.t === 'welcome') { this.id = m.id; this.variant = map.variantFor(m.seed); res(); }
        if (m.t === 'spawn') { this.pos = { x: m.x, y: m.y, z: m.z }; this.route = []; this.goal = null; this.alive = true; }
        // The server's movement check put us back: go on from there.
        if (m.t === 'teleport') { this.pos = { x: m.x, y: m.y, z: m.z }; this.route = []; this.goal = null; }
        if (m.t === 'hp' && m.health <= 0) this.alive = false;
        if (m.t === 'match') this.phase = m.phase;
        if (m.t === 'kick') rej(new Error(m.reason));
      });
      this.timer = setInterval(() => this.tick(), 1000 / 30);
    });
  }

  private tick(): void {
    if (!this.id || !this.alive) return;
    const s = this.target();
    if (s && !this.goal && this.route.length === 0) this.plan(s);
    if (this.route.length === 0 && this.goal && performance.now() >= this.pauseUntil) {
      // Strafe: to the other end, sometimes after a short stop (people do not move like metronomes).
      const g = this.goal;
      const atA = Math.hypot(this.pos.x - g.a[0], this.pos.z - g.a[1]) < 0.3;
      const to = atA ? g.b : g.a;
      this.route = arenaPath(map, this.variant, [this.pos.x, this.pos.z, this.pos.y], to) ?? [];
      if (Math.random() < 0.3) this.pauseUntil = performance.now() + 150 + Math.random() * 350;
    }
    follow(this.pos, this.route, BOT_SPEED / 30);
    if (s) this.yaw = Math.atan2(-(s.x - this.pos.x), -(s.z - this.pos.z));
    this.send({ t: 'pos', x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: 0, flags: 4, held: 0, step: clientStep() });
  }

  /** A strafe line 10-22 blocks from the shooter, both ends in its clear view, and a route there. */
  private plan(s: { x: number; y: number; z: number }): void {
    const at = (x: number, y: number, z: number) => map.blockAt(this.variant, x, y, z);
    for (let tries = 0; tries < 300; tries++) {
      const ang = Math.random() * Math.PI * 2, d = 10 + Math.random() * 12;
      const cx = Math.floor(s.x + Math.cos(ang) * d) + 0.5, cz = Math.floor(s.z + Math.sin(ang) * d) + 0.5;
      // Perpendicular to the line of sight, 3 blocks long.
      const px = -Math.sin(ang), pz = Math.cos(ang);
      const a: [number, number, number] = [Math.floor(cx + px * 1.5) + 0.5, Math.floor(cz + pz * 1.5) + 0.5, 65];
      const b: [number, number, number] = [Math.floor(cx - px * 1.5) + 0.5, Math.floor(cz - pz * 1.5) + 0.5, 65];
      // Only open air in between (no windows, fences or leaves: the old client treats those differently), with a
      // margin around the body line.
      const air = { getBlock: (x: number, y: number, z: number) => (at(x, y, z) === 0 ? 0 : BLOCK.STONE) };
      const clear = (p: [number, number, number]) => {
        for (const h of [0.2, 0.9, 1.7]) for (const side of [-0.5, 0, 0.5]) {
          const tx = p[0] + px * side, tz = p[1] + pz * side;
          const dx = tx - s.x, dy = p[2] + h - (s.y + 1.62), dz = tz - s.z, l = Math.hypot(dx, dy, dz);
          if (traceBlocks(air, s.x, s.y + 1.62, s.z, dx / l, dy / l, dz / l, l) < l) return false;
        }
        return true;
      };
      if (!clear(a) || !clear(b)) continue;
      const route = arenaPath(map, this.variant, [this.pos.x, this.pos.z, this.pos.y], a);
      if (!route || route.some((r) => r[2] !== 65)) continue;
      const back = arenaPath(map, this.variant, a, b);
      if (!back || back.some((r) => r[2] !== 65)) continue;
      this.goal = { a, b };
      this.route = route;
      return;
    }
  }

  send(m: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

// ---------------------------------------------------------------- page side

/** Installed in the shooter's page: aims the crosshair at drawn models, fires, records claims and verdicts. */
const SHOOTER = `(() => {
  const g = window.game, a = g.arcade, p = g.player;
  const newCam = 'appliedKick' in g.cam;
  const R = window.__hr = { shots: [], kills: [], acks: [], err: null, appear: new Map(), cycle: 0, frames: 0, aimed: 0, why: {} };
  const why = (k) => { R.why[k] = (R.why[k] || 0) + 1; };
  const prevMag = [99, 99, 99];
  const rotY = (v, t) => [v[0] * Math.cos(t) + v[2] * Math.sin(t), v[1], -v[0] * Math.sin(t) + v[2] * Math.cos(t)];
  const rotX = (v, t) => [v[0], v[1] * Math.cos(t) - v[2] * Math.sin(t), v[1] * Math.sin(t) + v[2] * Math.cos(t)];
  function rayBox(o, d, lo, hi) {
    let t0 = 0, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) { if (o[i] < lo[i] || o[i] > hi[i]) return -1; continue; }
      let u = (lo[i] - o[i]) / d[i], v = (hi[i] - o[i]) / d[i];
      if (u > v) { const s = u; u = v; v = s; }
      if (u > t0) t0 = u; if (v < t1) t1 = v;
      if (t0 > t1) return -1;
    }
    return t0;
  }
  // The part's rotation as MobRenderer poses an (armed) player.
  function partRot(m, anim, v, inverse) {
    const pitch = -m.headPitch, sw = Math.cos(m.limbSwing * 0.6662) * 1.4 * m.limbAmount;
    const s = inverse ? -1 : 1;
    if (anim === 'head') return rotX(v, s * pitch);
    if (m.holding && anim === 'armR') return rotX(v, s * (Math.PI / 2 + pitch));
    if (m.holding && anim === 'armL') return inverse ? rotX(rotY(v, 0.5), -(Math.PI / 2 + pitch - 0.25)) : rotY(rotX(v, Math.PI / 2 + pitch - 0.25), -0.5);
    if (!m.holding && (anim === 'armL' || anim === 'armR')) { const ph = m.limbSwing * 0.6662 + (anim === 'armL' ? 0 : Math.PI); return rotX(v, s * Math.cos(ph) * m.limbAmount); }
    if (anim === 'legA') return rotX(v, s * sw);
    if (anim === 'legB') return rotX(v, -s * sw);
    return v;
  }
  const kindOf = (anim) => anim === 'head' ? 'head' : anim === 'none' ? 'body' : anim.startsWith('arm') ? 'arm' : 'leg';
  function drawnHit(m, o, d) {
    const sc = m.renderScale; let best = Infinity, part = null;
    for (const mp of m.type.parts) {
      if (!['head', 'none', 'armL', 'armR', 'legA', 'legB'].includes(mp.anim)) continue;
      const pv = mp.pivot.map((c) => c / 16);
      let lo = rotY([o[0] - m.x, o[1] - m.y, o[2] - m.z], -m.yaw).map((c) => c / sc);
      let ld = rotY(d, -m.yaw).map((c) => c / sc);
      lo = partRot(m, mp.anim, [lo[0] - pv[0], lo[1] - pv[1], lo[2] - pv[2]], true); lo = [lo[0] + pv[0], lo[1] + pv[1], lo[2] + pv[2]];
      ld = partRot(m, mp.anim, ld, true);
      const b = mp.boxes[0];
      const t = rayBox(lo, ld, b.from.map((c) => c / 16), b.to.map((c) => c / 16));
      if (t >= 0 && t < best) { best = t; part = kindOf(mp.anim); }
    }
    return part;
  }
  function modelPoint(m, kind) {
    const anims = kind === 'head' ? ['head'] : kind === 'body' ? ['none'] : kind === 'arm' ? ['armL', 'armR'] : ['legA', 'legB'];
    const anim = anims[Math.floor(Math.random() * anims.length)];
    const mp = m.type.parts.find((q) => q.anim === anim);
    const b = mp.boxes[0], pv = mp.pivot.map((c) => c / 16);
    let v = [0, 1, 2].map((i) => (b.from[i] + (b.to[i] - b.from[i]) * (0.15 + 0.7 * Math.random())) / 16 - pv[i]);
    v = partRot(m, anim, v, false);
    v = rotY(v.map((c, i) => (c + pv[i]) * m.renderScale), m.yaw);
    return [m.x + v[0], m.y + v[1], m.z + v[2]];
  }
  function clearLine(o, t) {
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]], len = Math.hypot(...d);
    for (let s = 0.3; s < len - 0.3; s += 0.1) {
      const x = Math.floor(o[0] + d[0] * s / len), y = Math.floor(o[1] + d[1] * s / len), z = Math.floor(o[2] + d[2] * s / len);
      if (g.getBlock(x, y, z) !== 0) return false;
    }
    return true;
  }
  let target = null, kind = 'body', claim = null, retarget = 0, claimDrawn = null;
  const idOf = (m) => { for (const [id, r] of g.remote.players) if (r.mob === m) return id; return -1; };
  function aim(now) {
    R.frames++;
    claim = null;
    for (const m of g.remote.mobs) if (!R.appear.has(m)) R.appear.set(m, now);
    for (const m of [...R.appear.keys()]) if (!g.remote.mobs.includes(m)) R.appear.delete(m);
    const eye = [p.x, p.eyeY, p.z];
    if (now >= retarget || !target || !g.remote.mobs.includes(target)) {
      // Nearest living, settled (out of spawn protection) model in clear view; a new body part every ~0.4 s.
      target = null; let best = Infinity;
      for (const m of g.remote.mobs) {
        if (m.health <= 0) { why('dead'); continue; }
        if (now - R.appear.get(m) < 2.6) { why('fresh'); continue; }
        const c = [m.x, m.y + 0.9, m.z];
        const dd = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
        if (!clearLine(eye, c)) { why('los'); continue; }
        if (dd < best && dd > 3) { best = dd; target = m; }
      }
      const u = Math.random();
      kind = u < 0.25 ? 'head' : u < 0.6 ? 'body' : u < 0.8 ? 'arm' : 'leg';
      retarget = now + 0.4;
    }
    const fire = () => { g.input.down.add('Mouse0'); };
    const hold = () => { g.input.down.delete('Mouse0'); };
    g.input.down.add('Mouse2');
    if (!target || target.health <= 0) { why('notarget'); return hold(); }
    const pt = modelPoint(target, kind);
    const d = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]], len = Math.hypot(...d);
    const dir = d.map((c) => c / len);
    if (!clearLine(eye, pt)) { why('ptlos'); return hold(); }
    // The crosshair on the point: new client: it is drawn at the aim (view pitch); old client: at the screen centre,
    // which the recoil kick lifts above the aim.
    const kick = newCam ? 0 : (g.cam.reducedMotion ? 0.25 : 1) * g.cam.kick;
    p.yaw = Math.atan2(-dir[0], -dir[2]);
    p.pitch = Math.asin(dir[1]) - kick;
    // What the crosshair line meets first among the drawn models.
    let first = null, firstT = Infinity;
    for (const m of g.remote.mobs) {
      if (m.health <= 0) continue;
      const part = drawnHit(m, eye, dir);
      if (part) { const t = Math.hypot(m.x - eye[0], m.z - eye[2]); if (t < firstT) { firstT = t; first = { part, m }; } }
    }
    if (!first) { why('noclaim'); return hold(); }
    if (now - R.appear.get(first.m) < 2.6) { why('claimfresh'); return hold(); }
    claim = first.part;
    claimDrawn = [first.m.x, first.m.y, first.m.z, first.m.yaw, -first.m.headPitch, idOf(first.m)];
    R.aimed++;
    // Aimed down the sights (DMR: 0.1° spread, so the crosshair line is the bullet's), one click per shot.
    if (g.arcade.ads < 0.95) { why('ads'); return hold(); }
    g.input.pressed.add('Mouse0');
    fire();
  }
  const origUpdate = a.update.bind(a);
  a.update = (f, input) => { try { aim(f.now); } catch (e) { R.err = String(e.stack || e); } return origUpdate(f, input); };
  const origSend = a.d.send;
  a.d.send = (msg) => {
    if (msg.t === 'fire') R.shots.push({ t: performance.now(), weapon: a.weapon.id, claim, drawn: claim ? claimDrawn : null, ray: [msg.ox, msg.oy, msg.oz, msg.dx, msg.dy, msg.dz], rk: msg.rk ?? -1, seq: msg.seq ?? -1, acked: false, hit: false, head: false, slot: msg.slot, dbg: null });
    return origSend(msg);
  };
  const origHandle = a.handle.bind(a);
  let lastAcked = -1;
  a.handle = (msg, now) => {
    try {
      if (msg.t === 'ammo') {
        const down = !msg.reloading && msg.mag < prevMag[msg.slot];
        prevMag[msg.slot] = msg.mag;
        if (msg.seq !== undefined) {
          const i = R.shots.findIndex((s) => s.seq === msg.seq);
          if (i >= 0) { R.shots[i].acked = true; lastAcked = i; }
        } else if (down) {
          const i = R.shots.findIndex((s) => !s.acked && s.slot === msg.slot);
          if (i >= 0) { R.shots[i].acked = true; lastAcked = i; }
        }
      } else if (msg.t === 'shotdbg') {
        const i = R.shots.findIndex((s) => s.seq === msg.seq);
        if (i >= 0) R.shots[i].dbg = msg;
      } else if (msg.t === 'hit') {
        const i = msg.seq !== undefined ? R.shots.findIndex((s) => s.seq === msg.seq) : lastAcked;
        if (i >= 0) {
          R.shots[i].hit = true; R.shots[i].head = R.shots[i].head || msg.head;
          // Shots already on their way at a target that this one killed are not hit registration misses.
          if (msg.killed) R.kills.push({ victim: msg.victim, t: R.shots[i].t });
        }
      }
    } catch (e) { R.err = String(e); }
    return origHandle(msg, now);
  };
})()`;

/** Installed in the second player's page: strafes left and right in uneven legs, jumps now and then. */
const STRAFER = `(() => {
  const g = window.game;
  let until = 0, left = true;
  setInterval(() => {
    const now = performance.now();
    g.input.locked = true; if (g.state === 'paused') g.state = 'playing';
    if (now < until) return;
    left = !left;
    until = now + 250 + Math.random() * 550;
    g.input.down.delete(left ? 'KeyD' : 'KeyA');
    g.input.down.add(left ? 'KeyA' : 'KeyD');
    if (Math.random() < 0.25) { g.input.down.add('Space'); setTimeout(() => g.input.down.delete('Space'), 120); }
  }, 30);
})()`;

async function joinPage(page: Page, base: string, code: string, name: string): Promise<void> {
  await page.goto(`${base}/?join=${code}`);
  await page.waitForFunction(() => (window as unknown as { game?: unknown }).game && document.querySelector('.mc-btn'), undefined, { timeout: 60000 });
  await page.getByPlaceholder('Your name (3-16 letters)').fill(name);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => ['playing', 'paused'].includes((window as unknown as { game: { state: string } }).game.state), undefined, { timeout: 90000 });
}

interface Shot {
  t: number; claim: string | null; drawn: number[] | null; ray: number[]; seq: number; acked: boolean; hit: boolean; head: boolean;
  dbg: { targets: number[][]; hits: number[]; ray: number[]; rewind: number; rk: number; tick: number } | null;
}

/**
 * Counts per claimed part. Not counted: shots fired after a shot that killed their target (within 3.5 s), while the
 * kill was still on its way back. With a debug server (ARCADE_SHOT_DEBUG) also: how far the tested target was from
 * the drawn one, and the denied shots in detail.
 */
function summarize(all: Shot[], kills: { victim: number; t: number }[]) {
  const afterKill = (x: Shot) => !!x.drawn && kills.some((k) => k.victim === x.drawn![5] && x.t > k.t && x.t < k.t + 3500);
  const s = all.filter((x) => x.acked && !afterKill(x));
  const claimed = s.filter((x) => x.claim);
  const byPart: Record<string, { shots: number; denied: number; head: number }> = {};
  for (const x of claimed) {
    const b = byPart[x.claim!] ??= { shots: 0, denied: 0, head: 0 };
    b.shots++;
    if (!x.hit) b.denied++;
    if (x.head) b.head++;
  }
  const errs: number[] = [];
  const deniedDetail: unknown[] = [];
  for (const x of claimed) {
    if (!x.drawn || !x.dbg) continue;
    const t = x.dbg.targets.find((q) => q[0] === x.drawn![5]);
    const e = t ? Math.hypot(t[1] - x.drawn[0], t[2] - x.drawn[1], t[3] - x.drawn[2]) : NaN;
    if (t) errs.push(e);
    if (!x.hit && deniedDetail.length < 30) {
      deniedDetail.push({ part: x.claim, err: Math.round(e * 100) / 100, drawn: x.drawn.map((v) => Math.round(v * 100) / 100), tested: t ?? null, serverHits: x.dbg.hits, rewind: x.dbg.rewind });
    }
  }
  errs.sort((p, q) => p - q);
  const denied = claimed.filter((x) => !x.hit).length;
  return {
    weapons: [...new Set(all.map((x) => (x as unknown as { weapon: string }).weapon))], shots: all.length, counted: s.length, claimed: claimed.length, denied, denyRate: claimed.length ? denied / claimed.length : null,
    surprise: s.filter((x) => !x.claim && x.hit).length, afterKill: all.length - all.filter((x) => !afterKill(x)).length, byPart,
    meanErr: errs.length ? errs.reduce((p, q) => p + q, 0) / errs.length : null, p90Err: errs.length ? errs[Math.floor(errs.length * 0.9)] : null,
    deniedDetail,
  };
}

async function main(): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), 'bunk-hitreg-'));
  start('npx', ['tsx', 'server/index.ts'], { PORT: String(SP), DATA_DIR: data, ROOM_CREATE_LIMIT: '1000', MAX_CONN_PER_IP: '100', LOG_FORMAT: 'text', ARCADE_SHOT_DEBUG: '1', PROFILES: 'off' });
  start('npx', ['tsx', resolve('scripts/qa/lag-proxy.ts'), `--listen=${LP}`, `--target=${SP}`, `--rtt=${RTT}`, `--jitter=${JITTER}`], {}, process.cwd());
  start('npx', ['vite', '--config', 'scripts/qa/vite.qa.config.ts', '--port', String(VP), '--strictPort'], { QA_SERVER_PORT: String(LP) });
  const server = `http://localhost:${SP}`, base = `http://localhost:${VP}`;
  await waitHttp(`${server}/health`);
  await waitHttp(`${base}/`);
  const res = await fetch(`${server}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Hitreg', gameType: 'ffa', mapId: 'classic', scoreLimit: 500, timeLimitSec: 1800 }),
  });
  const { code } = await res.json() as { code: string };
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const ctxB = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const shooter = await ctxA.newPage(), strafer = await ctxB.newPage();
  const errors: string[] = [];
  shooter.on('pageerror', (e) => errors.push(String(e)));
  await joinPage(shooter, base, code, 'Shooter');
  await joinPage(strafer, base, code, 'Strafer');
  let shooterPos: { x: number; y: number; z: number } | null = null;
  const bots = [new Bot('BotOne', () => shooterPos), new Bot('BotTwo', () => shooterPos)];
  for (const b of bots) await b.connect(`ws://localhost:${SP}/ws/${code}`);
  const lock = async (pg: Page) => pg.evaluate(() => {
    const g = (window as unknown as { game: { input: { locked: boolean }; state: string } }).game;
    g.input.locked = true; if (g.state === 'paused') g.state = 'playing';
  });
  // The DMR (0.1° spread aimed): the line through the crosshair is the bullet's, old and new client alike. Chosen in
  // the warm-up, where a class applies at once.
  await shooter.evaluate(() => {
    const g = (window as unknown as { game: { arcade: { chooseClass(c: object, custom: boolean): void } } }).game;
    g.arcade.chooseClass({ primary: 'dmr', secondary: 'pistol', optic: 'iron', perk: 'none' }, false);
  });
  // Live after the warm-up.
  for (let i = 0; i < 80 && bots[0].phase !== 'live'; i++) { await shooter.bringToFront(); await lock(shooter); await lock(strafer); await sleep(250); }
  await sleep(2500); // spawn protection
  await shooter.evaluate(SHOOTER);
  await strafer.evaluate(STRAFER);
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await shooter.bringToFront();
    await lock(shooter);
    shooterPos = await shooter.evaluate(() => {
      const g = (window as unknown as { game: { player: { x: number; y: number; z: number } } }).game;
      return { x: g.player.x, y: g.player.y, z: g.player.z };
    });
    await sleep(200);
    if (process.env.HITREG_VERBOSE && Math.floor((Date.now() - t0) / 5000) !== Math.floor((Date.now() - t0 - 200) / 5000)) {
      const page = await shooter.evaluate(() => {
        const w = window as unknown as { game: { remote: { mobs: { x: number; z: number; health: number }[] }; arcade: { ads: number; phase: string; dead: boolean } }; __hr: { aimed: number; shots: unknown[] } };
        return { mobs: w.game.remote.mobs.map((m) => [Math.round(m.x), Math.round(m.z), m.health]), ads: w.game.arcade.ads, phase: w.game.arcade.phase, dead: w.game.arcade.dead, aimed: w.__hr.aimed, shots: w.__hr.shots.length, why: (w.__hr as unknown as { why: unknown }).why };
      });
      console.error(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), me: shooterPos && [Math.round(shooterPos.x), Math.round(shooterPos.z)], bots: bots.map((b) => ({ p: [Math.round(b.pos.x), Math.round(b.pos.z)], alive: b.alive, goal: b.goal?.a, route: b.route.length })), page }));
    }
  }
  await shooter.evaluate(() => { (window as unknown as { game: { input: { down: Set<string> } } }).game.input.down.delete('Mouse0'); });
  await sleep(1500); // last verdicts
  const raw = await shooter.evaluate(() => {
    const R = (window as unknown as { __hr: { shots: unknown[]; kills: unknown[]; err: string | null; frames: number; aimed: number } }).__hr;
    return { shots: R.shots, kills: R.kills, err: R.err, frames: R.frames, aimed: R.aimed };
  }) as { shots: Shot[]; kills: { victim: number; t: number }[]; err: string | null; frames: number; aimed: number };
  const dump = arg('dump', '');
  if (dump) writeFileSync(dump, JSON.stringify({ shots: raw.shots, kills: raw.kills }));
  const out = summarize(raw.shots, raw.kills);
  const fps = await shooter.evaluate(() => (window as unknown as { game: { fps?: number } }).game.fps ?? null);
  console.log(JSON.stringify({ root: ROOT, rtt: RTT, jitter: JITTER, seconds: SECONDS, fps, aimedFrames: raw.aimed, frames: raw.frames, pageErr: raw.err, ...out, pageErrors: errors.slice(0, 3) }));
  for (const b of bots) b.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const p of procs) { try { if (p.pid) process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => process.exit(), 500);
});
