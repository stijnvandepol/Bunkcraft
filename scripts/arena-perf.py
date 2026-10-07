"""
Arena performance report: a real BunkCraft Realms match with bots, measured in the browser.

  python3 scripts/arena-perf.py [--map classic] [--type tdm] [--players 16] [--seconds 25]
                                [--browser chromium|webkit] [--cpu 4] [--profile] [--alloc] [--json out.json]
  python3 scripts/arena-perf.py --map all --players 16 --cpu 4 --json-dir /tmp/arena   # every arena map

Starts its own game server (free port, temp DATA_DIR, ROOM_CREATE_LIMIT=1000; never port 3000) and a Vite dev server
without HMR/file watching that proxies /ws and /api to it, creates an arena room, fills it with players-1 protocol bots
(scripts/arena-perf-bots.ts: they walk, aim and fire, so the client gets tracers, impacts, kills, sounds and a busy
kill feed) and joins it from the browser. The player holds the trigger and turns slowly while the page records every
animation frame. Restart-free: every run starts fresh servers, so it always measures the code on disk.

Reported: frame time p50/p95/p99, long frames, GC pauses (Chromium trace), draw calls and triangles, network bytes
per second in and out (counted in the page on both browsers), click-to-muzzle-flash latency, and with --profile the
main-thread JS self time grouped by subsystem (remote players, viewmodel, particles/tracers, HUD, audio, network, ...)
plus the browser's style/layout/paint time (DOM churn).
"""
import argparse
import json
import os
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPS = ['classic', 'suburb', 'quarter', 'dockyard', 'desert', 'atomic', 'bunker', 'station', 'town', 'villa', 'yacht']

# Counts WebSocket traffic in the page (works the same in Chromium and WebKit).
WS_COUNTER = """
(() => {
  const S = window.__ws = { inBytes: 0, inMsgs: 0, outBytes: 0, outMsgs: 0 };
  const size = (d) => typeof d === 'string' ? d.length : (d.byteLength ?? d.size ?? 0);
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { S.outBytes += size(d); S.outMsgs++; return send.call(this, d); };
  const Orig = WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...a) { super(...a); this.addEventListener('message', (e) => { S.inBytes += size(e.data); S.inMsgs++; }); }
  };
})();
"""

RECORDER = """
(seconds) => new Promise((resolve) => {
  const gaps = [], drawCalls = [], tris = [];
  const g = window.game;
  const ws0 = { ...window.__ws };
  // Main-loop JS time per frame (update + render submission): comparable across browsers, unlike frame gaps that sit
  // at the display refresh while there is headroom. Game.frame re-requests itself through the property.
  const work = [], frame = g.frame;
  g.frame = (t) => { const a = performance.now(); frame(t); work.push(performance.now() - a); };
  let last = performance.now(), start = last;
  let shots = 0, kills = 0, remotes = 0;
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    drawCalls.push(g.renderer.stats.drawCalls);
    tris.push(g.renderer.stats.triangles);
    if (now - start < seconds * 1000) requestAnimationFrame(tick);
    else {
      const ws = window.__ws, el = (now - start) / 1000;
      g.frame = frame;
      resolve({ gaps, drawCalls, tris, work, scale: g.dynamicResolution.scale,
        inBps: (ws.inBytes - ws0.inBytes) / el, outBps: (ws.outBytes - ws0.outBytes) / el,
        inMps: (ws.inMsgs - ws0.inMsgs) / el, outMps: (ws.outMsgs - ws0.outMsgs) / el,
        remotes: g.remote.count ?? 0, phase: g.arcade && g.arcade.phase });
    }
  };
  requestAnimationFrame(tick);
})
"""

# --diag: which DOM nodes change how often (style/layout work comes from these).
MUTATIONS = """
() => {
  const counts = window.__mut = {};
  const name = (n) => n.nodeType === 1 ? (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : n.tagName.toLowerCase()) : '#text in ' + name(n.parentNode);
  window.__mo = new MutationObserver((list) => { for (const m of list) {
    const k = name(m.target) + ' · ' + (m.type === 'attributes' ? m.attributeName : m.type);
    counts[k] = (counts[k] || 0) + 1; } });
  window.__mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
}
"""

DIAG = """
(seconds) => {
  const g = window.game, three = g.renderer.three;
  window.__mo.disconnect();
  const mutations = {};
  for (const [k, v] of Object.entries(window.__mut)) mutations[k] = v / seconds;
  let objects = 0, autoUpdate = 0, visible = 0; const types = {};
  g.renderer.scene.traverse((o) => { objects++; if (o.matrixAutoUpdate) autoUpdate++; if (o.visible) visible++; types[o.type] = (types[o.type] || 0) + 1; });
  return { objects, autoUpdate, visible, types, mutations, programs: three.info.programs.length,
    geometries: three.info.memory.geometries, textures: three.info.memory.textures };
}
"""

# Click → muzzle flash: a real mousedown on the canvas, then the first animation frame after the viewmodel fired.
LATENCY = """
(n) => new Promise((resolve) => {
  const g = window.game, vm = g.arcade.viewmodel, canvas = document.getElementById('game');
  const fire = vm.fire.bind(vm);
  let firedAt = 0;
  vm.fire = () => { firedAt = performance.now(); fire(); };
  const out = [];
  let i = 0;
  const one = () => {
    if (i++ >= n) { vm.fire = fire; return resolve(out); }
    g.input.down.delete('Mouse0');
    firedAt = 0;
    setTimeout(() => {
      const t0 = performance.now();
      canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      const wait = (now) => {
        if (firedAt) { out.push(now - t0); window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })); setTimeout(one, 250); }
        else if (performance.now() - t0 > 1000) { window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })); setTimeout(one, 250); }
        else requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    }, 120 + Math.random() * 200);
  };
  one();
})
"""

# Self time per source file → subsystem.
SUBSYSTEMS = [
    ('remote players', ('RemotePlayers', 'PlayerModel', 'NameTags', 'RemoteGear')),
    ('viewmodel', ('WeaponViewmodel', 'WeaponModels', 'HandRenderer')),
    ('particles/tracers', ('Particles', 'Tracers', 'ModeVisuals')),
    ('HUD (JS)', ('ArcadeHud', 'ModeHud', 'HUD', 'Hotbar', 'Chat', 'Announcer', 'MatchLobby', 'Scoreboard', 'KillFeed', 'Subtitles', 'DebugOverlay', 'EffectsHud')),
    ('audio', ('Audio', 'audio/')),
    ('network', ('NetClient', 'binary', 'protocol', 'NetEntities')),
    ('arcade logic', ('ArcadeSession', 'ArcadeLogic', 'Weapons', 'Recoil', 'Trigger')),
    ('mobs/entities', ('MobRenderer', 'EntityManager', 'ItemRenderer', 'Mob.')),
    ('world/chunks', ('ChunkManager', 'World', 'Lighting', 'ChunkMesher')),
    ('player/physics', ('Player', 'Physics', 'Collision', 'Camera')),
    ('three.js', ('three.module', 'three.core', 'three')),
    ('game loop', ('Game', 'Renderer', 'Sky', 'Clouds', 'Shadows', 'AdaptiveQuality', 'DayCycle')),
]


def subsystem(url, fn):
    base = url.split('/')[-1].split('?')[0]
    if not url:
        return fn if fn in ('(garbage collector)', '(program)', '(idle)') else '(native/other)'
    for name, keys in SUBSYSTEMS:
        for k in keys:
            if k in url.split('?')[0].split('/src/')[-1] and (k.endswith('/') or base.startswith(k.rstrip('.')) or k in base):
                return name
    return 'other: ' + base


def pct(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * p))] if s else 0


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_http(url, tries=300):
    for _ in range(tries):
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f'{url} did not come up')


def spawn(cmd, env=None, stdout=None):
    """Own process group: npx starts node as a child, and stopping npx alone would leave that child running."""
    return subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=stdout, stderr=subprocess.STDOUT, start_new_session=True)


def stop(p):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(5)
            return
        except subprocess.TimeoutExpired:
            pass


class Servers:
    """Game server + Vite on free ports; cleaned up on exit."""

    def __init__(self):
        self.game_port = free_port()
        self.vite_port = free_port()
        self.data = tempfile.mkdtemp(prefix='bunk-arena-perf-')
        env = dict(os.environ, PORT=str(self.game_port), DATA_DIR=self.data, ROOM_CREATE_LIMIT='1000')
        self.log = open(os.path.join(self.data, 'server.log'), 'w')
        self.game = spawn(['npx', 'tsx', 'server/index.ts'], env=env, stdout=self.log)
        self.cfg = os.path.join(ROOT, f'.vite.arenaperf.{self.vite_port}.config.ts')
        with open(self.cfg, 'w') as f:
            f.write(f"""import {{ mergeConfig }} from 'vite';
import base from './vite.config';
export default mergeConfig(base, {{ server: {{ port: {self.vite_port}, strictPort: true, hmr: false, watch: null,
  proxy: {{ '/ws': {{ target: 'ws://127.0.0.1:{self.game_port}', ws: true }}, '/api': {{ target: 'http://127.0.0.1:{self.game_port}' }} }} }} }});
""")
        self.vite = spawn(['npx', 'vite', '--config', self.cfg], stdout=subprocess.DEVNULL)
        wait_http(f'http://127.0.0.1:{self.game_port}/health')
        wait_http(f'http://localhost:{self.vite_port}/')
        self.bots = None

    def create_room(self, game_type, map_id, server_bots=0):
        room = {'name': f'perf {map_id}', 'gameType': game_type, 'mapId': map_id, 'scoreLimit': 1000, 'timeLimitSec': 1800, 'maxPlayers': 16}
        if server_bots:
            room.update(bots=server_bots, botDifficulty='normal')
        body = json.dumps(room).encode()
        req = urllib.request.Request(f'http://127.0.0.1:{self.game_port}/api/rooms', data=body,
                                     headers={'content-type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req) as r:
            d = json.loads(r.read())
        return d['code'], d['ownerToken']

    def start_bots(self, code, token, n):
        self.stop_bots()
        self.bots = spawn(['npx', 'tsx', 'scripts/arena-perf-bots.ts', f'http://127.0.0.1:{self.game_port}', code, token, str(n)], stdout=self.log)

    def stop_bots(self):
        if self.bots:
            stop(self.bots)
            self.bots = None

    def close(self):
        self.stop_bots()
        for p in (self.vite, self.game):
            stop(p)
        if os.path.exists(self.cfg):
            os.remove(self.cfg)


def measure(srv, pw, args, map_id):
    code, token = srv.create_room(args.type, map_id, args.players - 1 if args.server_bots else 0)
    if args.browser == 'webkit':
        browser = pw.webkit.launch()
    else:
        browser = pw.chromium.launch(args=['--use-angle=metal', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    page.add_init_script(WS_COUNTER)
    page.add_init_script("try { localStorage.setItem('bunkcraft.name', 'perfplayer'); } catch (e) {}")
    page.goto(f'http://localhost:{srv.vite_port}/')
    page.wait_for_function('window.game && window.game.state === "menu" && window.game.last > 0', timeout=90000)
    if not args.dynres:
        page.evaluate("() => window.game.settings.set('dynamicResolution', false)")
    t_join = time.time()
    page.evaluate("(c) => window.game.joinServer('perfplayer', '', c)", code)
    page.wait_for_function('window.game.state !== "loading" && window.game.state !== "menu" && !!window.game.arcade', timeout=120000)
    join_s = time.time() - t_join
    if not args.server_bots:
        srv.start_bots(code, token, args.players - 1)
    page.evaluate("() => { const g = window.game; g.input.locked = true; g.state = 'playing'; document.querySelector('.click-to-play')?.remove(); }")
    # Warm-up ends once enough players are in; the bots need a few seconds to join and spawn.
    page.wait_for_function("window.game.arcade && window.game.arcade.phase === 'live'", timeout=90000)
    page.evaluate("""() => { const g = window.game; g.input.locked = true; g.state = 'playing';
        window.__turn = setInterval(() => { g.input.locked = true; if (g.state !== 'playing' && g.state !== 'chat') g.state = 'playing';
          g.input.mouseDX = Math.sin(performance.now() / 4000) * 2.5;
          const t = performance.now() / 1500 | 0; g.input.down.delete('KeyA'); g.input.down.delete('KeyD');
          g.input.down.add(t % 2 ? 'KeyA' : 'KeyD'); g.input.down.add('Mouse0'); }, 16); }""")
    page.wait_for_timeout(int(args.warmup * 1000))
    if args.eval:
        page.evaluate(args.eval)
    cdp = page.context.new_cdp_session(page) if args.browser != 'webkit' else None
    events, done = [], []
    if cdp:
        if args.cpu != 1:
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': args.cpu})
        cdp.on('Tracing.dataCollected', lambda e: events.extend(e['value']))
        cdp.on('Tracing.tracingComplete', lambda e: done.append(1))
        cdp.send('Tracing.start', {'categories': 'v8,devtools.timeline,disabled-by-default-v8.gc', 'transferMode': 'ReportEvents'})
        cdp.send('Performance.enable')
        if args.profile:
            cdp.send('Profiler.enable')
            cdp.send('Profiler.setSamplingInterval', {'interval': 200})
            cdp.send('Profiler.start')
        if args.alloc:
            cdp.send('HeapProfiler.startSampling', {'samplingInterval': 4096, 'includeObjectsCollectedByMajorGC': True,
                                                     'includeObjectsCollectedByMinorGC': True})
    if args.diag:
        page.evaluate(MUTATIONS)
    res = page.evaluate(RECORDER, args.seconds)
    diag = page.evaluate(DIAG, args.seconds) if args.diag else None
    alloc = cdp.send('HeapProfiler.stopSampling')['profile'] if cdp and args.alloc else None
    prof = cdp.send('Profiler.stop')['profile'] if cdp and args.profile else None
    gc, gc_major, dom, heap = [], 0, {}, {}
    if cdp:
        heap = {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
        cdp.send('Tracing.end')
        for _ in range(150):
            if done:
                break
            page.wait_for_timeout(100)
        main_tid = None
        for e in events:
            if e.get('ph') == 'M' and e.get('name') == 'thread_name' and e['args'].get('name') == 'CrRendererMain':
                main_tid = (e['pid'], e['tid'])
        for e in events:
            if e.get('ph') != 'X' or (main_tid and (e['pid'], e['tid']) != main_tid):
                continue
            n = e.get('name')
            if n in ('MinorGC', 'MajorGC'):
                gc.append(e['dur'] / 1000)
                gc_major += n == 'MajorGC'
            elif n in ('UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'UpdateLayer', 'HitTest'):
                dom[n] = dom.get(n, 0) + e['dur'] / 1000
    lat = page.evaluate("() => { const g = window.game; clearInterval(window.__turn); g.input.down.clear(); }")
    lat = []
    if not args.no_latency:
        page.evaluate("""() => { const g = window.game; window.__keep = setInterval(() => { g.input.locked = true;
            if (g.state !== 'playing') g.state = 'playing'; }, 16); }""")
        lat = page.evaluate(LATENCY, 12)
    if cdp and args.cpu != 1:
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
    gaps = res['gaps'][5:]
    el = args.seconds
    row = [
        ('map', map_id),
        ('browser', args.browser + (f' cpu x{args.cpu:g}' if args.cpu != 1 else '')),
        ('players (bots + you)', f"{args.players} ({'server' if args.server_bots else 'protocol'} bots)"),
        ('remote players drawn', res['remotes']),
        ('join (s)', f'{join_s:.1f}'),
        ('frames', len(gaps)),
        ('fps (mean)', f'{len(gaps) / el:.0f}'),
        ('median frame (ms)', f'{statistics.median(gaps):.1f}'),
        ('p95 frame (ms)', f'{pct(gaps, 0.95):.1f}'),
        ('p99 frame (ms)', f'{pct(gaps, 0.99):.1f}'),
        ('worst frame (ms)', f'{max(gaps):.1f}'),
        ('frame JS mean (ms)', f"{statistics.mean(res['work']):.2f}" if res['work'] else '-'),
        ('frame JS p95 (ms)', f"{pct(res['work'], 0.95):.2f}" if res['work'] else '-'),
        ('long frames > 20 ms', sum(1 for x in gaps if x > 20)),
        ('long frames > 33 ms', sum(1 for x in gaps if x > 33)),
        ('GC pauses (n)', len(gc) if cdp else '-'),
        ('GC total (ms)', f'{sum(gc):.1f}' if cdp else '-'),
        ('GC major', gc_major if cdp else '-'),
        ('GC worst (ms)', f'{max(gc):.1f}' if gc else '-'),
        ('style+layout+paint (ms/s)', f'{sum(dom.values()) / el:.1f}' if cdp else '-'),
        ('draw calls (median)', int(statistics.median(res['drawCalls']))),
        ('triangles (median, k)', f"{statistics.median(res['tris']) / 1000:.0f}"),
        ('JS heap (MB)', f"{heap.get('JSHeapUsedSize', 0) / 1048576:.0f}" if heap else '-'),
        ('net in (KiB/s)', f"{res['inBps'] / 1024:.1f}"),
        ('net in (msgs/s)', f"{res['inMps']:.0f}"),
        ('net out (KiB/s)', f"{res['outBps'] / 1024:.1f}"),
        ('click→flash p50 (ms)', f'{statistics.median(lat):.1f}' if lat else '-'),
        ('click→flash max (ms)', f'{max(lat):.1f}' if lat else '-'),
        ('dyn. resolution scale', f"{res['scale']:.2f}"),
    ]
    width = max(len(k) for k, _ in row)
    for k, v in row:
        print(f'{k:<{width}}  {v}')
    out = {k: v for k, v in row}
    if diag:
        print(f"\nscene: {diag['objects']} objects ({diag['autoUpdate']} with matrixAutoUpdate, {diag['visible']} visible); "
              f"GL programs {diag['programs']}, geometries {diag['geometries']}, textures {diag['textures']}")
        print('  by type: ' + ', '.join(f'{k} {v}' for k, v in sorted(diag['types'].items(), key=lambda kv: -kv[1])))
        print('DOM mutations per second (target · kind):')
        for k, v in sorted(diag['mutations'].items(), key=lambda kv: -kv[1])[:15]:
            print(f'  {v:7.1f}  {k}')
        out['diag'] = diag
    if dom:
        print('\nbrowser main-thread work (ms/s): ' + ', '.join(f'{k} {v / el:.1f}' for k, v in sorted(dom.items(), key=lambda kv: -kv[1])))
        out['dom'] = {k: round(v / el, 2) for k, v in dom.items()}
    if prof:
        self_us, by_sub = {}, {}
        nodes = {n['id']: n for n in prof['nodes']}
        for nid, dt in zip(prof['samples'], prof['timeDeltas']):
            cf = nodes[nid]['callFrame']
            key = f"{cf['functionName'] or '(anonymous)'} {cf['url'].split('/')[-1].split('?')[0]}:{cf['lineNumber']}"
            self_us[key] = self_us.get(key, 0) + dt
            sub = subsystem(cf['url'], cf['functionName'])
            by_sub[sub] = by_sub.get(sub, 0) + dt
        busy = sum(v for k, v in by_sub.items() if k != '(idle)') / 1000
        print(f'\nmain-thread busy: {busy / el:.0f} ms/s, {busy / max(1, len(gaps)):.2f} ms per frame')
        out['busy ms/frame'] = round(busy / max(1, len(gaps)), 2)
        print('\nmain-thread self time by subsystem (ms per second):')
        for k, v in sorted(by_sub.items(), key=lambda kv: -kv[1])[:20]:
            if k != '(idle)':
                print(f'  {v / 1000 / el:7.2f}  {k}')
        out['subsystems'] = {k: round(v / 1000 / el, 2) for k, v in by_sub.items()}
        print('\ntop self time (main thread, ms per second):')
        for k, v in sorted(self_us.items(), key=lambda kv: -kv[1])[:25]:
            if not k.startswith('(idle)'):
                print(f'  {v / 1000 / el:7.2f}  {k}')
        if args.profile_out:
            with open(args.profile_out, 'w') as f:
                json.dump(prof, f)
    if alloc:
        sites, chains = {}, {}
        stack = [(alloc['head'], ())]
        while stack:
            n, path = stack.pop()
            cf = n['callFrame']
            key = f"{cf['functionName'] or '(anonymous)'} {cf['url'].split('/')[-1].split('?')[0]}:{cf['lineNumber']}"
            sites[key] = sites.get(key, 0) + n['selfSize']
            if n['selfSize']:
                ch = chains.setdefault(key, {})
                caller = ' < '.join(path[-args.depth:][::-1])
                ch[caller] = ch.get(caller, 0) + n['selfSize']
            stack.extend((c, path + (key,)) for c in n['children'])
        total = sum(sites.values()) or 1
        print(f'\ntop allocation sites (sampled; total {total / 1048576:.1f} MB in {el:g} s = {total / 1024 / el:.0f} KB/s):')
        for k, v in sorted(sites.items(), key=lambda kv: -kv[1])[:16]:
            print(f'  {v / 1024:9.0f} KB  {100 * v / total:5.1f} %  {k}')
            if args.stacks:
                for c, cv in sorted(chains.get(k, {}).items(), key=lambda kv: -kv[1])[:2]:
                    print(f'              {cv / 1024:7.0f} KB  < {c}')
        out['allocKBps'] = round(total / 1024 / el, 1)
    browser.close()
    srv.stop_bots()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', default='classic', help="map id, comma list, or 'all'")
    ap.add_argument('--type', default='tdm')
    ap.add_argument('--players', type=int, default=16)
    ap.add_argument('--seconds', type=float, default=25)
    ap.add_argument('--warmup', type=float, default=4, help='seconds of play before recording')
    ap.add_argument('--browser', default='chromium')
    ap.add_argument('--cpu', type=float, default=1, help='Chromium CPU throttling (4 = weak laptop)')
    ap.add_argument('--dynres', action='store_true', help='keep dynamic resolution on (off by default: compare equal work)')
    ap.add_argument('--profile', action='store_true')
    ap.add_argument('--profile-out', default=None)
    ap.add_argument('--alloc', action='store_true')
    ap.add_argument('--stacks', action='store_true', help='with --alloc: print the main callers of each allocation site')
    ap.add_argument('--depth', type=int, default=3, help='caller frames shown by --stacks')
    ap.add_argument('--diag', action='store_true', help='also count scene objects, GL programs and DOM mutations per second')
    ap.add_argument('--no-latency', action='store_true')
    ap.add_argument('--json', default=None, help='write the result(s) here')
    ap.add_argument('--server-bots', action='store_true', help="the game server's own bots (server/bots) instead of protocol bots")
    ap.add_argument('--eval', default=None, help='JavaScript to run in the page before recording (experiments)')
    args = ap.parse_args()
    maps = MAPS if args.map == 'all' else args.map.split(',')
    srv = Servers()
    results = []
    try:
        with sync_playwright() as pw:
            # Warm-up load: a fresh Vite pre-bundles dependencies on the first visit and then reloads the page,
            # which would cut a measured join short.
            b = pw.chromium.launch()
            p = b.new_page()
            p.goto(f'http://localhost:{srv.vite_port}/')
            p.wait_for_function('window.game && window.game.state === "menu" && window.game.last > 0', timeout=120000)
            # Load an arena once too (arcade chunk, chunk worker): Vite optimises their dependencies on first use and the
            # stale requests of that first attempt fail, which sends a first join back to the title screen.
            p.evaluate("() => window.game.arcadePreview('tdm', 'You', 'classic')")
            p.wait_for_timeout(6000)
            b.close()
            for m in maps:
                print(f'\n=== {m}')
                try:
                    results.append(measure(srv, pw, args, m))
                except Exception as e:  # keep going with the other maps
                    print(f'FAILED on {m}: {e}')
                    srv.stop_bots()
    finally:
        srv.close()
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(results if len(results) != 1 else results[0], f, indent=1)


if __name__ == '__main__':
    sys.exit(main())
