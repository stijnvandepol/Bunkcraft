"""
Arcade client performance in a 16-player team deathmatch: 15 protocol bots (scripts/qa/arcade-perf-bots.ts:
classes from the presets, running and shooting) plus one real Chromium (--use-angle=metal) that plays along
(moves, aims, fires) while its frame times are sampled. Also reads the server's tick timing from /metrics.

  PORT=3488 ROOM_CREATE_LIMIT=1000 MAX_CONN_PER_IP=100 npx tsx server/index.ts
  QA_SERVER_PORT=3488 npx vite --config scripts/qa/vite.qa.config.mjs --port 5488
  QA_VITE=http://localhost:5488 QA_SERVER=http://localhost:3488 python3 scripts/qa/arcade-perf.py [label] [map=classic] [seconds=30]

Prints one JSON line: fps (mean), frame-time p50/p95/p99/max, long frames, server tick p50/p99.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, 'scripts/qa')
import qa_common as q  # noqa: E402

label = sys.argv[1] if len(sys.argv) > 1 else 'run'
map_id = sys.argv[2] if len(sys.argv) > 2 else 'classic'
seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 30
server = os.environ.get('QA_SERVER', 'http://localhost:3488')
bots_cwd = os.environ.get('QA_BOTS_CWD', '.')


def metrics():
    with urllib.request.urlopen(server + '/metrics') as r:
        out = {}
        for line in r.read().decode().splitlines():
            if line.startswith('#') or ' ' not in line:
                continue
            k, v = line.rsplit(' ', 1)
            try:
                out[k] = float(v)
            except ValueError:
                pass
        return out


SAMPLER = """
() => new Promise((resolve) => {
  const times = []; const cpu = []; let last = performance.now(); const end = last + %d * 1000;
  const g = window.game;
  let t = 0;
  function frame(now) {
    times.push(now - last); last = now;
    if (times.length %% 15 === 0) cpu.push(g.debug.frameMs);
    // Play along: strafe, turn slowly, aim and fire in bursts.
    t++;
    g.input.down[(t >> 6) & 1 ? 'add' : 'delete']('KeyA');
    g.input.down[(t >> 6) & 1 ? 'delete' : 'add']('KeyD');
    g.player.yaw += 0.004;
    g.input.down[(t >> 5) %% 3 === 0 ? 'add' : 'delete']('Mouse2');
    g.input.down[(t >> 4) & 1 ? 'add' : 'delete']('Mouse0');
    if (now < end) requestAnimationFrame(frame); else resolve({ times, cpu });
  }
  requestAnimationFrame(frame);
})
"""

with sync_playwright() as pw:
    b = q.launch(pw)
    page = q.open_game(b, 1280, 720)
    print('gpu', q.gpu(page), file=sys.stderr)
    code = q.create_room('tdm', map_id, score=1000, time_limit=1800, name='Perf arena')
    bots = subprocess.Popen(['npx', 'tsx', 'scripts/qa/arcade-perf-bots.ts', server, code, '15', str(seconds + 60), map_id],
                            cwd=bots_cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(4)
    q.join_room(page, code, 'Browser')
    page.evaluate('() => { game.stack.clear(); }')
    # Warm-up (10 s) then live.
    for _ in range(40):
        page.bring_to_front()
        if page.evaluate('() => game.arcade && game.arcade.phase') == 'live':
            break
        time.sleep(0.5)
    q.force_playing(page)
    page.evaluate('() => game.stack.clear()')
    time.sleep(3)
    m0 = metrics()
    page.bring_to_front()
    res = page.evaluate(SAMPLER % seconds)
    frames, cpu = res['times'], res['cpu']
    m1 = metrics()
    page.screenshot(path=f'/tmp/arcade-perf-{label}.png') if os.environ.get('QA_SHOT') else None
    voices = page.evaluate('() => game.audio.debugLine()')
    match = page.evaluate('() => ({ phase: game.arcade.phase, players: game.arcade.roster.length, kills: game.arcade.roster.reduce((a, p) => a + p.kills, 0) })')
    if bots.poll() is not None:
        print('bots exited early:', bots.stdout.read()[-2000:], file=sys.stderr)
    bots.terminate()
    b.close()

frames = sorted(frames[5:])
n = len(frames)
pct = lambda p: round(frames[min(n - 1, int(p * n))], 2)
mean = sum(frames) / n
tick = {k: round(v * 1000, 2) for k, v in m1.items() if k.startswith('bunkcraft_tick_duration_seconds{')}
print(json.dumps({
    'label': label, 'frames': n, 'fps': round(1000 / mean, 1), 'p50': pct(0.5), 'p95': pct(0.95), 'p99': pct(0.99), 'max': round(frames[-1], 1),
    'long_frames_over_33ms': sum(1 for f in frames if f > 33.4),
    'cpu_ms_mean': round(sum(cpu) / max(1, len(cpu)), 2), 'cpu_ms_p95': round(sorted(cpu)[int(0.95 * (len(cpu) - 1))], 2) if cpu else 0, 'server_tick_ms': tick, 'audio': voices, 'match': match,
}))
