import type { GameTypeDef, Team } from '../modes/GameTypes';
import { getMap } from '../modes/maps';
import type { MatchPhase, RosterEntry, ServerMessage } from '../net/protocol';
import { h } from './dom';
import { t } from './i18n';
import { realmsModeName } from './RealmsMenu';
import { rankBadge } from './RankBadge';
import './realms.css';

type VoteMsg = Extract<ServerMessage, { t: 'vote' }>;

/** Players a match needs before the warm-up counts down (the server's ModeLogic.canStart). */
export function lobbyWaiting(def: GameTypeDef, roster: readonly RosterEntry[]): boolean {
  if (def.rounds) return !roster.some((p) => p.team === 'red') || !roster.some((p) => p.team === 'blue');
  return roster.length < 2;
}

/**
 * The pre-match lobby of a Realms match, drawn over the arena: during the warm-up (and between rounds) a
 * panel with the mode, the map, the countdown and the players per team; after a match, a vote between three
 * maps under the result (server-authoritative: the client only shows the counts and sends its choice).
 * DOM is rebuilt only when something it shows changed.
 */
export class MatchLobby {
  readonly el: HTMLDivElement;
  readonly voteEl: HTMLDivElement;
  /** Sends a vote (an index into the offered maps). */
  onVote: ((choice: number) => void) | null = null;
  private readonly status: HTMLDivElement;
  private readonly mapLine: HTMLDivElement;
  private readonly teams: HTMLDivElement;
  private readonly voteCards: HTMLDivElement;
  private readonly voteMine: HTMLDivElement;
  private readonly modeLine: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly voteTitle: HTMLDivElement;
  private readonly voteHint: HTMLDivElement;
  private vote: VoteMsg | null = null;
  private lastKey = '';
  private lastRoster: readonly RosterEntry[] | null = null;

  constructor(private readonly def: GameTypeDef, private readonly selfId: number) {
    this.status = h('div', { class: 'mlobby-status' });
    this.mapLine = h('div', { class: 'mlobby-map' });
    this.teams = h('div', { class: `mlobby-teams${def.teams ? ' two' : ''}` });
    this.modeLine = h('div', { class: 'mlobby-mode' });
    this.hint = h('div', { class: 'mlobby-hint' });
    this.el = h('div', { class: 'mlobby hidden' }, this.modeLine, this.mapLine, this.status, this.teams, this.hint);
    this.voteCards = h('div', { class: 'mvote-cards' });
    this.voteMine = h('div', { class: 'mvote-mine' });
    this.voteTitle = h('div', { class: 'mvote-title' });
    this.voteHint = h('div', { class: 'mvote-hint' });
    this.voteEl = h('div', { class: 'mvote hidden' }, this.voteTitle, this.voteCards, this.voteMine, this.voteHint);
    this.relabel();
  }

  /** Writes the fixed texts in the current language (again after a language change). */
  relabel(): void {
    this.modeLine.textContent = realmsModeName(this.def.id);
    this.hint.textContent = t('lobby.tab');
    this.voteTitle.textContent = t('lobby.vote');
    this.voteHint.textContent = t('lobby.voteKeys', '1, 2, 3');
    this.lastKey = '';
    if (this.vote) this.setVote(this.vote);
  }

  /** The server's vote state (empty options = no vote). */
  setVote(msg: VoteMsg): void {
    this.vote = msg.options.length > 0 ? msg : null;
    this.renderVote();
  }

  /** A vote key (0-based) was pressed between matches. */
  pick(choice: number): void {
    const v = this.vote;
    if (!v || choice < 0 || choice >= v.options.length || v.mine === choice) return;
    this.onVote?.(choice);
  }

  /** The big warm-up line under the timer: waiting for a second player, or the countdown. */
  banner(roster: readonly RosterEntry[], seconds: number): string {
    return lobbyWaiting(this.def, roster) ? t('lobby.waiting', Math.min(roster.length, 2), 2) : t('lobby.starts', Math.max(0, seconds));
  }

  get voting(): boolean {
    return this.vote !== null;
  }

  private renderVote(): void {
    const v = this.vote;
    this.voteEl.classList.toggle('hidden', !v);
    if (!v) return;
    const total = v.counts.reduce((a, b) => a + b, 0);
    const top = Math.max(0, ...v.counts);
    this.voteCards.replaceChildren(...v.options.map((id, i) => {
      const n = v.counts[i] ?? 0;
      const card = h('div', { class: `mvote-card${v.mine === i ? ' mine' : ''}${n > 0 && n === top ? ' leading' : ''}` },
        h('div', { class: 'mvote-key', text: `[${i + 1}]` }),
        h('div', { class: 'mvote-name', text: getMap(id).name }),
        h('div', { class: 'mvote-bar' }, h('i', { style: `width:${total ? Math.round((n / total) * 100) : 0}%` })),
        h('div', { class: 'mvote-count', text: n === 1 ? t('lobby.oneVote') : t('lobby.votes', n) }),
      );
      card.addEventListener('click', () => this.pick(i));
      return card;
    }));
    this.voteMine.textContent = v.mine !== undefined ? `${t('lobby.voted')}: ${getMap(v.options[v.mine]).name}` : '';
  }

  /**
   * Per frame (cheap): shows the panel in the warm-up and between rounds, hides it otherwise. `seconds` is the
   * time left in the phase; `map` the map being played.
   */
  update(phase: MatchPhase, seconds: number, roster: readonly RosterEntry[], map: string | undefined, ended: boolean): void {
    const show = !ended && (phase === 'warmup' || phase === 'intermission');
    if (!show) {
      if (this.lastKey !== '') { this.lastKey = ''; this.el.classList.add('hidden'); }
      if (!ended && this.vote) { this.vote = null; this.renderVote(); }
      return;
    }
    const waiting = phase === 'warmup' && lobbyWaiting(this.def, roster);
    const sec = Math.max(0, Math.ceil(seconds));
    const key = `${phase}|${waiting ? -1 : sec}|${map ?? ''}`;
    if (key === this.lastKey && roster === this.lastRoster) return;
    this.lastKey = key;
    this.el.classList.remove('hidden');
    this.mapLine.textContent = getMap(map ?? 'classic').name;
    const need = 2;
    this.status.textContent = waiting ? t('lobby.waiting', Math.min(roster.length, need), need)
      : phase === 'intermission' ? t('lobby.nextRound', sec) : t('lobby.starts', sec);
    if (roster !== this.lastRoster) {
      this.lastRoster = roster;
      this.renderTeams(roster);
    }
  }

  private renderTeams(roster: readonly RosterEntry[]): void {
    const column = (title: string, cls: string, team: Team | null) => {
      const players = roster.filter((p) => team === null || p.team === team);
      return h('div', { class: 'mlobby-team' },
        h('div', { class: `mlobby-team-title ${cls}`, text: `${title} (${players.length})` }),
        ...(players.length ? players.map((p) => h('div', { class: `mlobby-player${p.id === this.selfId ? ' self' : ''}` }, rankBadge(p.rk), p.name))
          : [h('div', { class: 'mlobby-player none', text: t('lobby.empty') })]),
      );
    };
    this.teams.replaceChildren(...(this.def.teams
      ? [column(t('lobby.red'), 'red', 'red'), column(t('lobby.blue'), 'blue', 'blue')]
      : [column(t('lobby.players'), 'all', null)]));
  }

  reset(): void {
    this.vote = null;
    this.lastKey = '';
    this.lastRoster = null;
    this.el.classList.add('hidden');
    this.voteEl.classList.add('hidden');
  }
}
