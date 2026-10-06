"""
Repro for "GL_INVALID_OPERATION: glDrawElements: Vertex buffer is not big enough for the draw call" on chunk meshes
(docs/qa/SURVIVAL.md, P1). Flies fast through fresh worlds at a high render distance with the main thread throttled,
and records, per run: console GL errors, chunk meshes that raised a GL error right after their draw (with the GL
buffer sizes bound at that moment), and every gl.bufferData upload of an empty or detached array.

  python3 scripts/qa/chunk_gl_repro.py [--runs 10] [--seconds 30] [--distance 14] [--cpu 4] [--seed 4242] [--port 0]

Starts its own Vite dev server (no HMR, no file watching) on a free port; never touches :3000.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

INSTRUMENT = r"""
() => {
  const g = window.game, r = g.renderer.three, gl = r.getContext();
  const probe = window.__probe = { emptyUploads: [], meshErrors: {}, uploads: 0, frameErrors: 0, armed: 0 };
  // gl.getError() is a synchronous GPU round trip: check once per render call, and per chunk mesh only
  // for a while after an error (a bad mesh stays bad for seconds).
  const render = r.render.bind(r);
  r.render = (scene, cam) => {
    render(scene, cam);
    if (probe.armed > 0) probe.armed--;
    else if (gl.getError()) { probe.frameErrors++; probe.armed = 60; }
  };
  const bufferData = gl.bufferData.bind(gl);
  gl.bufferData = function (target, src, usage, ...rest) {
    if (src && typeof src === 'object' && ArrayBuffer.isView(src)) {
      probe.uploads++;
      if (src.byteLength === 0 || src.buffer.byteLength === 0) {
        if (probe.emptyUploads.length < 20) probe.emptyUploads.push({ target, detached: src.buffer.byteLength === 0, ctor: src.constructor.name, stack: new Error().stack.split('\n').slice(2, 7).join(' | ') });
      }
    }
    return bufferData(target, src, usage, ...rest);
  };
  const proto = window.__CM.ChunkManager.prototype;
  const sizeOf = (target, buf) => {
    if (!buf) return null;
    const prev = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const s = gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE);
    gl.bindBuffer(gl.ARRAY_BUFFER, prev);
    return s;
  };
  const check = function () {
    if (probe.armed <= 0) return;
    const e = gl.getError();
    if (!e) return;
    const geo = this.geometry, q = this.userData.qa || {};
    const attribs = [];
    for (let loc = 0; loc < 4; loc++) {
      const buf = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
      const on = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED);
      attribs.push(on ? sizeOf(gl.ARRAY_BUFFER, buf) : 'off');
    }
    const elem = gl.getBufferParameter(gl.ELEMENT_ARRAY_BUFFER, gl.BUFFER_SIZE);
    const key = `${q.cx},${q.cz} v=${q.version} verts=${geo.attributes.packed?.count} idx=${geo.index?.count}`;
    const rec = probe.meshErrors[key] ??= { n: 0, err: e, attribBytes: attribs, elemBytes: elem, uploadsOfMesh: q.n, arrays: Object.entries(geo.attributes).map(([k, a]) => k + ':' + a.array.length) };
    rec.n++;
  };
  const orig = proto.setGeometry;
  probe.badIndex = [];
  proto.setGeometry = function (chunk, mesh, data, material, group) {
    if (data) {
      // CPU side: an index past the vertex count, or a triangle (0,0,0) that no emitter produces
      // (indices a stale or zero-filled pool buffer left behind).
      const verts = data.packed.length / 4, ix = data.index;
      let bad = 0;
      for (let i = 0; i < ix.length; i += 3) {
        if (ix[i] >= verts || ix[i + 1] >= verts || ix[i + 2] >= verts || (ix[i] === ix[i + 1] && ix[i + 1] === ix[i + 2])) bad++;
      }
      if (bad && probe.badIndex.length < 20) probe.badIndex.push({ cx: chunk.cx, cz: chunk.cz, verts, idx: ix.length, badTriangles: bad });
    }
    const m = orig.call(this, chunk, mesh, data, material, group);
    if (m) {
      const q = m.userData.qa ??= { n: 0 };
      q.cx = chunk.cx; q.cz = chunk.cz; q.version = chunk.meshedVersion; q.n++;
      if (!m.__probe) { m.__probe = true; m.onAfterRender = check; }
    }
    return m;
  };
}
"""


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', type=int, default=10)
    ap.add_argument('--seconds', type=float, default=30)
    ap.add_argument('--distance', type=int, default=14)
    ap.add_argument('--cpu', type=float, default=4)
    ap.add_argument('--port', type=int, default=0)
    # Seed 4242 (the QA seed) has a plant-dense chunk at (-8, 1) that overflowed the mesher's index scratch.
    ap.add_argument('--seed', default='4242', help="world seed for every run ('' = a different seed per run)")
    ap.add_argument('--json', default=None)
    args = ap.parse_args()

    port = args.port or free_port()
    cfg = os.path.join(ROOT, f'.vite.glrepro.{port}.config.mjs')
    with open(cfg, 'w') as f:
        f.write("export default { worker: { format: 'es' }, server: { port: %d, strictPort: true, hmr: false, watch: null } };" % port)
    proc = subprocess.Popen(['npx', 'vite', '--config', cfg], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://localhost:{port}/'
    results = []
    try:
        for _ in range(150):
            try:
                urllib.request.urlopen(url, timeout=1)
                break
            except OSError:
                time.sleep(0.2)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-angle=metal', '--ignore-gpu-blocklist'])
            for run in range(args.runs):
                page = browser.new_page(viewport={'width': 1280, 'height': 800})
                console = []
                page.on('console', lambda m: console.append(m.text) if 'GL_INVALID' in m.text or 'WebGL' in m.text else None)
                page.goto(url)
                page.wait_for_function('window.game && window.game.state === "menu"', timeout=60000)
                cdp = page.context.new_cdp_session(page)
                seed = args.seed or str(1000 + run * 7919)
                page.evaluate("async () => { window.__CM = await import('/src/world/ChunkManager.ts'); }")
                page.evaluate(INSTRUMENT)
                if args.cpu != 1:
                    cdp.send('Emulation.setCPUThrottlingRate', {'rate': args.cpu})
                page.evaluate("""([d, seed]) => { const g = window.game; g.settings.set('renderDistance', d);
                    g.createWorld('glrepro', seed, 'creative'); }""", [args.distance, seed])
                # Pointer lock fails in automation: the game lands in 'paused' instead of 'playing'.
                for _ in range(600):
                    page.bring_to_front()
                    if page.evaluate('window.game.state === "paused" || window.game.state === "playing"'):
                        break
                    time.sleep(0.25)
                page.evaluate("""() => { const g = window.game; g.input.locked = true; g.state = 'playing';
                    g.player.flying = true; g.player.y = Math.max(g.player.y, 100);
                    g.input.down.add('KeyW'); g.input.down.add('ShiftLeft');
                    window.__turn = setInterval(() => { g.input.mouseDX = Math.sin(performance.now() / 3000) * 4; }, 16); }""")
                # Every few seconds jump 800 blocks away and back: the spawn area unloads and remeshes into
                # recycled (dirty) pool buffers, like a long session does.
                start = time.time()
                end = start + args.seconds
                hop = 0
                while time.time() < end:
                    page.bring_to_front()
                    page.wait_for_timeout(250)
                    if time.time() - start > (hop + 1) * 5:
                        hop += 1
                        page.evaluate('(dx) => { const p = window.game.player; p.setPosition(p.x + dx, p.y, p.z); }',
                                      800 if hop % 2 else -800)
                probe = page.evaluate('() => { clearInterval(window.__turn); return { ...window.__probe, stats: window.game.world.chunks.stats(), fps: window.game.debug.fps }; }')
                gl_console = [c for c in console if 'GL_INVALID' in c]
                res = {'run': run, 'seed': seed, 'consoleGlErrors': len(gl_console), 'frameErrors': probe['frameErrors'],
                       'firstConsole': gl_console[:2],
                       'meshErrors': probe['meshErrors'], 'emptyUploads': probe['emptyUploads'], 'badIndex': probe['badIndex'],
                       'uploads': probe['uploads'], 'stats': probe['stats']}
                results.append(res)
                print(json.dumps({k: res[k] for k in ('run', 'seed', 'consoleGlErrors', 'frameErrors', 'uploads')}),
                      'badIndex=', json.dumps(res['badIndex'])[:400], 'meshErrors=', json.dumps(res['meshErrors'])[:400],
                      'emptyUploads=', json.dumps(res['emptyUploads'])[:400], flush=True)
                page.close()
            browser.close()
    finally:
        proc.terminate()
        if os.path.exists(cfg):
            os.remove(cfg)
    bad = sum(1 for r in results if r['consoleGlErrors'] or r['frameErrors'] or r['meshErrors'] or r['emptyUploads'] or r['badIndex'])
    print(f'runs with GL problems: {bad}/{len(results)}')
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(results, f, indent=1)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
