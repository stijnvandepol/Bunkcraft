"""
Shared helpers for the BunkCraft QA play-throughs (scripts/qa/*.py).

The game runs in the Vite dev server (window.game debug hook) started with scripts/qa/vite.qa.config.ts
(no HMR, no file watching). Input goes only through the game's own Input object, like CLAUDE.md asks:
  - keys/buttons held: game.input.down.add('KeyW'), clicks: game.input.pressed.add('Mouse0')
  - looking around: game.input.mouseDX / mouseDY (never page.mouse.move while `locked` is forced)
UI screens (inventory, crafting, menus) are clicked through the real DOM with the pointer lock flag off.

Every step is logged into a JSON report (step, ok, seconds, notes, frame stats, console errors, screenshot).
"""
from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any

from playwright.sync_api import sync_playwright

SENS = 0.0022  # Game.updatePlaying: 0.0022 * sensitivity/100 (default sensitivity 100)

# Helpers that run inside the page. Read-only views of the game state plus the aiming maths; nothing here changes the
# world, the inventory or the player (except `relock`, which re-applies the automation lock workaround).
JS_HELPERS = r"""
(() => {
  const g = window.game;
  const qa = {};
  qa.EYE = 1.62;
  qa.state = () => {
    const p = g.player, s = g.stats, d = g.debug, c = g.cycle, e = g.entities;
    let hostile = 0, passive = 0;
    for (const m of (e ? e.mobs : [])) {
      if (m.removed || m.dead) continue;
      if ((m.x - p.x) ** 2 + (m.z - p.z) ** 2 > 64 * 64) continue;
      if (m.type.hostile) hostile++; else passive++;
    }
    return {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, onGround: p.onGround, inWater: p.inWater,
      health: s.health, hunger: s.hunger, sat: s.saturation, air: s.air, armor: s.armorPoints, dead: s.dead,
      deathMessage: s.deathMessage, state: g.state, mode: g.mode, fps: d.fps, frameMs: d.frameMs, worstMs: d.worstMs,
      time: c.time, clock: c.clock(), dayFactor: c.dayFactor, day: c.day, hostile, passive,
      selected: g.hotbar.selected, held: g.hotbar.selectedBlock,
    };
  };
  qa.relock = () => {
    g.input.locked = true;
    g.state = 'playing';
    g.stack.clear();
    g.hud.setVisible(true);
  };
  qa.blockName = (id) => (g.world && id >= 0) ? (g.world.getBlock && (window.__R ? window.__R.getBlockDef(id)?.name : String(id))) : '';
  /** Nearest blocks with one of the ids within a box around the player, sorted by distance. */
  qa.find = (ids, r, dyMin, dyMax, max) => {
    const p = g.player, w = g.world, set = new Set(ids);
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
    const out = [];
    for (let dy = dyMin; dy <= dyMax; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const id = w.getBlock(px + dx, py + dy, pz + dz);
      if (set.has(id)) out.push([px + dx, py + dy, pz + dz, id, dx * dx + dy * dy * 2 + dz * dz]);
    }
    out.sort((a, b) => a[4] - b[4]);
    return out.slice(0, max || 20);
  };
  /** Is a block exposed to air on any side (minable without tunnelling)? */
  qa.exposed = (x, y, z) => {
    const w = g.world;
    for (const [a, b, c] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const id = w.getBlock(x + a, y + b, z + c);
      if (id === 0 || id === 12) return true;
    }
    return false;
  };
  /** Mouse deltas that turn the camera towards a point (yaw/pitch as Camera.ts uses them). */
  qa.aimDelta = (x, y, z) => {
    const p = g.player;
    const dx = x - p.x, dy = y - (p.y + qa.EYE), dz = z - p.z;
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    let dYaw = yaw - p.yaw;
    dYaw = ((dYaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return [-dYaw / SENS, -(pitch - p.pitch) / SENS];
  };
  qa.inv = () => {
    const out = [];
    for (let i = 0; i < 36; i++) {
      const s = g.playerInventory.get(i);
      if (s.count > 0) out.push({ slot: i, id: s.id, name: window.__I.itemName(s.id), count: s.count, damage: s.damage || 0 });
    }
    return out;
  };
  qa.count = (name) => g.playerInventory.count(window.__I.itemId(name));
  qa.slotOf = (name) => {
    const id = window.__I.itemId(name);
    for (let i = 0; i < 36; i++) if (g.playerInventory.get(i).id === id) return i;
    return -1;
  };
  qa.mobs = (r) => {
    const p = g.player;
    return g.entities.mobs.filter((m) => !m.removed && !m.dead && Math.hypot(m.x - p.x, m.z - p.z) < r)
      .map((m) => ({ kind: m.type.kind, hostile: !!m.type.hostile, x: m.x, y: m.y, z: m.z, h: m.health, d: Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z) }))
      .sort((a, b) => a.d - b.d);
  };
  qa.items = (r) => {
    const p = g.player;
    return g.entities.items.filter((it) => Math.hypot(it.x - p.x, it.z - p.z) < r).map((it) => ({ x: it.x, y: it.y, z: it.z, id: it.stack.id }));
  };
  window.qa = qa;
  return true;
})()
""".replace('SENS', str(SENS))


@dataclass
class Step:
    name: str
    ok: bool | None = None
    seconds: float = 0.0
    notes: list[str] = field(default_factory=list)
    frame: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    shots: list[str] = field(default_factory=list)


class QA:
    def __init__(self, port: int, out_dir: str, profile_dir: str, headless: bool = True, width: int = 1280, height: int = 720):
        self.port = port
        self.out = out_dir
        os.makedirs(os.path.join(out_dir, 'shots'), exist_ok=True)
        self.pw = sync_playwright().start()
        self.ctx = self.pw.chromium.launch_persistent_context(
            profile_dir, headless=headless, viewport={'width': width, 'height': height},
            args=['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        self.console: list[str] = []
        self.page.on('console', lambda m: self.console.append(f'[{m.type}] {m.text}') if m.type in ('error', 'warning') else None)
        self.page.on('pageerror', lambda e: self.console.append(f'[pageerror] {e}'))
        self.steps: list[Step] = []
        self.cur: Step | None = None
        self.frame_samples: list[dict[str, float]] = []

    # ------------------------------------------------------------------ plumbing

    def open(self) -> None:
        self.page.goto(f'http://localhost:{self.port}/')
        self.page.wait_for_function('!!(window.game && window.game.createWorld)', timeout=60000)
        self.page.evaluate("""async () => {
          window.__I = await import('/src/items/ItemRegistry.ts');
          window.__R = await import('/src/world/BlockRegistry.ts');
        }""")
        self.page.evaluate(JS_HELPERS)

    def js(self, expr: str, arg: Any = None) -> Any:
        return self.page.evaluate(expr, arg) if arg is not None else self.page.evaluate(expr)

    def wait(self, seconds: float) -> None:
        """Let the game run; keeps the window in front so rAF is not throttled."""
        end = time.time() + seconds
        while True:
            self.page.bring_to_front()
            left = end - time.time()
            if left <= 0:
                break
            time.sleep(min(0.25, left))

    def st(self) -> dict[str, Any]:
        return self.js('qa.state()')

    def relock(self) -> None:
        self.js('qa.relock()')

    def sample_frame(self) -> dict[str, float]:
        s = self.st()
        f = {'fps': s['fps'], 'frameMs': round(s['frameMs'], 2), 'worstMs': round(s['worstMs'], 1)}
        self.frame_samples.append(f)
        return f

    # ------------------------------------------------------------------ steps / report

    def begin(self, name: str) -> Step:
        self.end()
        self.cur = Step(name)
        self.cur._t0 = time.time()  # type: ignore[attr-defined]
        self.cur._c0 = len(self.console)  # type: ignore[attr-defined]
        print(f'\n=== {name}', flush=True)
        return self.cur

    def note(self, text: str) -> None:
        print('   ', text, flush=True)
        if self.cur:
            self.cur.notes.append(text)

    def end(self, ok: bool | None = None) -> None:
        c = self.cur
        if not c:
            return
        if ok is not None:
            c.ok = ok
        c.seconds = round(time.time() - c._t0, 1)  # type: ignore[attr-defined]
        try:
            c.frame = self.take_frames() if self.js('!!window.__qaLog') else {}
            if self.js('!!window.__qaLog'):
                dmg = self.take_damage_log()
                if dmg:
                    c.notes.append(f'damage taken: {[(d["cause"], d["killer"], d["dealt"], d["health"]) for d in dmg]}')
                    print('    damage:', [(d['cause'], d['killer'], d['dealt'], d['health']) for d in dmg], flush=True)
            s = self.st()
            c.notes.append(f'end: clock {s["clock"]} day {s["day"] + 1}, hp {s["health"]}, food {s["hunger"]}, mobs<64: {s["hostile"]} hostile / {s["passive"]} passive')
            c.frame['now'] = self.sample_frame()
        except Exception as e:  # page gone
            c.frame = {'error': str(e)}
        c.errors = [l for l in self.console[c._c0:] if 'DevTools' not in l][:20]  # type: ignore[attr-defined]
        print(f'    -> ok={c.ok} {c.seconds}s frame={c.frame} errors={len(c.errors)}', flush=True)
        self.steps.append(c)
        self.cur = None

    def shot(self, name: str) -> str:
        path = os.path.join(self.out, 'shots', f'{name}.png')
        self.page.screenshot(path=path)
        if self.cur:
            self.cur.shots.append(f'shots/{name}.png')
        return path

    def write_report(self, path: str) -> None:
        self.end()
        data = [{k: v for k, v in s.__dict__.items() if not k.startswith('_')} for s in self.steps]
        with open(path, 'w') as f:
            json.dump({'steps': data, 'frames': self.frame_samples, 'console': self.console[:200]}, f, indent=1)

    def close(self) -> None:
        try:
            self.ctx.close()
        finally:
            self.pw.stop()

    # ------------------------------------------------------------------ input

    def hold(self, *codes: str) -> None:
        self.js('(c) => c.forEach((k) => game.input.down.add(k))', list(codes))

    def release(self, *codes: str) -> None:
        self.js('(c) => c.forEach((k) => game.input.down.delete(k))', list(codes))

    def press(self, code: str) -> None:
        """One click/tap: pressed for one frame, held for a few."""
        self.js('(k) => { game.input.pressed.add(k); game.input.down.add(k); }', code)
        self.wait(0.08)
        self.release(code)

    def key(self, code: str) -> None:
        """A real keyboard event (for UI keys like E, F3, Escape: goes through Game.onKey)."""
        self.page.keyboard.press(code)

    def look(self, dyaw_px: float, dpitch_px: float) -> None:
        self.js('([a, b]) => { game.input.mouseDX += a; game.input.mouseDY += b; }', [dyaw_px, dpitch_px])
        self.wait(0.06)

    def aim(self, x: float, y: float, z: float, tries: int = 3) -> None:
        for _ in range(tries):
            dx, dy = self.js('([x, y, z]) => qa.aimDelta(x, y, z)', [x, y, z])
            if abs(dx) < 2 and abs(dy) < 2:
                return
            self.look(dx, dy)

    def select(self, slot: int) -> None:
        self.press(f'Digit{slot + 1}')

    def select_item(self, name: str) -> bool:
        """Put an item in the hotbar (through the inventory UI if needed) and select it."""
        s = self.js('(n) => qa.slotOf(n)', name)
        if s < 0:
            return False
        if s >= 9:
            # Move it with a real shift-less swap: pick up in the inventory, drop on hotbar slot 8.
            self.ui_open_inventory()
            slots = self.page.locator('.screen.inventory:not(.hidden) .inv-armor-row .inv-grid .inv-slot')
            slots.nth(s - 9).click()
            self.page.locator('.screen.inventory:not(.hidden) .inv-hotbar .inv-slot').nth(8).click()
            # Whatever was in slot 8 is now on the cursor: put it back where the item came from.
            slots.nth(s - 9).click()
            self.ui_close_inventory()
            s = 8
        self.select(s)
        self.wait(0.1)
        return self.js('qa.state().held') == self.js('(n) => __I.itemId(n)', name)

    # ------------------------------------------------------------------ movement

    def walk_to(self, x: float, z: float, tol: float = 1.2, timeout: float = 30.0, sprint: bool = False) -> bool:
        """Walk on foot: face the target, hold W, jump when blocked. Returns True when within tol blocks."""
        t0 = time.time()
        last = None
        stuck = 0.0
        keys = ['KeyW'] + (['ShiftLeft'] if sprint else [])
        try:
            while time.time() - t0 < timeout:
                s = self.st()
                if s['dead'] or s['state'] != 'playing':
                    return False
                d = math.hypot(x - s['x'], z - s['z'])
                if d < tol:
                    return True
                dx, _ = self.js('([x, y, z]) => qa.aimDelta(x, y, z)', [x, s['y'] + 1.62, z])
                self.js('([a]) => { game.input.mouseDX += a; game.input.mouseDY += game.player.pitch / 0.0022; }', [dx])
                self.hold(*keys)
                self.wait(0.2)
                if last is not None and math.hypot(s['x'] - last[0], s['z'] - last[1]) < 0.15:
                    stuck += 0.2
                    self.hold('Space')
                    self.wait(0.25)
                    self.release('Space')
                    if stuck > 3:
                        # Sidestep around the obstacle.
                        self.hold('KeyD')
                        self.wait(0.5)
                        self.release('KeyD')
                        stuck = 0
                else:
                    stuck = 0
                last = (s['x'], s['z'])
            return False
        finally:
            self.release(*keys, 'Space', 'KeyD')

    # ------------------------------------------------------------------ world

    def mine(self, x: int, y: int, z: int, timeout: float = 20.0) -> float | None:
        """Aim at the block centre and hold the attack button until it is gone. Returns seconds or None."""
        before = self.js('([x, y, z]) => game.world.getBlock(x, y, z)', [x, y, z])
        if before == 0:
            return 0.0
        self.aim(x + 0.5, y + 0.5, z + 0.5)
        target = self.js('() => { const r = game.interaction.ray; return r.hit ? [r.x, r.y, r.z] : null; }')
        if target != [x, y, z]:
            self.note(f'mine: crosshair on {target}, wanted {[x, y, z]}')
        t0 = time.time()
        self.hold('Mouse0')
        try:
            while time.time() - t0 < timeout:
                self.wait(0.1)
                if self.js('([x, y, z]) => game.world.getBlock(x, y, z)', [x, y, z]) != before:
                    return round(time.time() - t0, 2)
                self.aim(x + 0.5, y + 0.5, z + 0.5, tries=1)
            return None
        finally:
            self.release('Mouse0')

    def place_on(self, x: int, y: int, z: int, face: tuple[int, int, int] = (0, 1, 0)) -> bool:
        """Right click the given face of a block with the held item; True if the neighbour changed."""
        nx, ny, nz = face
        tx, ty, tz = x + nx, y + ny, z + nz
        before = self.js('([x, y, z]) => game.world.getBlock(x, y, z)', [tx, ty, tz])
        self.aim(x + 0.5 + nx * 0.49, y + 0.5 + ny * 0.49, z + 0.5 + nz * 0.49)
        self.press('Mouse2')
        self.wait(0.15)
        return self.js('([x, y, z]) => game.world.getBlock(x, y, z)', [tx, ty, tz]) != before

    def collect_items(self, radius: float = 8, timeout: float = 10) -> int:
        """Walk over dropped items nearby. Returns how many were left behind."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            items = self.js(f'qa.items({radius})')
            if not items:
                return 0
            it = items[0]
            self.walk_to(it['x'], it['z'], tol=0.6, timeout=4)
            self.wait(0.3)
        return len(self.js(f'qa.items({radius})'))

    # ------------------------------------------------------------------ UI

    def ui_open_inventory(self) -> None:
        self.relock()
        self.key('KeyE')
        self.wait(0.3)
        # The mouse is free in the inventory: drop the forced lock so pointer moves don't turn the camera.
        self.js('game.input.locked = false')

    def ui_close_inventory(self) -> None:
        self.js('document.activeElement && document.activeElement.blur()')
        self.key('KeyE')
        self.wait(0.3)
        self.relock()

    def ui_craft(self, result_name: str, times: int = 1, search: str | None = None) -> int:
        """
        Crafts through the recipe book like a player: type in the search field, hover recipe icons until the tooltip
        names the wanted result, click it `times` times. Returns how many crafts changed the inventory.
        """
        self.ui_open_inventory()
        page = self.page
        inv = '.screen.inventory:not(.hidden)'
        page.locator(f'{inv} .recipe-tab', has_text='All').first.click()
        page.fill(f'{inv} .recipe-search', search or result_name)
        self.wait(0.2)
        slots = page.locator(f'{inv} .recipe-list .inv-slot')
        n = slots.count()
        target = None
        tips = []
        for i in range(n):
            slots.nth(i).hover()
            tip = page.locator(f'{inv} .mc-tooltip').inner_text()
            tips.append(tip)
            name = tip.split('←')[0].strip()
            if '×' in name:
                name = name.split('×', 1)[1].strip()
            if name.lower() == result_name.lower():
                target = i
                break
        made = 0
        if target is None:
            self.note(f'craft: no recipe "{result_name}" in book; saw {tips[:6]}')
        else:
            el = slots.nth(target)
            disabled = 'disabled' in (el.get_attribute('class') or '')
            for _ in range(times):
                before = self.js('qa.inv().map(s => s.name + s.count).join()')
                slots = page.locator(f'{inv} .recipe-list .inv-slot')
                # Re-find after re-render (the list re-sorts craftable first).
                idx = None
                for i in range(slots.count()):
                    slots.nth(i).hover()
                    tip = page.locator(f'{inv} .mc-tooltip').inner_text()
                    nm = tip.split('←')[0].strip()
                    nm = nm.split('×', 1)[1].strip() if '×' in nm else nm
                    if nm.lower() == result_name.lower():
                        idx = i
                        break
                if idx is None:
                    break
                slots.nth(idx).click()
                self.wait(0.1)
                if self.js('qa.inv().map(s => s.name + s.count).join()') != before:
                    made += 1
            if made == 0:
                self.note(f'craft: "{result_name}" click did nothing (disabled={disabled}, tip={tips[-1] if tips else ""})')
        page.fill(f'{inv} .recipe-search', '')
        self.ui_close_inventory()
        return made

    # ------------------------------------------------------------------ instrumentation (read-only hooks)

    def instrument(self) -> None:
        self.js(INSTRUMENT)

    def take_damage_log(self) -> list:
        return self.js('(() => { const d = window.__qaLog.damage; window.__qaLog.damage = []; return d; })()')

    def take_frames(self) -> dict:
        f = self.js('(() => { const d = window.__qaLog.frames; window.__qaLog.frames = []; return d; })()')
        if not f:
            return {}
        fps = sorted(x[0] for x in f)
        return {'samples': len(f), 'fps_min': fps[0], 'fps_p10': fps[len(fps) // 10], 'fps_median': fps[len(fps) // 2],
                'cpu_ms_avg': round(sum(x[1] for x in f) / len(f), 2), 'worst_frame_ms': max(x[2] for x in f)}

    # ------------------------------------------------------------------ digging

    def cell(self):
        s = self.st()
        return math.floor(s['x']), math.floor(s['y']), math.floor(s['z'])

    def block(self, x, y, z) -> int:
        return self.js('([x, y, z]) => game.world.getBlock(x, y, z)', [x, y, z])

    def clear_cell(self, x, y, z, tries: int = 6) -> bool:
        """Mine a cell until it is air (gravel and sand fall in again). Refuses lava and water."""
        for _ in range(tries):
            b = self.block(x, y, z)
            if b == 0:
                return True
            if b in (12, 44):  # water, lava
                self.note(f'dig: liquid {b} at {x},{y},{z}; stopping')
                return False
            if self.mine(x, y, z, timeout=25) is None:
                self.note(f'dig: could not mine block {b} at {x},{y},{z}')
                return False
            self.wait(0.15)
        return self.block(x, y, z) == 0

    def dig_to(self, tx, ty, tz, reach: float = 3.8, max_steps: int = 80, until=None) -> bool:
        """Greedy staircase/tunnel digging until the target block is within reach and in sight (or `until()` holds)."""
        for _ in range(max_steps):
            s = self.st()
            if s['dead'] or s['state'] != 'playing':
                return False
            if until is not None and until():
                return True
            px, py, pz = math.floor(s['x']), math.floor(s['y']), math.floor(s['z'])
            eye = (s['x'], s['y'] + 1.62, s['z'])
            d = math.dist(eye, (tx + 0.5, ty + 0.5, tz + 0.5))
            if d <= reach:
                self.aim(tx + 0.5, ty + 0.5, tz + 0.5)
                ray = self.js('() => { const r = game.interaction.ray; return r.hit ? [r.x, r.y, r.z] : null; }')
                if ray == [tx, ty, tz]:
                    return True
                if ray and math.dist(ray, (tx, ty, tz)) <= 1.8:
                    if not self.clear_cell(*ray):
                        return False
                    continue
            dx, dy, dz = tx - px, ty - py, tz - pz
            if abs(dx) + abs(dz) <= 1 and dy < -1:
                if not self.clear_cell(px, py - 1, pz):
                    return False
                self.wait(0.6)
                continue
            if abs(dx) >= abs(dz):
                sx, sz = (1 if dx > 0 else -1), 0
            else:
                sx, sz = 0, (1 if dz > 0 else -1)
            nx, nz = px + sx, pz + sz
            if dy < -1:
                cells = [(nx, py + 1, nz), (nx, py, nz), (nx, py - 1, nz)]
            elif dy > 1:
                cells = [(px, py + 2, pz), (nx, py + 2, nz), (nx, py + 1, nz)]
            else:
                cells = [(nx, py + 1, nz), (nx, py, nz)]
            for c in cells:
                if not self.clear_cell(*c):
                    return False
            if dy > 1:
                self.hold('Space')
            self.walk_to(nx + 0.5, nz + 0.5, tol=0.35, timeout=4)
            self.release('Space')
            self.wait(0.3)
        return False

    def place_near(self, item: str, expect_block: int | None = None, rings=(2, 1, 3)) -> tuple | None:
        """Select an item and place it on the ground next to the player. Returns the placed cell."""
        if not self.select_item(item):
            self.note(f'place_near: no {item} in inventory')
            return None
        px, py, pz = self.cell()
        tried = 0
        for r in rings:
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if max(abs(dx), abs(dz)) != r:
                        continue
                    gx, gz = px + dx, pz + dz
                    for gy in (py - 1, py, py - 2):
                        below, at = self.block(gx, gy, gz), self.block(gx, gy + 1, gz)
                        if below in (0, 12, 44, 23) or at not in (0, 23):
                            continue
                        tried += 1
                        if self.place_on(gx, gy, gz) and (expect_block is None or self.block(gx, gy + 1, gz) == expect_block):
                            return (gx, gy + 1, gz)
                        break
                    if tried > 10:
                        self.note(f'place_near: {item} failed after {tried} tries')
                        return None
        return None

    # ------------------------------------------------------------------ combat

    MOB_HEIGHT = {'zombie': 1.95, 'skeleton': 1.99, 'creeper': 1.7, 'spider': 0.9, 'pig': 0.9, 'cow': 1.4, 'sheep': 1.3, 'chicken': 0.7}

    def fight(self, seconds: float, hostile_only: bool = True, kinds: tuple = (), max_dist: float = 2.9, chase: float = 12.0,
              stop_when_none: bool = False) -> dict:
        """Melee the nearest mob: aim, step closer, click every 0.5 s (mobs have 10 hurt ticks)."""
        t0 = time.time()
        res = {'swings': 0, 'hits': 0, 'kills': 0, 'seen': set()}
        while time.time() - t0 < seconds:
            s = self.st()
            if s['dead'] or s['state'] != 'playing':
                break
            mobs = [m for m in self.js(f'qa.mobs({chase})') if (m['hostile'] or not hostile_only) and (not kinds or m['kind'] in kinds)]
            if not mobs:
                if stop_when_none:
                    break
                self.wait(0.4)
                continue
            m = mobs[0]
            res['seen'].add(m['kind'])
            h = self.MOB_HEIGHT.get(m['kind'], 1.2)
            self.aim(m['x'], m['y'] + h * 0.6, m['z'], tries=1)
            if m['d'] > max_dist:
                self.hold('KeyW')
                self.wait(0.15)
                self.release('KeyW')
                continue
            hp0 = m['h']
            self.press('Mouse0')
            res['swings'] += 1
            self.wait(0.45)
            after = [x for x in self.js(f'qa.mobs({chase + 4})') if x['kind'] == m['kind'] and abs(x['x'] - m['x']) < 3 and abs(x['z'] - m['z']) < 3]
            if not after:
                res['kills'] += 1
            elif after[0]['h'] < hp0:
                res['hits'] += 1
        res['seen'] = sorted(res['seen'])
        self.release('KeyW', 'Mouse0')
        return res


INSTRUMENT = r"""
(() => {
  const g = window.game;
  if (window.__qaLog) return true;
  const log = window.__qaLog = { damage: [], frames: [] };
  // Record every damage event (wraps PlayerStats.damage without changing what it does).
  const dmg = g.stats.damage.bind(g.stats);
  g.stats.damage = (amount, cause, mode, killer, fromYaw) => {
    const before = g.stats.health;
    const r = dmg(amount, cause, mode, killer, fromYaw);
    if (r) log.damage.push({ t: +(performance.now() / 1000).toFixed(1), amount, cause, killer: killer || '', dealt: before - g.stats.health, health: g.stats.health, armor: g.stats.armorPoints });
    return r;
  };
  // Frame statistics every 250 ms (DebugOverlay computes them even when F3 is hidden).
  setInterval(() => {
    if (g.state === 'playing') log.frames.push([g.debug.fps, +g.debug.frameMs.toFixed(2), +g.debug.worstMs.toFixed(1)]);
  }, 250);
  return true;
})()
"""
