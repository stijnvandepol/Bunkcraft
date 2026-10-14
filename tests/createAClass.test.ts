import { describe, expect, it } from 'vitest';
import {
  CLASS_BOOK_STORAGE_KEY, CLASS_SLOTS, CLASS_STORAGE_KEY, LAST_CLASS_STORAGE_KEY, bookShapeOk, cleanClassName, defaultBook, equipped,
  loadLocalBook, migrateBook, sanitizeBook, saveLocalBook,
} from '../src/modes/ClassBook';
import { DEFAULT_CLASS, LOADOUT_PRESETS, loadoutMessage, validateClass } from '../src/modes/Loadouts';
import { newProfile, sanitizeProfile, setClasses } from '../src/modes/progression/Profile';
import { classLevel, classUnlocked, lockClass, parseExtras } from '../src/modes/progression/Unlocks';
import {
  ATTACHMENTS, NO_KIT, PRIMARY_WEAPONS, adsSpreadMul, adsTimeFor, attachAllowed, hipSpreadMul, magazineFor, perksCompatible, recoilMul, weaponDef,
} from '../src/modes/Weapons';
import { shotSpread } from '../src/modes/Hitscan';
import { realisticTtk } from '../src/modes/Balance';
import type { ServerMessage } from '../src/net/protocol';
import { translation } from '../src/ui/i18n';
import { BLOCK } from '../src/world/BlockRegistry';
import { Match, type MatchHost, WARMUP_SECONDS } from '../server/Match';

const rifle = weaponDef('rifle')!;
const kit = (o: Partial<typeof NO_KIT> = {}) => ({ ...NO_KIT, ...o });

class StubHost implements MatchHost {
  t = 1000;
  sent: { id: number; msg: ServerMessage }[] = [];
  blocks = { getBlock: () => BLOCK.AIR };
  now() { return this.t; }
  send(id: number, msg: ServerMessage) { this.sent.push({ id, msg }); }
  broadcast() {}
  random() { return 0; }
  ping() { return 0; }
  moveTo() {}
  of<T extends ServerMessage['t']>(t: T, id: number) {
    return this.sent.filter((s) => s.id === id && s.msg.t === t).map((s) => s.msg as Extract<ServerMessage, { t: T }>);
  }
}

function warmup() {
  const host = new StubHost();
  const match = new Match(host, { type: 'ffa', scoreLimit: 50, timeLimitSec: 600 });
  match.join(1, 'alice');
  match.join(2, 'bob');
  match.ready(1);
  match.ready(2);
  return { host, match, p: match.players.get(1)! };
}

function memoryStorage(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  return { store, getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
}

describe('attachments and the second perk (Weapons)', () => {
  it('grips and the laser fit the right weapons only', () => {
    expect(attachAllowed(rifle, 'vgrip')).toBe(true);
    expect(attachAllowed(rifle, 'laser')).toBe(true);
    expect(attachAllowed(weaponDef('shotgun')!, 'laser')).toBe(false); // its spread is its range
    expect(attachAllowed(weaponDef('sniper')!, 'vgrip')).toBe(false); // bolt action
    expect(attachAllowed(weaponDef('sniper')!, 'laser')).toBe(false); // built around a scope
    expect(attachAllowed(weaponDef('lever')!, 'laser')).toBe(true);
    expect(attachAllowed(weaponDef('pistol')!, 'laser')).toBe(false); // primaries only
    expect(attachAllowed(rifle, 'muzzle')).toBe(false);
    // Every primary except the shotgun and the scope-only bolt actions takes at least one attachment.
    const none = PRIMARY_WEAPONS.filter((id) => !Object.keys(ATTACHMENTS).some((a) => attachAllowed(weaponDef(id)!, a)));
    expect(none.sort()).toEqual(['antimat', 'shotgun', 'sniper']);
  });

  it('the laser tightens hip fire, the vertical grip aimed fire and recoil, the angled grip aims faster', () => {
    expect(hipSpreadMul(rifle, kit({ rail: 'laser' }))).toBeCloseTo(0.7, 9);
    expect(shotSpread(rifle, false, false, false, 0.7, 1)).toBeCloseTo(rifle.spread * 0.7, 9);
    expect(shotSpread(rifle, true, false, false, 0.7, 1)).toBeCloseTo(rifle.adsSpread, 9); // aimed: the laser does nothing
    expect(adsSpreadMul(rifle, kit({ under: 'vgrip' }))).toBeCloseTo(0.85, 9);
    expect(recoilMul(rifle, kit({ under: 'vgrip' }))).toBeCloseTo(0.75, 9);
    expect(adsTimeFor(rifle, 'iron', kit({ under: 'vgrip' }))).toBeGreaterThan(adsTimeFor(rifle, 'iron', NO_KIT));
    expect(adsTimeFor(rifle, 'iron', kit({ under: 'agrip' }))).toBeCloseTo(rifle.adsTime * 0.85, 9);
    // On a secondary, or a weapon that does not take it, an attachment does nothing.
    expect(hipSpreadMul(weaponDef('pistol')!, kit({ rail: 'laser' }))).toBe(1);
    expect(hipSpreadMul(weaponDef('shotgun')!, kit({ rail: 'laser' }))).toBe(1);
    // Two perks work together: Extended Mags in either slot.
    expect(magazineFor(rifle, kit({ perk: 'ninja', perk2: 'extmag' }))).toBe(42);
  });

  it('every attachment has its description in both languages (the English one equal to the data)', () => {
    for (const a of Object.values(ATTACHMENTS)) {
      expect(translation('en', `cac.att.${a.id}` as never)).toBe(a.desc);
      expect(translation('nl', `cac.att.${a.id}` as never)).not.toBe(a.desc);
    }
  });

  it('perks of one category do not combine', () => {
    expect(perksCompatible('extmag', 'ninja')).toBe(true);
    expect(perksCompatible('extmag', 'quickdraw')).toBe(false);
    expect(perksCompatible('ninja', 'lightfoot')).toBe(false);
    expect(perksCompatible('none', 'lightfoot')).toBe(true);
  });

  it('attachments keep the time to kill sane (realistic TTK moves by at most a quarter, never below the perfect TTK)', () => {
    for (const id of PRIMARY_WEAPONS) {
      const w = weaponDef(id)!;
      for (const att of ['vgrip', 'agrip', 'laser'] as const) {
        if (!attachAllowed(w, att)) continue;
        const k = kit(att === 'laser' ? { rail: att } : { under: att });
        for (const d of [5, 20, 35]) {
          const base = realisticTtk(w, d).ms, mod = realisticTtk(w, d, undefined, k).ms;
          if (!Number.isFinite(base)) continue;
          expect(mod / base, `${id} ${att} ${d}m`).toBeGreaterThan(0.75);
          expect(mod / base, `${id} ${att} ${d}m`).toBeLessThan(1.15);
        }
      }
    }
  });
});

describe('class validation with attachments and two perks', () => {
  it('keeps what fits and drops what does not, field by field', () => {
    expect(validateClass({ primary: 'smg', under: 'vgrip', rail: 'laser', perk: 'extmag', perk2: 'ninja' }))
      .toMatchObject({ primary: 'smg', under: 'vgrip', rail: 'laser', perk: 'extmag', perk2: 'ninja' });
    expect(validateClass({ primary: 'sniper', under: 'vgrip', rail: 'laser' })).toMatchObject({ under: 'none', rail: 'none' });
    expect(validateClass({ primary: 'rifle', under: 'laser', rail: 'vgrip' })).toMatchObject({ under: 'none', rail: 'none' }); // wrong slots
    expect(validateClass({ perk: 'extmag', perk2: 'quickdraw' }).perk2).toBe('none'); // same category
    expect(validateClass({ perk: 'ninja', perk2: 'ninja' }).perk2).toBe('none');
    expect(validateClass({ perk2: 'hasOwnProperty' }).perk2).toBe('none');
  });

  it('lockClass drops locked attachments and second perks; classLevel is the highest unlock', () => {
    const r1 = { level: 1, prestige: 0 };
    expect(lockClass({ primary: 'rifle', under: 'vgrip', rail: 'laser', perk: 'extmag', perk2: 'ninja' }, r1))
      .toMatchObject({ under: 'none', rail: 'none', perk2: 'ninja' });
    expect(lockClass({ primary: 'rifle', under: 'vgrip', rail: 'laser' }, { level: 3, prestige: 0 })).toMatchObject({ under: 'vgrip', rail: 'laser' });
    expect(lockClass({ primary: 'rifle', perk: 'quickdraw', perk2: 'suppressor' }, r1)).toMatchObject({ perk: 'quickdraw', perk2: 'none' });
    expect(classLevel({ ...DEFAULT_CLASS, under: 'agrip' })).toBe(5);
    expect(classUnlocked({ ...DEFAULT_CLASS, rail: 'laser' }, r1)).toBe(false);
    expect(classUnlocked({ ...DEFAULT_CLASS, rail: 'laser' }, { level: 2, prestige: 0 })).toBe(true);
  });

  it('parseExtras (the server rule): unknown slots, misplaced, unfitting and locked attachments and same-category perks refuse', () => {
    const r1 = { level: 1, prestige: 0 }, r20 = { level: 20, prestige: 0 };
    expect(parseExtras('rifle', 'none', undefined, undefined, r1)).toEqual({ ok: true });
    expect(parseExtras('rifle', 'extmag', 'ninja', { under: 'vgrip', rail: 'none' }, r20)).toEqual({ ok: true, perk2: 'ninja', under: 'vgrip', rail: 'none' });
    expect(parseExtras('rifle', 'none', undefined, { muzzle: 'none' }, r20)).toEqual({ ok: false, problem: 'slot' });
    expect(parseExtras('rifle', 'none', undefined, ['vgrip'], r20)).toEqual({ ok: false, problem: 'slot' });
    expect(parseExtras('rifle', 'none', undefined, 'vgrip', r20)).toEqual({ ok: false, problem: 'slot' });
    expect(parseExtras('rifle', 'none', undefined, { under: 'laser' }, r20)).toEqual({ ok: false, problem: 'attachment' });
    expect(parseExtras('rifle', 'none', undefined, { under: 'bipod' }, r20)).toEqual({ ok: false, problem: 'attachment' });
    expect(parseExtras('sniper', 'none', undefined, { under: 'vgrip' }, r20)).toEqual({ ok: false, problem: 'attachment' });
    expect(parseExtras('rifle', 'none', undefined, { rail: 'laser' }, r1)).toEqual({ ok: false, problem: 'locked' });
    expect(parseExtras('rifle', 'extmag', 'quickdraw', undefined, r20)).toEqual({ ok: false, problem: 'perks' });
    expect(parseExtras('rifle', 'extmag', 'extmag', undefined, r20)).toEqual({ ok: false, problem: 'perks' });
    expect(parseExtras('rifle', 'none', 'wallhack', undefined, r20)).toEqual({ ok: false, problem: 'perk' });
    expect(parseExtras('rifle', 'none', 'suppressor', undefined, r1)).toEqual({ ok: false, problem: 'locked' });
    // Without a rank (a game without profiles) nothing is locked.
    expect(parseExtras('rifle', 'none', 'suppressor', { rail: 'laser' })).toMatchObject({ ok: true, perk2: 'suppressor', rail: 'laser' });
  });

  it('the loadout message carries the attachments per slot', () => {
    expect(loadoutMessage({ ...DEFAULT_CLASS, rail: 'laser', perk2: 'ninja' })).toEqual({
      t: 'loadout', primary: 'rifle', secondary: 'pistol', optic: 'iron', perk: 'none', perk2: 'ninja', att: { under: 'none', rail: 'laser' },
    });
  });
});

describe('the class book (several saved classes)', () => {
  it('has CLASS_SLOTS classes that are all usable at level 1', () => {
    const b = defaultBook();
    expect(b.classes).toHaveLength(CLASS_SLOTS);
    for (const c of b.classes) expect(classUnlocked(c, { level: 1, prestige: 0 })).toBe(true);
    expect(equipped(b)).toBe(b.classes[0]);
  });

  it('migrates the old single custom class into slot 1, and a preset picked last into slot 2 (equipped)', () => {
    const custom = { ...DEFAULT_CLASS, primary: 'lmg', optic: 'holo' as const, perk: 'extmag' as const };
    const sniper = LOADOUT_PRESETS.find((p) => p.id === 'sniper')!;
    const s = memoryStorage({ [CLASS_STORAGE_KEY]: JSON.stringify({ primary: 'lmg', optic: 'holo', secondary: 'pistol', perk: 'extmag' }), [LAST_CLASS_STORAGE_KEY]: JSON.stringify(sniper) });
    const b = loadLocalBook(s);
    expect(b.classes[0]).toMatchObject({ ...custom, name: '' });
    expect(b.classes[1]).toMatchObject({ primary: 'sniper', optic: 'scope', name: 'Sniper' });
    expect(b.sel).toBe(1);
    // The custom class picked last: slot 1 stays equipped, nothing else is touched.
    const only = migrateBook(custom, custom);
    expect(only.sel).toBe(0);
    expect(only.classes[1]).toEqual(defaultBook().classes[1]);
    // Nothing saved at all: the default book.
    expect(loadLocalBook(memoryStorage())).toEqual(defaultBook());
    expect(loadLocalBook(null)).toEqual(defaultBook());
  });

  it('a saved book wins over the old keys and survives broken data', () => {
    const s = memoryStorage({ [CLASS_STORAGE_KEY]: JSON.stringify({ primary: 'lmg' }) });
    const b = defaultBook();
    b.classes[3] = { ...validateClass({ primary: 'dmr', optic: 'scope' }), name: 'Long' };
    b.sel = 3;
    saveLocalBook(s, b);
    expect(loadLocalBook(s)).toEqual(b);
    s.store.set(CLASS_BOOK_STORAGE_KEY, '{nope');
    expect(loadLocalBook(s).classes[0].primary).toBe('lmg'); // falls back to migrating the old key
    expect(() => saveLocalBook({ setItem: () => { throw new Error('quota'); } }, b)).not.toThrow();
  });

  it('sanitizes anything into exactly CLASS_SLOTS valid classes; bookShapeOk is strict about shape and size', () => {
    const b = sanitizeBook({ classes: [{ primary: 'railgun', name: '<b>Hi</b>' }, 'x', null], sel: 99 });
    expect(b.classes).toHaveLength(CLASS_SLOTS);
    expect(b.classes[0]).toMatchObject({ primary: 'rifle', name: 'bHib' });
    expect(b.sel).toBe(0);
    expect(cleanClassName('  Sniper   Elite  2 ')).toBe('Sniper Elite 2');
    expect(cleanClassName('x'.repeat(50))).toHaveLength(20);
    expect(bookShapeOk({ classes: [{ primary: 'rifle', name: 'A' }], sel: 0 })).toBe(true);
    expect(bookShapeOk({ classes: [], sel: 0 })).toBe(true);
    expect(bookShapeOk(null)).toBe(false);
    expect(bookShapeOk([])).toBe(false);
    expect(bookShapeOk({ classes: Array(CLASS_SLOTS + 1).fill({}) })).toBe(false);
    expect(bookShapeOk({ classes: [{ primary: 5 }] })).toBe(false);
    expect(bookShapeOk({ classes: [{ nested: {} }] })).toBe(false);
    expect(bookShapeOk({ classes: [], sel: 5 })).toBe(false);
    expect(bookShapeOk({ classes: [], sel: 0, extra: 1 })).toBe(false);
    expect(bookShapeOk({ classes: [{ name: 'x'.repeat(3000) }] })).toBe(false);
  });

  it('the profile keeps a book; a malformed one is refused and a damaged file is cleaned', () => {
    const p = newProfile('abcdefgh12', 'alice', 0);
    expect(p.classes).toBeUndefined();
    expect(setClasses(p, { classes: 'nope' })).toBe(false);
    expect(p.classes).toBeUndefined();
    expect(setClasses(p, { classes: [{ primary: 'smg', rail: 'laser', name: 'Run' }], sel: 0 })).toBe(true);
    expect(p.classes!.classes[0]).toMatchObject({ primary: 'smg', rail: 'laser', name: 'Run' });
    const again = sanitizeProfile(JSON.parse(JSON.stringify({ ...p, classes: { classes: [{ primary: 'bazooka' }], sel: -1 } })))!;
    expect(again.classes!.classes[0].primary).toBe('rifle');
    expect(again.classes!.sel).toBe(0);
    expect(sanitizeProfile({ ...p, classes: undefined })!.classes).toBeUndefined();
  });
});

describe('server: Match.setLoadout with attachments and two perks', () => {
  it('applies attachments and the second perk: spread multipliers in the slot, gear tells the client', () => {
    const { host, match, p } = warmup();
    expect(match.setLoadout(1, 'rifle', 'pistol', 'iron', 'extmag', { perk2: 'ninja', att: { under: 'vgrip', rail: 'laser' } })).toBeNull();
    expect(p).toMatchObject({ primary: 'rifle', perk: 'extmag', perk2: 'ninja', under: 'vgrip', rail: 'laser' });
    expect(p.slots[0].hipMul).toBeCloseTo(0.7, 9);
    expect(p.slots[0].adsMul).toBeCloseTo(0.85, 9);
    expect(p.slots[1].hipMul).toBe(1); // the pistol carries nothing
    expect(p.slots[0].cap).toBe(42);
    expect(match.holds(p).quiet).toBe(1);
    expect(host.of('gear', 1).at(-1)).toMatchObject({ perk: 'extmag', perk2: 'ninja', under: 'vgrip', rail: 'laser' });
  });

  it('refuses unknown slots, misplaced, unfitting and locked attachments and same-category perks, and changes nothing', () => {
    const { match, p } = warmup();
    match.setLoadout(1, 'smg', 'pistol', 'iron', 'none', { att: { rail: 'laser' } });
    const before = { ...p.next };
    const r1 = { level: 1, prestige: 0 };
    expect(match.setLoadout(1, 'rifle', 'pistol', 'iron', 'none', { att: { scope: 'laser' } })).toBe('slot');
    expect(match.setLoadout(1, 'rifle', 'pistol', 'iron', 'none', { att: { rail: 'vgrip' } })).toBe('attachment');
    expect(match.setLoadout(1, 'sniper', 'pistol', 'scope', 'none', { att: { under: 'vgrip' } })).toBe('attachment');
    expect(match.setLoadout(1, 'rifle', 'pistol', 'iron', 'none', { att: { under: 'vgrip' }, rank: r1 })).toBe('locked');
    expect(match.setLoadout(1, 'rifle', 'pistol', 'iron', 'extmag', { perk2: 'quickdraw' })).toBe('perks');
    expect(match.setLoadout(1, 'rifle', 'pistol', 'iron', 'none', { perk2: 'suppressor', rank: r1 })).toBe('locked');
    expect(p.next).toEqual(before);
    expect(p.primary).toBe('smg');
  });

  it('an old client (no perk2 / att) keeps the current extras where they still fit', () => {
    const { match, p } = warmup();
    match.setLoadout(1, 'rifle', 'pistol', 'iron', 'extmag', { perk2: 'ninja', att: { under: 'vgrip', rail: 'laser' } });
    match.setLoadout(1, 'smg');
    expect(p.next).toMatchObject({ primary: 'smg', perk2: 'ninja', under: 'vgrip', rail: 'laser' });
    match.setLoadout(1, 'sniper', 'pistol', 'scope', 'lightfoot');
    expect(p.next).toMatchObject({ primary: 'sniper', under: 'none', rail: 'none', perk: 'lightfoot', perk2: 'none' });
  });

  it('the server uses the attachments in the shot verdict (a laser tightens the hip-fire cone it tests)', () => {
    const { match, p } = warmup();
    const spread = (m: Match) => shotSpread(p.slots[0].def, m.adsBlend(p, m.now()), false, false, p.slots[0].hipMul, p.slots[0].adsMul);
    const plain = spread(match);
    match.setLoadout(1, 'rifle', 'pistol', 'iron', 'none', { att: { rail: 'laser' } });
    expect(spread(match)).toBeCloseTo(plain * 0.7, 9);
    expect(WARMUP_SECONDS).toBeGreaterThan(0);
  });
});
