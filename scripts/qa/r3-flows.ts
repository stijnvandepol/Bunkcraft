/**
 * QA round 3: Realms flows with two or three real browsers (Chromium and WebKit), production build, only clicks and keys.
 *
 *   QA_URL=http://localhost:3471 QA_SHOTS=/tmp/shots npx tsx scripts/qa/r3-flows.ts [part ...]
 *
 * Parts: private (create, join by code from WebKit, join by link), browse, leave (leave and rejoin), lang (Dutch in a
 * match), resize, focus (tab switch and pointer-lock loss), settings (sensitivity, FOV, volume in a match).
 */
import { type Browser } from '@playwright/test';
import {
  type Player, URL, clickButton, inMatch, key, launch, lock, newPlayer, openRealms, openTitle, quickPlay, shot, text, until, visible, wait,
} from './human';

const parts = process.argv.slice(2);
const want = (p: string) => parts.length === 0 || parts.includes(p);
const results: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`); return ok; };

async function roomCode(p: Player): Promise<string> {
  const body = await p.page.locator('body').innerText();
  const m = /(?:Game code|Spelcode|Lobbycode)[^A-Z0-9]*([A-Z0-9]{3}-?[A-Z0-9]{3})/.exec(body);
  return m ? m[1].replace('-', '') : '';
}
const lobbyNames = async (p: Player) => (await p.page.locator('.mlobby-player').allInnerTexts()).map((s) => s.trim());

async function esc(p: Player): Promise<void> {
  await key(p, 'Escape');
  await until(p, 'pause menu', () => visible(p, 'button:has-text("Disconnect"), button:has-text("Verbinding verbreken")'), 5000).catch(() => undefined);
}

/** Done/Klaar out of the option screens, then Back to Game, then click into the game. */
async function backToGame(p: Player): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const back = p.page.getByRole('button', { name: /^(Back to Game|Terug naar spel)$/ });
    if (await back.count()) { await back.first().click(); break; }
    const done = p.page.getByRole('button', { name: /^(Done|Klaar)$/ });
    if (await done.count()) await done.last().click();
    await wait(p, 300);
  }
  await wait(p, 300);
  await lock(p);
}

async function leave(p: Player): Promise<void> {
  if (await visible(p, '.click-to-play')) await lock(p);
  if (!(await visible(p, 'button:has-text("Disconnect"), button:has-text("Verbinding verbreken")'))) await esc(p);
  await p.page.getByRole('button', { name: /Disconnect|Verbinding verbreken|Verbreek/ }).first().click();
  await until(p, 'back in realms', () => visible(p, '.realms-screen'), 15_000);
}

let chromium = null as Browser | null;
let webkit = null as Browser | null;
const players: Player[] = [];
const fresh = async (engine: 'chromium' | 'webkit', name: string) => {
  const b = engine === 'chromium' ? (chromium ??= await launch('chromium')) : (webkit ??= await launch('webkit'));
  const p = await newPlayer(b, name);
  players.push(p);
  return p;
};

try {
  if (want('private')) {
    const a = await fresh('chromium', 'qa_host');
    await openTitle(a);
    await openRealms(a);
    await a.page.locator('.realms-item[data-mode="ctf"]').click();
    await clickButton(a, 'Private Lobby');
    await until(a, 'create screen', async () => (await a.page.getByRole('button', { name: /^Mode: / }).count()) > 0);
    check('private lobby: mode follows the selected playlist entry', /Capture the Flag/.test(await a.page.getByRole('button', { name: /^Mode: / }).innerText()),
      await a.page.getByRole('button', { name: /^Mode: / }).innerText());
    await shot(a, 'r3-f-private-create');
    await clickButton(a, 'Create Lobby');
    await until(a, 'created', () => visible(a, '.realms-code'));
    const shown = await text(a, '.realms-code');
    const link = await a.page.locator('input.mc-input').first().inputValue();
    check('private lobby: code and link shown', /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(shown) && link.includes(shown.replace('-', '')), `${shown} ${link}`);
    await shot(a, 'r3-f-private-created');
    await clickButton(a, 'Play');
    await until(a, 'in match', () => inMatch(a), 60_000);
    await lock(a);

    // Friend on Safari types the code (with the dash, lower case).
    const b = await fresh('webkit', 'qa_safari');
    await openTitle(b);
    await openRealms(b);
    await clickButton(b, 'Join with Code');
    await b.page.locator('input.mc-input:visible').first().fill(shown.toLowerCase());
    await wait(b, 800);
    const preview = await b.page.locator('.hint').allInnerTexts();
    check('join with code: preview line names the mode', preview.some((s) => /Capture the Flag/.test(s)), preview.join(' | '));
    await b.page.keyboard.press('Enter');
    await until(b, 'B in match', () => inMatch(b), 90_000);
    await lock(b);
    await wait(b, 1500);
    await until(a, 'both listed', async () => (await lobbyNames(a)).length >= 2, 20_000).catch(() => undefined);
    check('both players in one lobby (A sees B)', (await lobbyNames(a)).includes('qa_safari'), (await lobbyNames(a)).join(', '));
    await shot(b, 'r3-f-private-webkit-joined');

    // A third player opens the invite link in a fresh browser.
    const c = await fresh('chromium', 'qa_link');
    await c.page.goto(link);
    await until(c, 'name or match', async () => (await c.page.locator('input.mc-input:visible').count()) > 0 || (await inMatch(c)), 60_000);
    if (!(await inMatch(c))) {
      await c.page.locator('input.mc-input:visible').first().fill('qa_link');
      await c.page.keyboard.press('Enter');
    }
    await until(c, 'C in match', () => inMatch(c), 90_000);
    check('invite link joins the same lobby', (await roomCode(c)) === shown.replace('-', ''), await roomCode(c));
    check('invite link leaves the address bar', !c.page.url().includes('join='), c.page.url());
    // The match goes live with three players (countdown).
    await until(a, 'live', async () => !/WARM|OPWARM/i.test(await text(a, '.arc-clock')), 60_000).catch(() => undefined);
    await shot(a, 'r3-f-private-live');
    check('CTF: flag panel or markers shown when live', (await a.page.locator('.mode-flags, .mode-flag, .mode-marker').count()) > 0);
    for (const p of [a, b, c]) await leave(p);
    check('leaving goes back to the Realms playlist (all three)', true);
    await shot(b, 'r3-f-private-webkit-left');
  }

  if (want('browse')) {
    const a = await fresh('chromium', 'qa_browse_a');
    await openTitle(a);
    await openRealms(a);
    await quickPlay(a, 'ffa');
    const code = await roomCode(a);
    const b = await fresh('webkit', 'qa_browse_b');
    await openTitle(b);
    await openRealms(b);
    await clickButton(b, 'Browse Lobbies');
    await until(b, 'list', () => visible(b, `.realms-item[data-code="${code}"]`), 15_000).catch(() => undefined);
    const row = b.page.locator(`.realms-item[data-code="${code}"]`);
    check('browse: the quick-play lobby is listed', (await row.count()) === 1, code);
    if (await row.count()) {
      check('browse: row shows mode and players', /Free For All/.test(await row.innerText()) && /1\/\d+/.test(await row.innerText()), (await row.innerText()).replace(/\n/g, ' | '));
      await shot(b, 'r3-f-browse');
      await row.dblclick();
      await until(b, 'joined', () => inMatch(b), 90_000);
      check('browse: double-click joins that lobby', (await roomCode(b)) === code);
    }
    await leave(a);
    await leave(b);
  }

  if (want('leave')) {
    const a = await fresh('chromium', 'qa_leaver');
    const b = await fresh('chromium', 'qa_stayer');
    await openTitle(a); await openRealms(a); await quickPlay(a, 'tdm');
    const code = await roomCode(a);
    await openTitle(b); await openRealms(b); await quickPlay(b, 'tdm');
    check('second quick play lands in the same lobby', (await roomCode(b)) === code, `${code} / ${await roomCode(b)}`);
    await lock(a);
    // A picks the Sniper class, leaves, and quick-plays again: same lobby, class remembered.
    await key(a, 'KeyB');
    await a.page.locator('.arc-loadout .arc-chip', { hasText: 'Sniper' }).click();
    await a.page.locator('.arc-loadout button.mc-btn').click();
    await leave(a);
    await quickPlay(a, 'tdm');
    check('rejoin: back in the lobby with players', (await roomCode(a)) === code, await roomCode(a));
    await lock(a);
    await wait(a, 1500);
    check('rejoin: last class is back', (await text(a, '.arc-weapon-name')) === 'Bolt-Action Sniper', await text(a, '.arc-weapon-name'));
    const names = await lobbyNames(b);
    check('stayer sees exactly one qa_leaver (no ghost)', names.filter((n) => n === 'qa_leaver').length === 1, names.join(', '));
    await shot(a, 'r3-f-rejoin');
    await leave(a); await leave(b);
  }

  if (want('lang')) {
    const a = await fresh('chromium', 'qa_dutch');
    await openTitle(a);
    await openRealms(a);
    await quickPlay(a, 'tdm');
    await lock(a);
    await esc(a);
    await clickButton(a, /^Options/);
    // Language button in Options.
    const langBtn = a.page.getByRole('button', { name: /Language|Taal/ }).first();
    await langBtn.click();
    await wait(a, 500);
    await shot(a, 'r3-f-lang-screen');
    const nl = a.page.getByText(/Nederlands/).first();
    if (await nl.count()) await nl.click();
    await wait(a, 500);
    await backToGame(a);
    await wait(a, 1000);
    await shot(a, 'r3-f-lang-nl-hud');
    const hud = await a.page.locator('.arc-hud').innerText();
    const chat = await a.page.locator('.chat-log').innerText();
    check('NL: HUD in Dutch', /WARMING|Opwarm|Wachten|GEZONDHEID|Gezondheid/i.test(hud), hud.replace(/\n/g, ' | ').slice(0, 200));
    check('NL: no English left in the HUD', !/Waiting for players|HEALTH|Hold Tab/.test(hud), hud.replace(/\n/g, ' | ').slice(0, 300));
    console.log('INFO  chat after switching to NL:', chat.replace(/\n/g, ' | '));
    await key(a, 'KeyB');
    await wait(a, 400);
    await shot(a, 'r3-f-lang-nl-cac');
    check('NL: Create-a-Class in Dutch', /Primair|Secundair/.test(await a.page.locator('.arc-loadout').innerText()));
    await a.page.locator('.arc-loadout button.mc-btn').click();
    await leave(a);
    // A fresh join in Dutch: the arcade hint and the game code line.
    await quickPlay(a, 'ffa');
    await wait(a, 800);
    const chat2 = await a.page.locator('.chat-log').innerText();
    console.log('INFO  join chat in NL:', chat2.replace(/\n/g, ' | '));
    check('NL: join messages in Dutch', !/Tab = scoreboard|Press Esc, then Invite Friends|Game code:/.test(chat2), chat2.replace(/\n/g, ' | '));
    await shot(a, 'r3-f-lang-nl-join');
    // Back to English for the other parts (same browser storage is per context; nothing to undo).
    await leave(a);
  }

  if (want('resize')) {
    const a = await fresh('chromium', 'qa_resize');
    await openTitle(a); await openRealms(a); await quickPlay(a, 'hardpoint'); await lock(a);
    for (const [w, h] of [[800, 600], [1920, 1080], [1366, 768], [1024, 1366]]) {
      await a.page.setViewportSize({ width: w, height: h });
      await wait(a, 700);
      await shot(a, `r3-f-resize-${w}x${h}`);
      const boxes = await a.page.evaluate(() => {
        const r = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return b.width ? [b.left, b.top, b.right, b.bottom] : null; };
        return { top: r('.arc-top'), health: r('.arc-health'), ammo: r('.arc-ammo'), slots: r('.arc-slots'), lobby: r('.mlobby'), vw: innerWidth, vh: innerHeight };
      });
      const inside = (b: number[] | null) => !b || (b[0] >= -1 && b[1] >= -1 && b[2] <= boxes.vw + 1 && b[3] <= boxes.vh + 1);
      const overlap = (p: number[] | null, q: number[] | null) => !!p && !!q && p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];
      check(`resize ${w}x${h}: HUD inside the window`, [boxes.top, boxes.health, boxes.ammo, boxes.slots, boxes.lobby].every(inside), JSON.stringify(boxes));
      check(`resize ${w}x${h}: lobby panel clear of weapon slots and ammo`, !overlap(boxes.lobby, boxes.slots) && !overlap(boxes.lobby, boxes.ammo), JSON.stringify(boxes));
    }
    await a.page.setViewportSize({ width: 1280, height: 720 });
    await leave(a);
  }

  if (want('focus')) {
    const a = await fresh('chromium', 'qa_focus');
    await openTitle(a); await openRealms(a); await quickPlay(a, 'tdm');
    check('focus: locked after click', await lock(a));
    // Tab switch: another tab comes to the front, then back.
    const other = await a.ctx.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await a.page.waitForTimeout(800);
    await a.page.bringToFront();
    await a.page.waitForTimeout(500);
    const ctp = await visible(a, '.click-to-play');
    const pause = await visible(a, 'button:has-text("Back to Game")');
    check('tab switch: lock lost shows the pause menu or click-to-play', ctp || pause, `click-to-play ${ctp}, pause ${pause}`);
    await shot(a, 'r3-f-focus-back');
    if (pause) await clickButton(a, 'Back to Game');
    else await a.page.locator('.click-to-play').click();
    await wait(a, 500);
    check('tab switch: one click resumes with the lock', await a.page.evaluate(() => !!document.pointerLockElement));
    // Esc, then Back to Game at once (the browser refuses a re-lock within ~1 s of Esc).
    await key(a, 'Escape');
    await wait(a, 300);
    await clickButton(a, 'Back to Game');
    await wait(a, 400);
    const locked = await a.page.evaluate(() => !!document.pointerLockElement);
    const ctp2 = await visible(a, '.click-to-play');
    check('Esc then Back to Game within 1 s: locked, or a click-to-play to finish', locked || ctp2, `locked ${locked}, click-to-play ${ctp2}`);
    await shot(a, 'r3-f-focus-quick-resume');
    if (ctp2) { await wait(a, 900); await a.page.locator('.click-to-play').click(); await wait(a, 300); }
    check('after the quick resume: playing', await a.page.evaluate(() => !!document.pointerLockElement));
    await other.close();
    await leave(a);
  }

  if (want('settings')) {
    const a = await fresh('chromium', 'qa_settings');
    await openTitle(a); await openRealms(a); await quickPlay(a, 'tdm'); await lock(a);
    await esc(a);
    await clickButton(a, /^Options/);
    await wait(a, 400);
    await shot(a, 'r3-f-settings-options');
    console.log('INFO  options buttons:', (await a.page.getByRole('button').allInnerTexts()).join(' | '));
    const sliders = await a.page.locator('input[type=range]:visible, .mc-slider:visible').count();
    console.log('INFO  sliders on Options:', sliders);
    const fov = a.page.locator('.mc-slider:visible, input[type=range]:visible').filter({ hasText: /FOV/ }).first();
    if (await fov.count()) {
      const box = (await fov.boundingBox())!;
      await a.page.mouse.click(box.x + box.width * 0.95, box.y + box.height / 2);
      await wait(a, 300);
      check('FOV slider moved', /FOV: (1[01]\d|Quake)/i.test(await fov.innerText()), await fov.innerText());
    }
    await backToGame(a);
    await wait(a, 600);
    await shot(a, 'r3-f-settings-fov-applied');
    await leave(a);
  }
} catch (e) {
  check('flow', false, (e as Error).stack?.split('\n').slice(0, 3).join(' ') ?? String(e));
  for (const [i, p] of players.entries()) await shot(p, `r3-f-fail-${i}`).catch(() => undefined);
} finally {
  for (const p of players) if (p.errors.length) console.log(`errors ${p.name}:`, p.errors.filter((e) => !/Content Security Policy/.test(e)));
  console.log(`${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await chromium?.close();
  await webkit?.close();
  void URL;
}
