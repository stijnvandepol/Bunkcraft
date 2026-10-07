import type { GameTypeDef, Team } from './GameTypes';
import type { FlagState, MatchPhase, ModeEventKind, ModeState, SiteState, TagState, ZoneState, ZoneVariant } from '../net/protocol';
import { weaponDef } from './Weapons';
import { t } from '../ui/i18n';

/**
 * DOM-free view logic of the objective modes (texts, colours, cues, marker placement), shared by
 * the HUD and the tests. Everything the client shows comes from the server's `mode` / `event`
 * messages; nothing here decides game state.
 */

export const NEUTRAL_COLOR = '#e8e8e8';
export const CONTESTED_COLOR = '#ffaa00';
const TEAM_HEX: Record<Team, string> = { red: '#e0463c', blue: '#3c7ae0' };

export const teamName = (team: Team): string => (team === 'red' ? t('mode.red') : t('mode.blue'));
export const otherTeam = (team: Team): Team => (team === 'red' ? 'blue' : 'red');

/** Zone letter in map order: A, B, C ... */
export function zoneLetter(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

/** King of the hill: the hill is yours (gold) or somebody else's (red). */
export const KING_SELF_COLOR = '#ffd23f';
export const KING_OTHER_COLOR = '#e0463c';

/** Marker colour of a zone: contested orange, owner's colour (king of the hill: gold when you hold it), otherwise neutral. */
export function zoneColor(z: ZoneState, selfId = 0): string {
  if (z.contested) return CONTESTED_COLOR;
  if (z.holder) return z.holder === selfId ? KING_SELF_COLOR : KING_OTHER_COLOR;
  return z.owner ? TEAM_HEX[z.owner] : NEUTRAL_COLOR;
}

/** Short status under a zone marker from the viewer's side. */
export function zoneStatus(z: ZoneState, self: Team | '', variant: ZoneVariant, selfId = 0): string {
  if (z.contested) return t('mode.zone.contested');
  if (variant === 'koth') {
    if (!z.holder) return t('mode.zone.capture');
    return z.holder === selfId ? t('mode.koth.holding') : t('mode.koth.taken');
  }
  if (variant === 'hardpoint') {
    if (!z.owner) return t('mode.zone.capture');
    return z.owner === self ? t('mode.zone.defend') : t('mode.zone.attack');
  }
  if (z.owner === self) return z.progressTeam && z.progressTeam !== self && z.progress < 1 ? t('mode.zone.losing') : t('mode.zone.defend');
  if (z.progressTeam === self && z.progress > 0) return t('mode.zone.capturing');
  return z.owner ? t('mode.zone.attack') : t('mode.zone.capture');
}

/** Capture ring fill 0..1 and its colour (domination progress; a held hill is full). */
export function zoneRing(z: ZoneState, variant: ZoneVariant, selfId = 0): { fill: number; color: string } {
  if (variant === 'koth') return { fill: z.holder ? 1 : 0, color: zoneColor(z, selfId) };
  if (variant === 'hardpoint') return { fill: z.owner ? 1 : 0, color: z.owner ? TEAM_HEX[z.owner] : NEUTRAL_COLOR };
  if (z.owner && (!z.progressTeam || z.progressTeam === z.owner)) return { fill: 1, color: TEAM_HEX[z.owner] };
  return { fill: z.progress, color: z.progressTeam ? TEAM_HEX[z.progressTeam] : NEUTRAL_COLOR };
}

/** One line per flag for the HUD ("Blue flag: taken by Ann", "Red flag: dropped 8"). */
export function flagLine(f: FlagState, nameOf: (id: number) => string): string {
  const team = teamName(f.team);
  if (f.status === 'home') return t('mode.flag.home', team);
  if (f.status === 'carried') return t('mode.flag.carried', team, nameOf(f.carrier));
  return t('mode.flag.dropped', team, Math.ceil(f.returnIn));
}

/** What the viewer should do about a flag (marker caption). */
export function flagAction(f: FlagState, self: Team | '', selfId: number): string {
  if (!self) return '';
  if (f.team === self) return f.status === 'home' ? t('mode.flag.defend') : f.status === 'dropped' ? t('mode.flag.return') : t('mode.flag.killCarrier');
  if (f.status === 'carried') return f.carrier === selfId ? t('mode.flag.capture') : t('mode.flag.escort');
  return t('mode.flag.take');
}

/** Whether the viewer carries a flag (movement is slower). */
export function carriesFlag(flags: readonly FlagState[], selfId: number): boolean {
  for (const f of flags) if (f.status === 'carried' && f.carrier === selfId) return true;
  return false;
}

/** Movement factor the mode puts on the viewer (flag carrier slower, infected and the last survivor faster); matches the server's `speedMul`. */
export function modeSpeedMul(def: GameTypeDef, state: ModeState | null, selfTeam: Team | '', selfId: number): number {
  if (!state) return 1;
  if (state.kind === 'ctf') return carriesFlag(state.flags, selfId) ? 1 - (def.params?.carrySlow ?? 0.1) : 1;
  if (state.kind === 'infected') {
    const fast = (state.outbreakIn <= 0 && selfTeam === 'red') || (state.last !== 0 && state.last === selfId);
    return fast ? def.params?.infectedSpeed ?? 1.12 : 1;
  }
  return 1;
}

/** Name of a team: its role where the mode has roles (infected: "Infected", "Survivors"), else its colour. */
export function teamLabel(def: GameTypeDef, team: Team): string {
  if (def.teamRoles) return team === 'red' ? t('mode.inf.infected') : t('mode.inf.survivors');
  return teamName(team);
}

/** End screen title of a team win. */
export function teamWinTitle(def: GameTypeDef, team: Team): string {
  if (def.teamRoles) return team === 'red' ? t('mode.inf.infectedWin') : t('mode.inf.survivorsWin');
  return team === 'red' ? t('arc.end.redWins') : t('arc.end.blueWins');
}

/** Kill confirmed: what picking up a tag does for the viewer. */
export function tagAction(tag: TagState, self: Team | ''): string {
  if (!self) return '';
  return tag.team === self ? t('mode.tag.deny') : t('mode.tag.confirm');
}

/** Kill confirmed: the `n` tags nearest to (x, z), nearest first (written into `out`, which is returned). */
export function nearestTags(tags: readonly TagState[], x: number, z: number, n: number, out: TagState[]): TagState[] {
  out.length = 0;
  for (const tag of tags) {
    const d = Math.hypot(tag.x - x, tag.z - z);
    let i = out.length;
    while (i > 0 && Math.hypot(out[i - 1].x - x, out[i - 1].z - z) > d) i--;
    if (i < n) {
      out.splice(i, 0, tag);
      if (out.length > n) out.length = n;
    }
  }
  return out;
}

/** Search and destroy: the caption on a bomb site marker. */
export function siteAction(site: SiteState, attackers: Team, self: Team | '', planted: boolean): string {
  if (!self) return '';
  const attack = self === attackers;
  if (site.planted) return attack ? t('mode.bomb.guard') : t('mode.bomb.defuse');
  if (planted) return '';
  if (site.progress > 0) return attack ? t('mode.bomb.planting') : t('mode.bomb.stop');
  return attack ? t('mode.bomb.plant') : t('mode.bomb.defend');
}

/** Search and destroy: the role line ("Attack: plant the bomb at A or B" / "Defend A and B"). */
export function bombRoleLine(attackers: Team, self: Team | ''): string {
  if (!self) return '';
  return self === attackers ? t('mode.bomb.roleAttack') : t('mode.bomb.roleDefend');
}

/** Infected: the panel line for the viewer. */
export function infectedLine(state: Extract<ModeState, { kind: 'infected' }>, self: Team | '', selfId: number): string {
  if (state.outbreakIn > 0) return t('mode.inf.outbreakIn', Math.ceil(state.outbreakIn));
  if (state.last && state.last === selfId) return t('mode.inf.youLast');
  return self === 'red' ? t('mode.inf.youInfected') : t('mode.inf.youSurvive');
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
  const tn = team ? teamName(team) : '';
  switch (kind) {
    case 'flag-taken': return { text: t('mode.ev.flagTaken', who, tn).replace('  ', ' '), cue: ours ? 'alarm' : 'good' };
    case 'flag-dropped': return { text: t('mode.ev.flagDropped', tn), cue: ours ? 'good' : 'bad' };
    case 'flag-returned': return { text: t('mode.ev.flagReturned', tn), cue: ours ? 'good' : 'neutral' };
    case 'flag-captured': return { text: t('mode.ev.flagCaptured', who, tn), cue: ours ? 'good' : 'bad' };
    case 'zone-captured': return { text: t('mode.ev.zoneCaptured', tn, text), cue: ours ? 'good' : 'bad' };
    case 'zone-lost': return { text: t('mode.ev.zoneLost', tn, text), cue: ours ? 'bad' : 'good' };
    case 'zone-moved': return { text: t('mode.ev.zoneMoved', text), cue: 'neutral' };
    case 'round-start': return { text: localizeServerText(text), cue: 'neutral' };
    case 'round-win': return { text: team ? t('mode.ev.roundWin', tn) : t('mode.ev.roundDraw'), cue: !team ? 'neutral' : ours ? 'good' : 'bad' };
    // The server sends the weapon id ("smg"): show its name.
    case 'level-up': return { text: selfIsActor ? t('mode.ev.levelUp', weaponDef(text)?.name ?? text) : '', cue: selfIsActor ? 'good' : 'neutral' };
    case 'level-down': return { text: selfIsActor ? t('mode.ev.levelDown') : localizeServerText(text), cue: selfIsActor ? 'bad' : 'neutral' };
    // Kill confirmed: only your own pick-ups get a banner (every tag of the match would flood the screen).
    case 'tag-confirmed': return { text: selfIsActor ? t('mode.ev.tagConfirmed') : '', cue: selfIsActor ? 'good' : 'neutral' };
    case 'tag-denied': return { text: selfIsActor ? t('mode.ev.tagDenied') : '', cue: selfIsActor ? 'good' : 'neutral' };
    // Search and destroy: `team` is the attackers for plant/explosion, the defenders for a defuse; `text` the site.
    case 'bomb-planted': return { text: t('mode.ev.bombPlanted', text), cue: 'alarm' };
    case 'bomb-defused': return { text: t('mode.ev.bombDefused'), cue: ours ? 'good' : 'bad' };
    case 'bomb-exploded': return { text: t('mode.ev.bombExploded'), cue: ours ? 'good' : 'bad' };
    case 'side-swap': return { text: team === self ? t('mode.ev.swapAttack') : t('mode.ev.swapDefend'), cue: 'neutral' };
    // Infected: `who` is the player who turned or is the last one standing.
    case 'outbreak': return { text: selfIsActor ? t('mode.ev.outbreakYou') : t('mode.ev.outbreak', who), cue: 'alarm' };
    case 'infected': return { text: selfIsActor ? t('mode.ev.infectedYou') : t('mode.ev.infected', who), cue: selfIsActor ? 'bad' : 'neutral' };
    case 'last-survivor': return { text: selfIsActor ? t('mode.ev.lastYou') : t('mode.ev.last', who), cue: selfIsActor ? 'alarm' : 'good' };
    // Sharpshooter: the server sends the weapon id.
    case 'weapon-rotate': return { text: t('mode.ev.weaponRotate', weaponDef(text)?.name ?? text), cue: 'neutral' };
    default: return { text: localizeServerText(text), cue: 'neutral' };
  }
}

/** The big line in the middle of the screen for the non-live phases of a round mode. */
export function phaseBanner(phase: MatchPhase, seconds: number, round: number): string {
  const n = Math.max(0, Math.ceil(seconds));
  switch (phase) {
    case 'intermission': return t('mode.roundStarts', round, n);
    case 'countdown': return n > 0 ? String(n) : t('mode.fight');
    default: return '';
  }
}

/**
 * The server builds a few English texts itself (the line under the timer in `match.text`, some
 * `event.text`s; see server/modes/*.ts). The protocol stays English: this recognises those known
 * patterns and returns them in the current language. Anything else (map zone names, weapon ids,
 * texts of a newer server) passes through unchanged.
 */
const SERVER_TEXTS: readonly [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^First to (\d+)$/, (m) => t('arc.firstTo', m[1])],
  [/^First to (\d+) captures$/, (m) => t('mode.srv.captures', m[1])],
  [/^First to (\d+) capture$/, (m) => t('mode.srv.capture', m[1])],
  [/^First to (\d+) points$/, (m) => t('mode.srv.points', m[1])],
  [/^Hill: (.+) · first to (\d+)$/, (m) => t('mode.srv.hill', m[1], m[2])],
  [/^Round (\d+) · first to (\d+)$/, (m) => t('mode.srv.roundFirstTo', m[1], m[2])],
  [/^Round (\d+)$/, (m) => t('mode.srv.round', m[1])],
  [/^(\d+) weapons, the knife is last$/, (m) => t('mode.srv.ladder', m[1])],
  [/^(\S+) knifed (\S+)$/, (m) => t('mode.srv.knifed', m[1], m[2])],
  [/^First to (\d+) confirms$/, (m) => t('mode.srv.confirms', m[1])],
  [/^(\d+) survivors? left$/, (m) => t('mode.srv.survivors', m[1])],
  [/^Survive until the end$/, () => t('mode.srv.survive')],
];

export function localizeServerText(text: string): string {
  if (!text) return text;
  for (const [re, fn] of SERVER_TEXTS) {
    const m = text.match(re);
    if (m) return fn(m);
  }
  return text;
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
