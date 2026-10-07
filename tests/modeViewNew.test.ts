import { describe, expect, it } from 'vitest';
import { gameTypeDef } from '../src/modes/GameTypes';
import {
  bombRoleLine, eventView, infectedLine, localizeServerText, modeSpeedMul, nearestTags, siteAction, tagAction, teamLabel, teamWinTitle,
} from '../src/modes/ModeView';
import type { SiteState, TagState } from '../src/net/protocol';

const tag = (id: number, x: number, team: 'red' | 'blue' = 'blue'): TagState => ({ id, x, y: 65, z: 0, team });
const site = (over: Partial<SiteState> = {}): SiteState => ({ name: 'A', x: 0, y: 65, z: 0, r: 3, progress: 0, planted: false, ...over });

describe('mode view: the new modes', () => {
  it('kill confirmed: confirm enemy tags, deny your own; the nearest tags first', () => {
    expect(tagAction(tag(1, 0, 'blue'), 'red')).toBe('CONFIRM');
    expect(tagAction(tag(1, 0, 'red'), 'red')).toBe('DENY');
    const out: TagState[] = [];
    expect(nearestTags([tag(1, 9), tag(2, 1), tag(3, 5), tag(4, 20)], 0, 0, 2, out).map((x) => x.id)).toEqual([2, 3]);
    expect(eventView('tag-confirmed', 'red', 'red', 'Ann', 'You', true)).toEqual({ text: 'Kill confirmed', cue: 'good' });
    expect(eventView('tag-confirmed', 'blue', 'red', 'Bob', 'Bob', false).text).toBe('');
    expect(localizeServerText('First to 50 confirms')).toBe('First to 50 confirms');
  });

  it('search and destroy: captions per side and phase, alarms and results', () => {
    expect(siteAction(site(), 'red', 'red', false)).toBe('PLANT');
    expect(siteAction(site({ progress: 0.4 }), 'red', 'blue', false)).toBe('STOP THE PLANT');
    expect(siteAction(site({ planted: true }), 'red', 'blue', true)).toBe('DEFUSE');
    expect(siteAction(site({ planted: true }), 'red', 'red', true)).toBe('GUARD');
    expect(bombRoleLine('red', 'blue')).toBe('Defend A and B');
    expect(eventView('bomb-planted', 'red', 'blue', 'A', '', false)).toEqual({ text: 'Bomb planted at A', cue: 'alarm' });
    expect(eventView('bomb-defused', 'blue', 'blue', 'A', '', false).cue).toBe('good');
    expect(eventView('bomb-exploded', 'red', 'blue', 'A', '', false).cue).toBe('bad');
    expect(eventView('side-swap', 'blue', 'blue', '', '', false).text).toBe('Sides swapped: you attack');
  });

  it('infected: roles instead of colours, speed for the infected and the last survivor', () => {
    const def = gameTypeDef('infected');
    expect(teamLabel(def, 'red')).toBe('Infected');
    expect(teamWinTitle(def, 'blue')).toBe('The survivors win!');
    expect(teamWinTitle(gameTypeDef('tdm'), 'red')).toBe('Red team wins!');
    const st = { kind: 'infected' as const, survivors: 3, infected: 2, outbreakIn: 0, last: 0 };
    expect(modeSpeedMul(def, st, 'red', 1)).toBeCloseTo(def.params!.infectedSpeed);
    expect(modeSpeedMul(def, st, 'blue', 1)).toBe(1);
    expect(modeSpeedMul(def, { ...st, outbreakIn: 4 }, 'red', 1)).toBe(1);
    expect(infectedLine({ ...st, outbreakIn: 4.2 }, 'blue', 1)).toBe('Infection in 5');
    expect(infectedLine({ ...st, last: 1 }, 'blue', 1)).toBe('Last survivor: you are fast now');
    expect(localizeServerText('1 survivor left')).toBe('Survivors left: 1');
    expect(eventView('infected', 'red', 'blue', 'Ann', 'You', true).text).toBe('You were infected');
  });

  it('capture the flag keeps its carrier slow-down through the shared speed function', () => {
    const def = gameTypeDef('ctf');
    const flags = [{ team: 'red' as const, status: 'carried' as const, x: 0, y: 0, z: 0, carrier: 7, returnIn: 0, hx: 0, hy: 0, hz: 0 }];
    expect(modeSpeedMul(def, { kind: 'ctf', flags }, 'blue', 7)).toBeCloseTo(1 - def.params!.carrySlow);
    expect(modeSpeedMul(def, { kind: 'ctf', flags }, 'blue', 8)).toBe(1);
  });

  it('sharpshooter: the rotation banner names the weapon', () => {
    expect(eventView('weapon-rotate', '', '', 'sniper', '', false).text).toContain('Bolt-Action Sniper');
  });
});
