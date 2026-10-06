"""
Finds which three.js object causes a WebGL error (e.g. "Vertex buffer is not big enough for the draw call"):
every scene object gets an onAfterRender hook that checks gl.getError().

  python3 scripts/qa/gl_errors.py [port] [profile_dir] [seconds]
"""
import sys
import time

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from qa_lib import QA  # noqa: E402

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5231
profile = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bunkcraft-qa-gl'
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 20
qa = QA(port, 'docs/qa', profile)
qa.open()
HOOK = """() => {
  const g = window.game, gl = g.renderer.three.getContext();
  const seen = window.__glErr = window.__glErr || {};
  const hook = (o) => {
    if (o.__qaHooked) return;
    o.__qaHooked = true;
    const prev = o.onAfterRender;
    o.onAfterRender = function (...a) {
      const e = gl.getError();
      if (e) {
        const geo = o.geometry;
        const attrs = geo ? Object.entries(geo.attributes).map(([k, v]) => k + ':' + v.count + (v.isInstancedBufferAttribute ? 'i' : '')).join(' ') : '';
        const key = (o.name || o.type) + ' parent=' + (o.parent?.name || o.parent?.type) + ' count=' + (o.count ?? '') + ' idx=' + (geo?.index?.count ?? '') + ' range=' + JSON.stringify(geo?.drawRange) + ' ' + attrs;
        seen[key] = (seen[key] || 0) + 1;
      }
      return prev && prev.apply(this, a);
    };
  };
  const r = g.renderer.three;
  if (!r.__qaWrapped) {
    r.__qaWrapped = true;
    const render = r.render.bind(r);
    r.render = (scene, cam) => { scene.traverse(hook); return render(scene, cam); };
  }
  return Object.keys(seen).length;
}"""
qa.js(HOOK)
qa.wait(8)  # title screen panorama
print('errors on the title screen:', qa.js('window.__glErr'), len([c for c in qa.console if 'GL_INVALID' in c]))
qa.js("window.game.createWorld('gl', '779050144', 'survival')")
for _ in range(200):
    qa.page.bring_to_front()
    if qa.js('game.state') not in ('loading', 'menu'):
        break
    time.sleep(0.1)
qa.relock()
t0 = time.time()
logs = qa.js("__R.BLOCK_DEFS.filter(d => d && d.name.endsWith('_log')).map(d => d.id)")
while time.time() - t0 < seconds:
    qa.js(HOOK)
    f = qa.js(f'qa.find({logs}, 20, -3, 6, 1)')
    if f:
        x, y, z = f[0][:3]
        qa.walk_to(x + 0.5, z + 2.0, tol=1.0, timeout=6)
        qa.mine(x, y, z, timeout=8)
        qa.collect_items(5, 3)
        print('errs so far', len([c for c in qa.console if 'GL_INVALID' in c]), qa.js('window.__glErr'), flush=True)
    else:
        qa.wait(0.5)
print('errors by object:')
for k, v in qa.js('window.__glErr').items():
    print(v, k)
print('console:', len([c for c in qa.console if 'GL_INVALID' in c]))
qa.close()
