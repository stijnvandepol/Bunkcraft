import { describe, expect, it } from 'vitest';
import {
  CONTESTED_COLOR, NEUTRAL_COLOR, carriesFlag, eventView, flagAction, flagLine, phaseBanner, placeMarker, zoneColor, zoneLetter, zoneRing, zoneStatus,
} from '../src/modes/ModeView';
import type { FlagState, ZoneState } from '../src/net/protocol';

const zone = (over: Partial<ZoneState> = {}): ZoneState => ({
  name: 'A', x: 0, y: 65, z: 0, r: 5, active: true, owner: '', progress: 0, progressTeam: '', contested: false, red: 0, blue: 0, ...over,
});
const flag = (over: Partial<FlagState> = {}): FlagState => ({
  team: 'red', status: 'home', x: 0, y: 65, z: 0, carrier: 0, returnIn: 0, hx: 0, hy: 65, hz: 0, ...over,
});

describe('mode view: zones', () => {
  it('letters, colours and captions follow owner and contest', () => {
    expect(zoneLetter(0)).toBe('A');
    expect(zoneLetter(2)).toBe('C');
    expect(zoneColor(zone())).toBe(NEUTRAL_COLOR);
    expect(zoneColor(zone({ contested: true, owner: 'red' }))).toBe(CONTESTED_COLOR);
    expect(zoneColor(zone({ owner: 'blue' }))).toBe('#3c7ae0');
    expect(zoneStatus(zone({ owner: 'red' }), 'red', 'hardpoint')).toBe('DEFEND');
    expect(zoneStatus(zone({ owner: 'red' }), 'blue', 'hardpoint')).toBe('ATTACK');
    expect(zoneStatus(zone(), 'blue', 'hardpoint')).toBe('CAPTURE');
    expect(zoneStatus(zone({ contested: true }), 'blue', 'domination')).toBe('CONTESTED');
    expect(zoneStatus(zone({ progressTeam: 'blue', progress: 0.4 }), 'blue', 'domination')).toBe('CAPTURING');
    expect(zoneStatus(zone({ owner: 'blue', progressTeam: 'red', progress: 0.5 }), 'blue', 'domination')).toBe('LOSING');
  });

  it('the ring shows capture progress in domination and a full ring for a held hill', () => {
    expect(zoneRing(zone({ owner: 'red' }), 'hardpoint')).toEqual({ fill: 1, color: '#e0463c' });
    expect(zoneRing(zone({ progressTeam: 'blue', progress: 0.3 }), 'domination')).toEqual({ fill: 0.3, color: '#3c7ae0' });
    expect(zoneRing(zone({ owner: 'red', progressTeam: 'red', progress: 1 }), 'domination').fill).toBe(1);
  });
});

describe('mode view: flags and events', () => {
  it('describes flags and what to do about them', () => {
    const name = (id: number) => (id === 5 ? 'Ann' : '?');
    expect(flagLine(flag(), name)).toBe('Red flag: home');
    expect(flagLine(flag({ status: 'carried', carrier: 5 }), name)).toBe('Red flag: taken by Ann');
    expect(flagLine(flag({ status: 'dropped', returnIn: 7.2 }), name)).toBe('Red flag: dropped 8');
    expect(flagAction(flag(), 'red', 1)).toBe('DEFEND');
    expect(flagAction(flag({ status: 'dropped' }), 'red', 1)).toBe('RETURN');
    expect(flagAction(flag(), 'blue', 1)).toBe('TAKE');
    expect(flagAction(flag({ status: 'carried', carrier: 1 }), 'blue', 1)).toBe('CAPTURE');
    expect(flagAction(flag({ status: 'carried', carrier: 2 }), 'blue', 1)).toBe('ESCORT');
    expect(carriesFlag([flag({ status: 'carried', carrier: 1 })], 1)).toBe(true);
    expect(carriesFlag([flag({ status: 'carried', carrier: 2 })], 1)).toBe(false);
  });

  it('turns events into a banner and a cue from the viewer side', () => {
    expect(eventView('flag-taken', 'red', 'red', '', 'Bob', false)).toEqual({ text: 'Bob took the Red flag', cue: 'alarm' });
    expect(eventView('flag-taken', 'red', 'blue', '', 'You', true).cue).toBe('good');
    expect(eventView('flag-captured', 'blue', 'blue', '', 'Ann', false)).toEqual({ text: 'Ann captured the flag for Blue', cue: 'good' });
    expect(eventView('zone-captured', 'red', 'blue', 'Courtyard', '', false)).toEqual({ text: 'Red captured Courtyard', cue: 'bad' });
    expect(eventView('round-win', '', 'red', '', '', false)).toEqual({ text: 'Round draw', cue: 'neutral' });
    expect(eventView('level-up', '', '', 'smg', '', false).text).toBe('');
    expect(phaseBanner('intermission', 4.2, 3)).toBe('Round 3 starts in 5');
    expect(phaseBanner('countdown', 0, 3)).toBe('Fight!');
    expect(phaseBanner('live', 10, 3)).toBe('');
  });
});

describe('mode view: marker placement', () => {
  const out = { x: 0, y: 0, edge: false };
  it('maps on-screen points to pixels and keeps off-screen ones at the edge', () => {
    placeMarker(0, 0, false, 800, 600, 40, out);
    expect(out).toEqual({ x: 400, y: 300, edge: false });
    placeMarker(3, 0, false, 800, 600, 40, out);
    expect(out.x).toBe(760);
    expect(out.edge).toBe(true);
    // Behind the camera on the right: shown on the left edge (it is mirrored), at the bottom.
    placeMarker(0.5, 0.1, true, 800, 600, 40, out);
    expect(out.edge).toBe(true);
    expect(out.y).toBe(560);
    // Markers above the screen stay below the top bar.
    placeMarker(0, 3, false, 800, 600, 40, out, 150);
    expect(out.y).toBe(150);
  });
});
