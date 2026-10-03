"""
Standard performance report: a scripted flight through a fresh world, printed as one table.

  python3 scripts/perf-report.py [--browser chromium|webkit] [--seconds 30] [--distance 8]
                                 [--cpu 1] [--speed fast|walk] [--port 5199] [--json out.json]

Starts a Vite dev server without HMR/file watching (see CLAUDE.md) and drives window.game:
the player flies in a slow S-curve at sprint speed and the page records every animation frame.
Chromium runs with --use-angle=metal on macOS (the default SwiftShader renderer would make every
number meaningless); --cpu 4 throttles the main thread 4x through CDP to emulate a weak laptop.
GC pauses come from a CDP trace of the renderer main thread (MinorGC / MajorGC events).
"""
import argparse
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Runs in the page: records frame gaps and CPU time of the game loop for `seconds`.
RECORDER = """
(seconds) => new Promise((resolve) => {
  const gaps = [];
  const g = window.game;
  const drawCalls = [];
  let last = performance.now(), start = last;
  const x0 = g.player.x, z0 = g.player.z;
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    drawCalls.push(g.renderer.stats.drawCalls);
    if (now - start < seconds * 1000) requestAnimationFrame(tick);
    else resolve({ gaps, drawCalls, chunks: g.world.chunks.stats(), dist: g.world.chunks.renderDistance,
      scale: g.dynamicResolution.scale, px: g.player.x - x0, pz: g.player.z - z0 });
  };
  requestAnimationFrame(tick);
})
"""


def pct(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, int(len(s) * p))]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def start_server(port):
    port = port or free_port()
    cfg = os.path.join(ROOT, f'.vite.perf.{port}.config.mjs')
    with open(cfg, 'w') as f:
        f.write("export default { worker: { format: 'es' }, server: { port: %d, strictPort: true, hmr: false, watch: null } };" % port)
    proc = subprocess.Popen(['npx', 'vite', '--config', cfg], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, cfg, port


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--browser', default='chromium')
    ap.add_argument('--seconds', type=float, default=30)
    ap.add_argument('--distance', type=int, default=8)
    ap.add_argument('--cpu', type=float, default=1)
    ap.add_argument('--speed', default='fast')
    ap.add_argument('--port', type=int, default=0, help='0 = pick a free port')
    ap.add_argument('--url', default=None, help='use a running server instead of starting Vite')
    ap.add_argument('--json', default=None)
    ap.add_argument('--profile-out', default=None, help='save the raw .cpuprofile here')
    ap.add_argument('--eval', default=None, help='JavaScript to run in the page before the flight (experiments)')
    ap.add_argument('--alloc', action='store_true', help='also print the top JS allocation sites (CDP sampling heap profiler)')
    ap.add_argument('--profile', action='store_true', help='also print the top self-time functions (CDP CPU profiler)')
    args = ap.parse_args()

    proc = cfg = None
    url = args.url
    if not url:
        proc, cfg, port = start_server(args.port)
        url = f'http://localhost:{port}/'
        for _ in range(100):
            try:
                urllib.request.urlopen(url, timeout=1)
                break
            except OSError:
                time.sleep(0.2)
    try:
        with sync_playwright() as pw:
            if args.browser == 'webkit':
                browser = pw.webkit.launch()
            else:
                browser = pw.chromium.launch(args=['--use-angle=metal', '--enable-gpu-rasterization'])
            page = browser.new_page(viewport={'width': 1280, 'height': 800})
            page.goto(url)
            page.wait_for_function('window.game && window.game.state === "menu"', timeout=60000)
            cdp = page.context.new_cdp_session(page) if args.browser != 'webkit' else None
            t_enter = time.time()
            page.evaluate("""(d) => { const g = window.game; g.settings.set('renderDistance', d);
                g.createWorld('perf', '1234', 'creative'); }""", args.distance)
            page.wait_for_function('window.game.state !== "loading" && window.game.state !== "menu"', timeout=120000)
            enter_s = time.time() - t_enter
            page.evaluate("""(sprint) => { const g = window.game; g.input.locked = true; g.state = 'playing';
                g.player.flying = true; g.player.y = Math.max(g.player.y, 110);
                g.input.down.add('KeyW'); if (sprint) g.input.down.add('ShiftLeft'); }""", args.speed == 'fast')
            if args.eval:
                page.evaluate(args.eval)
            page.wait_for_timeout(3000)
            if cdp:
                if args.cpu != 1:
                    cdp.send('Emulation.setCPUThrottlingRate', {'rate': args.cpu})
                events = []
                cdp.on('Tracing.dataCollected', lambda e: events.extend(e['value']))
                done = []
                cdp.on('Tracing.tracingComplete', lambda e: done.append(1))
                cdp.send('Tracing.start', {'categories': 'v8,devtools.timeline,disabled-by-default-v8.gc',
                                           'transferMode': 'ReportEvents'})
                cdp.send('Performance.enable')
            # S-curve: keep turning slowly while the recorder runs.
            page.evaluate("() => { const g = window.game; window.__turn = setInterval(() => { g.input.mouseDX = Math.sin(performance.now() / 5000) * 1.5; }, 16); }")
            if cdp and args.profile:
                cdp.send('Profiler.enable')
                cdp.send('Profiler.setSamplingInterval', {'interval': 250})
                cdp.send('Profiler.start')
            if cdp and args.alloc:
                cdp.send('HeapProfiler.startSampling', {'samplingInterval': 4096, 'includeObjectsCollectedByMajorGC': True,
                                                         'includeObjectsCollectedByMinorGC': True})
            res = page.evaluate(RECORDER, args.seconds)
            alloc = cdp.send('HeapProfiler.stopSampling')['profile'] if cdp and args.alloc else None
            prof = cdp.send('Profiler.stop')['profile'] if cdp and args.profile else None
            page.evaluate('() => clearInterval(window.__turn)')
            gc = []
            gc_major = 0
            heap = {}
            if cdp:
                heap = {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
                cdp.send('Tracing.end')
                for _ in range(100):
                    if done:
                        break
                    page.wait_for_timeout(100)
                main_tid = None
                for e in events:
                    if e.get('ph') == 'M' and e.get('name') == 'thread_name' and e['args'].get('name') == 'CrRendererMain':
                        main_tid = (e['pid'], e['tid'])
                for e in events:
                    if e.get('name') in ('MinorGC', 'MajorGC') and e.get('ph') == 'X' \
                            and (main_tid is None or (e['pid'], e['tid']) == main_tid):
                        gc.append(e['dur'] / 1000)
                        gc_major += e['name'] == 'MajorGC'
                        if os.environ.get('GC_DEBUG'): print(e['name'], round(e['dur']/1000,1), e.get('args'))
                if args.cpu != 1:
                    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
            gaps = res['gaps'][5:]
            row = [
                ('browser', args.browser + (f' cpu x{args.cpu:g}' if args.cpu != 1 else '')),
                ('render distance', args.distance),
                ('world enter (s)', f'{enter_s:.1f}'),
                ('frames', len(gaps)),
                ('median frame (ms)', f'{statistics.median(gaps):.1f}'),
                ('p95 frame (ms)', f'{pct(gaps, 0.95):.1f}'),
                ('p99 frame (ms)', f'{pct(gaps, 0.99):.1f}'),
                ('worst frame (ms)', f'{max(gaps):.1f}'),
                ('long frames > 20 ms', sum(1 for x in gaps if x > 20)),
                ('long frames > 33 ms', sum(1 for x in gaps if x > 33)),
                ('GC pauses (n)', len(gc)),
                ('GC total (ms)', f'{sum(gc):.1f}'),
                ('GC major collections', gc_major),
                ('GC worst (ms)', f'{max(gc):.1f}' if gc else '-'),
                ('GC pauses > 4 ms', sum(1 for x in gc if x > 4)),
                ('draw calls (median)', int(statistics.median(res['drawCalls']))),
                ('JS heap (MB)', f"{heap.get('JSHeapUsedSize', 0) / 1048576:.0f}" if heap else '-'),
                ('distance flown (blocks)', int(abs(res['px']) + abs(res['pz']))),
                ('render distance end / dyn. scale', f"{res['dist']} / {res['scale']:.2f}"),
            ]
            width = max(len(k) for k, _ in row)
            for k, v in row:
                print(f'{k:<{width}}  {v}')
            if alloc:
                sites = {}
                stack = [alloc['head']]
                while stack:
                    n = stack.pop()
                    cf = n['callFrame']
                    key = f"{cf['functionName'] or '(anonymous)'} {cf['url'].split('/')[-1].split('?')[0]}:{cf['lineNumber']}"
                    sites[key] = sites.get(key, 0) + n['selfSize']
                    stack.extend(n['children'])
                total = sum(sites.values()) or 1
                print(f'\ntop allocation sites (sampled, still-live objects only; total {total / 1048576:.1f} MB):')
                for k, v in sorted(sites.items(), key=lambda kv: -kv[1])[:14]:
                    print(f'  {v / 1024:9.0f} KB  {100 * v / total:5.1f} %  {k}')
            if prof:
                self_us = {}
                nodes = {n['id']: n for n in prof['nodes']}
                for nid, dt in zip(prof['samples'], prof['timeDeltas']):
                    cf = nodes[nid]['callFrame']
                    key = f"{cf['functionName'] or '(anonymous)'} {cf['url'].split('/')[-1].split('?')[0]}:{cf['lineNumber']}"
                    self_us[key] = self_us.get(key, 0) + dt
                total = sum(self_us.values())
                if args.profile_out:
                    with open(args.profile_out, 'w') as f:
                        json.dump(prof, f)
                print('\ntop self time (main thread):')
                for k, v in sorted(self_us.items(), key=lambda kv: -kv[1])[:18]:
                    print(f'  {v / 1000:8.1f} ms  {100 * v / total:5.1f} %  {k}')
            if args.json:
                with open(args.json, 'w') as f:
                    json.dump({k: v for k, v in row}, f, indent=1)
            browser.close()
    finally:
        if proc:
            proc.terminate()
        if cfg and os.path.exists(cfg):
            os.remove(cfg)


if __name__ == '__main__':
    sys.exit(main())
