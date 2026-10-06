"""
Which game action triggers "GL_INVALID_OPERATION: glDrawElements: Vertex buffer is not big enough"? Every rendered
three.js object gets an onAfterRender gl.getError() check; then the script does one thing at a time (mobs, items,
XP orbs, armor, blocks with special models) and prints which objects raised an error after each.

  python3 scripts/qa/gl_probe.py [port]
"""
import sys

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from qa_lib import QA  # noqa: E402

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5241
qa = QA(port, 'docs/qa', '/tmp/bunkcraft-qa-glprobe')
qa.open()
HOOK = """() => {
  const g = window.game, r = g.renderer.three, gl = r.getContext();
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
        const key = JSON.stringify(o.userData.qa || {}) + ' ' + (o.name || o.type) + ' <' + (o.parent?.name || o.parent?.type) + '> count=' + (o.count ?? '') + ' idx=' + (geo?.index?.count ?? '') + ' range=' + JSON.stringify(geo?.drawRange) + ' ' + attrs;
        seen[key] = (seen[key] || 0) + 1;
      }
      return prev && prev.apply(this, a);
    };
  };
  if (!r.__qaWrapped) {
    r.__qaWrapped = true;
    const render = r.render.bind(r);
    r.render = (scene, cam) => { scene.traverse(hook); return render(scene, cam); };
  }
  const out = { ...seen };
  for (const k of Object.keys(seen)) delete seen[k];
  return out;
}"""
# Record every chunk geometry upload: vertex count, index count and the largest index (CPU side, before upload).
qa.js("""() => {
  const cm = window.game.constructor && null;
  window.__qaGeo = [];
  const orig = window.game.__proto__;
}""")
qa.js("window.game.createWorld('glprobe', '4242', 'survival')")
qa.wait(0.3)
qa.js("""() => {
  const chunks = game.world.chunks, proto = Object.getPrototypeOf(chunks);
  if (proto.__qaWrapped) return;
  proto.__qaWrapped = true;
  const orig = proto.setGeometry;
  window.__qaBad = [];
  proto.setGeometry = function (chunk, mesh, data, material, group) {
    if (data) {
      const verts = data.packed.length / 4;
      let max = 0;
      for (let i = 0; i < data.index.length; i++) if (data.index[i] > max) max = data.index[i];
      if (max >= verts) window.__qaBad.push({ cx: chunk.cx, cz: chunk.cz, verts, idx: data.index.length, max, bytes: data.index.buffer.byteLength });
    }
    const m = orig.call(this, chunk, mesh, data, material, group);
    if (m) m.userData.qa = { cx: chunk.cx, cz: chunk.cz, verts: data.packed.length / 4, idx: data.index.length };
    return m;
  };
}""")
for _ in range(200):
    if qa.js('game.state') not in ('loading', 'menu'):
        break
    qa.wait(0.1)
qa.relock()
qa.js(HOOK)
qa.wait(2)


def after(label: str) -> None:
    qa.wait(1.5)
    errs = qa.js(HOOK)
    gl = len([c for c in qa.console if 'GL_INVALID' in c])
    print(f'{label:28s} console GL warnings so far: {gl}  objects: {errs}', flush=True)


after('idle')
qa.js("() => { const p = game.player; game.entities.spawnMob('cow', p.x + 2, p.y, p.z); }")
after('cow')
qa.js("() => { const p = game.player; for (const k of ['zombie','skeleton','creeper','spider','witch','wolf','horse','slime','enderman','chicken','sheep','pig']) { try { game.entities.spawnMob(k, p.x + 3, p.y, p.z + 2); } catch (e) {} } }")
after('many mobs')
qa.js("() => { const p = game.player; game.entities.dropItem({ id: __I.itemId('iron_ingot'), count: 1 }, p.x + 1, p.y + 1, p.z); }")
after('item drop')
qa.js("() => { const p = game.player; game.entities.spawnXp(p.x + 1.5, p.y + 0.5, p.z, 7); }")
after('xp orb')
qa.js("() => { game.entities.mobs.forEach(m => m.hurt(100, m.x, m.z, 1, true)); }")
after('mobs die')
qa.js("() => { const inv = game.playerInventory; inv.setArmor(1, { id: __I.itemId('iron_chestplate'), count: 1 }); }")
after('armor worn')
qa.js("() => { const p = game.player, w = game.world, B = __R.BLOCK; const x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z) - 2; w.setBlock(x, y, z, B.ENCHANTING_TABLE); w.setBlock(x + 1, y, z, B.LEVER); w.setBlock(x + 2, y, z, B.REDSTONE_WIRE); w.setBlock(x + 3, y, z, B.CHEST); }")
after('special blocks')
print('CPU-side bad geometry at setGeometry:', qa.js('window.__qaBad'))
print('total console GL warnings:', len([c for c in qa.console if 'GL_INVALID' in c]))
qa.close()
