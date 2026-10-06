import type { Team } from './GameTypes';
import type { FlagState, MatchPhase, ModeEventKind, ZoneState } from '../net/protocol';

/**
 * DOM-free view logic of the objective modes (texts, colours, cues, marker placement), shared by
 * the HUD and the tests. Everything the client shows comes from the server's `mode` / `event`
 * messages; nothing here decides game state.
 */

export const NEUTRAL_COLOR = '#e8e8e8';
export const CONTESTED_COLOR = '#ffaa00';
const TEAM_HEX: Record<Team, string> = { red: '#e0463c', blue: '#3c7ae0' };

export const teamName = (t: Team): string => (t === 'red' ? 'Red' : 'Blue');
export const otherTeam = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/** Zone letter in map order: A, B, C ... */
export function zoneLetter(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

/** Marker colour of a zone: contested orange, owner's colour, otherwise neutral. */
export function zoneColor(z: ZoneState): string {
  if (z.contested) return CONTESTED_COLOR;
  return z.owner ? TEAM_HEX[z.owner] : NEUTRAL_COLOR;
}

/** Short status under a zone marker from the viewer's side. */
export function zoneStatus(z: ZoneState, self: Team | '', variant: 'hardpoint' | 'domination'): string {
  if (z.contested) return 'CONTESTED';
  if (variant === 'hardpoint') {
    if (!z.owner) return 'CAPTURE';
    return z.owner === self ? 'DEFEND' : 'ATTACK';
  }
  if (z.owner === self) return z.progressTeam && z.progressTeam !== self && z.progress < 1 ? 'LOSING' : 'DEFEND';
  if (z.progressTeam === self && z.progress > 0) return 'CAPTURING';
  return z.owner ? 'ATTACK' : 'CAPTURE';
}

/** Capture ring fill 0..1 and its colour (domination progress; a held hill is full). */
export function zoneRing(z: ZoneState, variant: 'hardpoint' | 'domination'): { fill: number; color: string } {
  if (variant === 'hardpoint') return { fill: z.owner ? 1 : 0, color: z.owner ? TEAM_HEX[z.owner] : NEUTRAL_COLOR };
  if (z.owner && (!z.progressTeam || z.progressTeam === z.owner)) return { fill: 1, color: TEAM_HEX[z.owner] };
  return { fill: z.progress, color: z.progressTeam ? TEAM_HEX[z.progressTeam] : NEUTRAL_COLOR };
}

/** One line per flag for the HUD ("Blue flag: taken by Ann", "Red flag: dropped 8"). */
export function flagLine(f: FlagState, nameOf: (id: number) => string): string {
  const who = `${teamName(f.team)} flag`;
  if (f.status === 'home') return `${who}: home`;
  if (f.status === 'carried') return `${who}: taken by ${nameOf(f.carrier)}`;
  return `${who}: dropped ${Math.ceil(f.returnIn)}`;
}

/** What the viewer should do about a flag (marker caption). */
export function flagAction(f: FlagState, self: Team | '', selfId: number): string {
  if (!self) return '';
  if (f.team === self) return f.status === 'home' ? 'DEFEND' : f.status === 'dropped' ? 'RETURN' : 'KILL CARRIER';
  if (f.status === 'carried') return f.carrier === selfId ? 'CAPTURE' : 'ESCORT';
  return 'TAKE';
}

/** Whether the viewer carries a flag (movement is slower). */
export function carriesFlag(flags: readonly FlagState[], selfId: number): boolean {
  for (const f of flags) if (f.status === 'carried' && f.carrier === selfId) return true;
  return false;
}

export type Cue = 'good' | 'bad' | 'alarm' | 'neutral';

/**
 * Banner text and sound for a mode event, seen from `self`. `team` is the flag's team for flag
 * taken/dropped/returned, the scoring team for a capture, the capturing/losing team for zones and
 * the winner of a round.
 */
export function eventView(
  kind: ModeEventKind, team: Team | '', self: Team | '', text: string, who: string, selfIsActor: boolean,
): { text: string; cue: Cue } {
  const ours = !!team && team === self;
  switch (kind) {
    case 'flag-taken': return { text: `${who} took the ${team ? teamName(team) : ''} flag`.replace('  ', ' '), cue: ours ? 'alarm' : 'good' };
    case 'flag-dropped': return { text: `The ${team ? teamName(team) : ''} flag was dropped`, cue: ours ? 'good' : 'bad' };
    case 'flag-returned': return { text: `The ${team ? teamName(team) : ''} flag returned`, cue: ours ? 'good' : 'neutral' };
    case 'flag-captured': return { text: `${who} captured the flag for ${team ? teamName(team) : ''}`, cue: ours ? 'good' : 'bad' };
    case 'zone-captured': return { text: `${team ? teamName(team) : ''} captured ${text}`, cue: ours ? 'good' : 'bad' };
    case 'zone-lost': return { text: `${team ? teamName(team) : ''} lost ${text}`, cue: ours ? 'bad' : 'good' };
    case 'zone-moved': return { text: `New hill: ${text}`, cue: 'neutral' };
    case 'round-start': return { text, cue: 'neutral' };
    case 'round-win': return { text: team ? `${teamName(team)} wins the round` : 'Round draw', cue: !team ? 'neutral' : ours ? 'good' : 'bad' };
    case 'level-up': return { text: selfIsActor ? `Level up: ${text}` : '', cue: selfIsActor ? 'good' : 'neutral' };
    case 'level-down': return { text: selfIsActor ? 'Knifed: one level down' : text, cue: selfIsActor ? 'bad' : 'neutral' };
    default: return { text, cue: 'neutral' };
  }
}

/** The big line in the middle of the screen for the non-live phases of a round mode. */
export function phaseBanner(phase: MatchPhase, seconds: number, round: number): string {
  const n = Math.max(0, Math.ceil(seconds));
  switch (phase) {
    case 'intermission': return `Round ${round} starts in ${n}`;
    case 'countdown': return n > 0 ? String(n) : 'Fight!';
    default: return '';
  }
}

/**
 * Places a world-space marker on the screen. `ndc` is the projected point (x, y in -1..1, `behind`
 * when the point is behind the camera). Off-screen markers stick to the screen edge, in the right
 * direction, `margin` pixels in. Writes pixel coordinates into `out`.
 */
export function placeMarker(
  ndcX: number, ndcY: number, behind: boolean, width: number, height: number, margin: number, out: { x: number; y: number; edge: boolean },
  /** Space kept free at the top (the timer and score bar live there). */
  topMargin = margin,
  /** Space kept free at the bottom (health, weapon slots and ammo live there). */
  bottomMargin = margin,
): void {
  let x = ndcX, y = ndcY;
  if (behind) { x = -x; y = -y; }
  const inside = !behind && x >= -1 && x <= 1 && y >= -1 && y <= 1;
  if (!inside) {
    // Push the direction out to the border of the screen rectangle; behind the camera sits on the bottom edge.
    const m = Math.max(Math.abs(x), Math.abs(y), 1e-6);
    x /= m; y /= m;
    if (behind) y = -1;
  }
  out.x = Math.max(margin, Math.min(width - margin, (x * 0.5 + 0.5) * width));
  out.y = Math.max(topMargin, Math.min(height - bottomMargin, (0.5 - y * 0.5) * height));
  out.edge = !inside;
}
