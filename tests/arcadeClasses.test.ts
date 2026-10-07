import { describe, expect, it } from 'vitest';
import {
  CLASS_STORAGE_KEY, DEFAULT_CLASS, LOADOUT_PRESETS, classApplies, loadSavedClass, presetFor, presetsValid, saveClass, validateClass,
} from '../src/modes/Loadouts';
import { GUN_GAME_LADDER } from '../src/modes/GameTypes';
import { SECONDARY_WEAPONS, weaponDef } from '../src/modes/Weapons';
import type { ClientMessage, MatchInfo, ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { CLASS_SWAP_WINDOW, Match, type MatchHost, SPAWN_PROTECTION, WARMUP_SECONDS } from '../server/Match';

type Fire = Extract<ClientMessage, { t: 'fire' }>;

class StubHost implements MatchHost {
  t = 1000;
  sent: { id: number; msg: ServerMessage }[] = [];
  casts: ServerMessage[] = [];
  blocks = { getBlock: () => BLOCK.AIR };
  now() { return this.t; }
  send(id: number, msg: ServerMessage) { this.sent.push({ id, msg }); }
  broadcast(msg: ServerMessage) { this.casts.push(msg); }
  random() { return 0; }
  ping() { return 0; }
  moveTo() {}
  of<T extends ServerMessage['t']>(t: T, id: number) {
    return this.sent.filter((s) => s.id === id && s.msg.t === t).map((s) => s.msg as Extract<ServerMessage, { t: T }>);
  }
}

function live(type: MatchInfo['type'] = 'ffa') {
  const host = new StubHost();
  const match = new Match(host, { type, scoreLimit: 50, timeLimitSec: 600 });
  const advance = (sec: number, step = 0.01) => { for (let t = 0; t < sec - 1e-9; t += step) { host.t += step; match.tick(); } };
  match.join(1, 'alice');
  match.join(2, 'bob');
  match.ready(1);
  match.ready(2);
  advance(WARMUP_SECONDS + 0.2);
  return { host, match, advance };
}

const shotAtBob = (): Fire => ({ t: 'fire', slot: 0, ox: 0.5, oy: 66.62, oz: 0.5, dx: 0, dy: -0.0719, dz: 0.9974, ads: true });

describe('class validation (Create-a-Class)', () => {
  it('keeps a valid class and replaces every invalid field with the default', () => {
    expect(validateClass({ primary: 'dmr', optic: 'scope', secondary: 'mpistol', perk: 'ninja' }))
      .toEqual({ primary: 'dmr', optic: 'scope', secondary: 'mpistol', perk: 'ninja' });
    expect(validateClass(null)).toEqual(DEFAULT_CLASS);
    expect(validateClass('rifle')).toEqual(DEFAULT_CLASS);
    expect(validateClass({ primary: 'knife', secondary: 'rifle', optic: 'laser', perk: 'wallhack' })).toEqual(DEFAULT_CLASS);
    expect(validateClass({ primary: 'pistol' }).primary).toBe('rifle'); // a secondary is not a primary
    expect(validateClass({ secondary: 'sniper' }).secondary).toBe('pistol');
    expect(validateClass({ perk: 'toString' }).perk).toBe('none'); // no prototype keys
  });

  it('an optic the weapon does not take becomes the weapon\'s default optic', () => {
    expect(validateClass({ primary: 'rifle', optic: 'scope' }).optic).toBe('iron');
    expect(validateClass({ primary: 'sniper', optic: 'reddot' }).optic).toBe('scope');
    expect(validateClass({ primary: 'smg', optic: 'holo' }).optic).toBe('holo');
  });

  it('presets are valid classes with unique ids, at least six of them, and every new weapon is in one', () => {
    expect(presetsValid()).toBe(true);
    expect(LOADOUT_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(LOADOUT_PRESETS.map((p) => p.id)).size).toBe(LOADOUT_PRESETS.length);
    for (const id of ['lmg', 'sniper', 'dmr', 'mpistol']) expect(LOADOUT_PRESETS.some((p) => p.primary === id || p.secondary === id), id).toBe(true);
    expect(presetFor(LOADOUT_PRESETS[0])?.id).toBe(LOADOUT_PRESETS[0].id);
    expect(presetFor({ ...LOADOUT_PRESETS[0], perk: 'none' === LOADOUT_PRESETS[0].perk ? 'ninja' : 'none' })).toBeNull();
  });

  it('remembers the custom class in storage and survives broken or missing data', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadSavedClass(storage)).toBeNull();
    saveClass(storage, { primary: 'lmg', optic: 'holo', secondary: 'revolver', perk: 'extmag' });
    expect(loadSavedClass(storage)).toEqual({ primary: 'lmg', optic: 'holo', secondary: 'revolver', perk: 'extmag' });
    store.set(CLASS_STORAGE_KEY, '{nope');
    expect(loadSavedClass(storage)).toBeNull();
    store.set(CLASS_STORAGE_KEY, JSON.stringify({ primary: 'bazooka', perk: 'extmag' }));
    expect(loadSavedClass(storage)).toEqual({ ...DEFAULT_CLASS, perk: 'extmag' });
    expect(loadSavedClass({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
    expect(() => saveClass({ setItem: () => { throw new Error('quota'); } }, DEFAULT_CLASS)).not.toThrow();
    expect(loadSavedClass(null)).toBeNull();
  });
});

describe('server: classes', () => {
  it('an invalid class from a client falls back to the default class at the next spawn', () => {
    const { host, match, advance } = live();
    match.fire(1, shotAtBob()); // the life has begun: the class waits for the next one
    match.setLoadout(1, 'railgun', 'sniper', 'xray', 'aimbot');
    expect(match.players.get(1)!.next).toEqual(DEFAULT_CLASS);
    match.players.get(1)!.alive = false;
    match.players.get(1)!.respawnAt = host.t;
    advance(0.05);
    expect(host.of('spawn', 1).at(-1)).toMatchObject({ primary: 'rifle', secondary: 'pistol', optic: 'iron', perk: 'none' });
  });

  it('a class chosen right after spawning applies at once; after the first shot or the window it waits', () => {
    const { host, match, advance } = live();
    match.setLoadout(1, 'lmg', 'mpistol', 'holo', 'extmag');
    const p = match.players.get(1)!;
    expect(p.primary).toBe('lmg');
    expect(p.optic).toBe('holo');
    expect(p.slots[0].mag).toBe(Math.round(75 * 1.4));
    expect(p.slots[1].def.id).toBe('mpistol');
    expect(host.of('gear', 1).at(-1)).toMatchObject({ primary: 'lmg', secondary: 'mpistol', optic: 'holo', perk: 'extmag' });
    expect(host.casts.some((m) => m.t === 'holds' && m.id === 1 && m.weapon === 'lmg' && m.optic === 'holo')).toBe(true);
    advance(CLASS_SWAP_WINDOW + 0.1);
    match.setLoadout(1, 'smg');
    expect(p.primary).toBe('lmg');
    expect(p.next.primary).toBe('smg');
  });

  it('a class chosen while nobody is fighting (warm-up, waiting for players) applies at once, even long after spawning', () => {
    const host = new StubHost();
    const match = new Match(host, { type: 'tdm', scoreLimit: 50, timeLimitSec: 600 });
    const advance = (sec: number, step = 0.01) => { for (let t = 0; t < sec - 1e-9; t += step) { host.t += step; match.tick(); } };
    match.join(1, 'alice');
    match.ready(1);
    advance(CLASS_SWAP_WINDOW + 5); // alone in the lobby: waiting for players, well past the spawn window
    expect(match.phase).not.toBe('live');
    match.setLoadout(1, 'sniper', 'revolver', 'scope', 'none');
    const p = match.players.get(1)!;
    expect(p.primary).toBe('sniper');
    expect(p.slots[1].def.id).toBe('revolver');
    expect(host.of('gear', 1).at(-1)).toMatchObject({ primary: 'sniper', secondary: 'revolver', optic: 'scope' });
  });

  it('extended mags reload to the bigger magazine; the suppressor marks shots and shortens damage range', () => {
    const { host, match, advance } = live();
    match.setLoadout(1, 'rifle', 'pistol', 'reddot', 'suppressor');
    match.setLoadout(2, 'rifle', 'pistol', 'iron', 'ninja');
    advance(SPAWN_PROTECTION + 0.2);
    match.setPosition(1, 0.5, 65, 0.5);
    match.setPosition(2, 0.5, 65, 60.5);
    advance(0.5);
    host.sent = [];
    host.casts = [];
    match.fire(1, { ...shotAtBob(), dy: -0.012, dz: 0.99993 });
    const shot = host.casts.find((m) => m.t === 'shot');
    expect(shot && shot.t === 'shot' && shot.sup).toBe(1);
    const hit = host.of('hit', 1)[0];
    expect(hit).toBeDefined();
    // 60 blocks with a suppressor: range 32 → 25.6, falloff end 80 → 64: almost the minimum damage.
    expect(hit.damage).toBeLessThan(13);
    const holds = match.holds(match.players.get(2)!);
    expect(holds.quiet).toBe(1);
    expect(match.holds(match.players.get(1)!).sup).toBe(1);
  });

  it('quickdraw halves the switch delay', () => {
    const { match, advance } = live();
    match.setLoadout(1, 'rifle', 'pistol', 'iron', 'quickdraw');
    advance(SPAWN_PROTECTION + 0.2);
    const p = match.players.get(1)!;
    const t = match.now();
    match.switchWeapon(1, 1);
    expect(p.switchReadyAt - t).toBeCloseTo(0.125, 6);
  });

  it('gun game ignores classes and keeps its ladder (starting with an all-rounder, not the shotgun)', () => {
    const { match } = live('gungame');
    expect(GUN_GAME_LADDER[0]).not.toBe('shotgun');
    expect(weaponDef(GUN_GAME_LADDER[0])!.range).toBeGreaterThanOrEqual(30);
    match.setLoadout(1, 'sniper', 'mpistol', 'scope', 'extmag');
    const p = match.players.get(1)!;
    expect(p.slots.map((s) => s.def.id)).toEqual([GUN_GAME_LADDER[0], 'knife', 'knife']);
    expect(p.perk).toBe('none');
    expect(SECONDARY_WEAPONS).not.toContain('knife');
  });
});

describe('when a picked class applies (the Create-a-Class note follows the server rule)', () => {
  it('now outside a live round and right after spawning; at the respawn when dead; else from the next life', () => {
    for (const phase of ['warmup', 'countdown', 'roundend', 'intermission']) expect(classApplies(phase, true, true, 60), phase).toBe('now');
    expect(classApplies('live', true, false, 1)).toBe('now');
    expect(classApplies('live', true, false, CLASS_SWAP_WINDOW + 0.1)).toBe('nextLife');
    expect(classApplies('live', true, true, 1)).toBe('nextLife');
    expect(classApplies('live', false, true, 9)).toBe('respawn');
    expect(classApplies('ended', true, false, 0)).toBe('respawn');
  });
});
