/**
 * Create-a-Class against a real server: malformed and forbidden `loadout` messages must fall back to valid gear
 * (never crash, never an unknown weapon), a valid class right after spawning applies at once (`gear`), every preset
 * round-trips, and gun game ignores classes.
 *
 *   PORT=3523 ROOM_CREATE_LIMIT=1000 npx tsx server/index.ts
 *   npx tsx scripts/qa/class-guard.ts [http://localhost:3523]
 */
import { LOADOUT_PRESETS } from '../../src/modes/Loadouts';
import { PRIMARY_WEAPONS, SECONDARY_WEAPONS, weaponDef } from '../../src/modes/Weapons';
import { Bot, check, createRoom, sleep, summary } from './lib';

const base = process.argv[2] ?? 'http://localhost:3523';

type Gear = { primary: string; secondary?: string; optic?: string; perk?: string };
const valid = (g: Gear) => PRIMARY_WEAPONS.includes(g.primary) && (!g.secondary || SECONDARY_WEAPONS.includes(g.secondary))
  && (!g.optic || weaponDef(g.primary)!.optics.includes(g.optic as never));

async function room(gameType: string): Promise<string> {
  const r = await createRoom(base, { name: 'Class guard', gameMode: 'creative', seed: 'cg', gameType, scoreLimit: 50, timeLimitSec: 600, mapId: 'classic' });
  return r.code;
}

async function main(): Promise<void> {
  const code = await room('tdm');
  const a = new Bot('cg_alpha'), b = new Bot('cg_bravo');
  await a.connect(base, code);
  await b.connect(base, code);
  a.autoPos(); b.autoPos();
  // Warm-up: alive at once. Garbage of every shape; the server must answer each with valid gear or nothing at all.
  const junk: unknown[] = [
    { primary: 'railgun', secondary: 'bfg', optic: 'xray', perk: 'aimbot' },
    { primary: 'knife', secondary: 'rifle' },
    { primary: 'pistol' },
    { primary: 'sniper', optic: 'reddot' },
    { primary: 'rifle', optic: 'scope' },
    { primary: 12, secondary: null, optic: {}, perk: [] },
    { primary: { toString: 1 }, perk: '__proto__' },
    { primary: 'x'.repeat(5000) },
    {},
  ];
  const t0 = performance.now();
  for (const j of junk) {
    a.send({ t: 'loadout', ...(j as object) } as never);
    await sleep(120);
  }
  await sleep(500);
  const gears = a.of('gear', t0);
  check('malformed classes never crash the room or drop the sender', a.closeCode === 0 && b.closeCode === 0, `close ${a.closeCode}/${b.closeCode} ${JSON.stringify(a.of('kick'))}`);
  check('every gear the server sent for junk is a valid class', gears.every(valid), JSON.stringify(gears.filter((g) => !valid(g)).slice(0, 3)));
  const last = gears.at(-1);
  check('an empty loadout ends on the default class', !!last && last.primary === 'rifle', JSON.stringify(last));
  const sniperGear = gears.find((g) => g.primary === 'sniper');
  check('an optic the weapon cannot take becomes its own (sniper + red dot -> scope)', sniperGear?.optic === 'scope', JSON.stringify(sniperGear));

  // The class window (3 s after spawning, before the first shot) has closed by now: a class waits for the next life.
  const sinceLate = performance.now();
  a.send({ t: 'loadout', primary: 'lmg', secondary: 'pistol', optic: 'holo', perk: 'extmag' });
  await sleep(600);
  check('after the 3 s window a class waits for the next life (no gear now)', a.of('gear', sinceLate).length === 0);
  a.close();

  // Every preset applies at once when chosen right after joining (one fresh player each, inside the window).
  for (const p of LOADOUT_PRESETS) {
    const bot = new Bot(`cg_${p.id}`.slice(0, 16));
    await bot.connect(base, code);
    const since = performance.now();
    bot.send({ t: 'loadout', primary: p.primary, secondary: p.secondary, optic: p.optic, perk: p.perk });
    const g = await bot.waitFor('gear', () => true, 2000, since);
    check(`preset ${p.name} applies as sent`, !!g && g.primary === p.primary && (g.secondary ?? '') === p.secondary
      && (g.optic ?? 'iron') === p.optic && (g.perk ?? 'none') === p.perk, JSON.stringify(g));
    // Others see the optic and the suppressor in `holds`.
    if (p.perk === 'suppressor' || p.optic !== 'iron') {
      const h = await b.waitFor('holds', (m) => m.id === bot.id && m.weapon === p.primary && (m.optic ?? 'iron') === p.optic, 2000, since);
      check(`others see ${p.name}: holds carries the optic${p.perk === 'suppressor' ? ' and the suppressor' : ''}`,
        !!h && (h.optic ?? 'iron') === p.optic && (p.perk !== 'suppressor' || h.sup === 1), JSON.stringify(h));
    }
    bot.close();
  }
  b.close();

  // Gun game: the ladder decides; a class request changes nothing.
  const gg = await room('gungame');
  const c = new Bot('cg_gun'), d = new Bot('cg_game');
  await c.connect(base, gg);
  await d.connect(base, gg);
  c.autoPos(); d.autoPos();
  await sleep(400);
  const since = performance.now();
  c.send({ t: 'loadout', primary: 'sniper', secondary: 'revolver', optic: 'scope', perk: 'extmag' });
  await sleep(800);
  check('gun game ignores a class request (no gear change)', c.of('gear', since).every((g) => g.primary !== 'sniper'));
  c.close(); d.close();
  process.exit(summary() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
