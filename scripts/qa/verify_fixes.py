"""
Re-checks the QA fixes in a real browser (restart Vite first, it caches modules):
  - no "Advancement Made!" toasts the moment a world loads;
  - F3 facing matches the direction the crosshair goes;
  - a fast double tap of space (real key events, ~120 ms apart) toggles creative flight, 10 tries;
  - right click with armor while looking at the sky wears it;
  - lever → 2 redstone dust → lamp in a clean spot (the scenario run had the lamp next to the earlier door).

  python3 scripts/qa/verify_fixes.py [port]
"""
import sys
import time

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from qa_lib import QA  # noqa: E402

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5241
qa = QA(port, 'docs/qa', '/tmp/bunkcraft-qa-verify')
qa.shot_prefix = 'fix_'
qa.open()
qa.js("window.game.createWorld('verify', '4242', 'survival')")
for _ in range(200):
    if qa.js('game.state') not in ('loading', 'menu'):
        break
    qa.wait(0.1)
qa.relock()
qa.wait(2)
toasts = qa.js("document.querySelectorAll('.toast, .adv-toast, .advancement-toast').length")
qa.shot('spawn_no_toasts')
print('toasts on load:', toasts)

qa.key('F3')
qa.wait(0.6)
facing = qa.js("[...document.querySelectorAll('.debug span')].map(s => s.textContent).find(t => t.startsWith('Facing')) || ''")
ray = qa.js('(() => { const r = game.interaction.ray; return r.hit ? [r.x, r.y, r.z] : null; })()')
print('F3:', facing, 'player', [round(qa.st()[k], 1) for k in 'xz'], 'yaw', round(qa.st()['yaw'], 2), 'target', ray)
qa.shot('f3_facing')
qa.key('F3')

qa.js("game.setMode('creative')")
qa.wait(0.5)
ok = 0
for i in range(10):
    qa.js('game.player.flying = false')
    qa.wait(1.2)
    qa.relock()
    qa.page.keyboard.down('Space')
    time.sleep(0.04)
    qa.page.keyboard.up('Space')
    time.sleep(0.08)
    qa.page.keyboard.down('Space')
    time.sleep(0.04)
    qa.page.keyboard.up('Space')
    qa.wait(0.3)
    ok += bool(qa.js('game.player.flying'))
print(f'fast double tap toggled flight {ok}/10')
qa.js('game.player.flying = false')
qa.js("game.setMode('survival')")
qa.wait(1.5)

qa.js("game.playerInventory.add({ id: __I.itemId('iron_chestplate'), count: 1 })")
qa.select_item('iron_chestplate')
qa.look(0, -900)
qa.press('Mouse2')
qa.wait(0.3)
print('armor points after right click into the sky:', qa.st()['armor'])
qa.look(0, 900)

# Lamp: a fresh flat strip far from anything else.
qa.js("""() => {
  const p = game.player, w = game.world, B = __R.BLOCK;
  const x0 = Math.floor(p.x), y0 = Math.floor(p.y), z0 = Math.floor(p.z);
  for (let dx = -2; dx <= 6; dx++) for (let dz = -2; dz <= 2; dz++) { w.setBlock(x0 + dx, y0 - 1, z0 + dz, 1); for (let dy = 0; dy < 4; dy++) w.setBlock(x0 + dx, y0 + dy, z0 + dz, 0); }
}""")
qa.wait(0.5)
x0, y0, z0 = qa.cell()
lamp, d1, d2, lev = (x0 + 4, y0, z0), (x0 + 3, y0, z0), (x0 + 2, y0, z0), (x0 + 1, y0, z0)
qa.js("(kit) => { for (const [n, c] of kit) game.playerInventory.add({ id: __I.itemId(n), count: c }); }", [['redstone_lamp', 1], ['redstone', 4], ['lever', 1]])
qa.select_item('redstone_lamp')
qa.place_on(lamp[0], lamp[1] - 1, lamp[2])
qa.select_item('redstone')
qa.place_on(d1[0], d1[1] - 1, d1[2])
qa.place_on(d2[0], d2[1] - 1, d2[2])
qa.select_item('lever')
qa.place_on(lev[0], lev[1] - 1, lev[2])
B = qa.js('({ lamp: __R.BLOCK.REDSTONE_LAMP, lit: __R.BLOCK.REDSTONE_LAMP_LIT, wire: __R.BLOCK.REDSTONE_WIRE, lever: __R.BLOCK.LEVER })')
print('placed:', {'lamp': qa.block(*lamp), 'd1': qa.block(*d1), 'd2': qa.block(*d2), 'lever': qa.block(*lev)}, B)
qa.aim(lev[0] + 0.5, lev[1] + 0.15, lev[2] + 0.5)
qa.press('Mouse2')
qa.wait(0.8)
print('lamp lit after the lever:', qa.block(*lamp) == B['lit'], 'block', qa.block(*lamp))
qa.look(0, 150)
qa.shot('lamp')
print('console:', [c for c in qa.console if 'DevTools' not in c][:5])
qa.close()
