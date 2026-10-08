import type { GameType } from '../modes/GameTypes';
import { currentState, periodKey, resolveChallenges } from '../modes/progression/Challenges';
import { levelFromXp } from '../modes/progression/Levels';
import type { PartyView } from '../modes/Party';
import { type ProfileData, rankOf } from '../modes/progression/Profile';
import { type ModeStats, REALMS_MODES } from '../modes/Realms';
import { type RejoinOffer, formatLeft } from '../net/Rejoin';
import { formatCode } from '../net/protocol';
import { emblemSvg, svgDataUrl, wordmarkSvg } from './Brand';
import { h } from './dom';
import { type I18nKey, t } from './i18n';
import { challengeText } from './ProgressText';
import { PartyPanel, type PartyUi } from './PartyPanel';
import { cardBackground, rankBadge } from './RankBadge';
import { realmsIcon } from './RealmsIcons';
import { type ShellIcon, iconEl } from './shellIcons';
import './shell.css';

/** What the home screen's controls do (the flows live in RealmsMenu and MainMenu). */
export interface HomeHost {
  /** Quick play in a mode (asks for a name first when there is none). */
  play(mode: GameType): void;
  /** A mode card was picked: remember it as the mode PLAY starts. */
  selectMode(mode: GameType): void;
  lobbies(): void;
  privateMatch(mode: GameType): void;
  /** Join with a typed code or invite link; errors come back through `setStatus`. */
  joinCode(raw: string): void;
  /** The profile card: the profile screen, or the name prompt for a guest. */
  profile(): void;
  loadouts(): void;
  armory(): void;
  stats(): void;
  challenges(): void;
  settings(): void;
  language(): void;
  /** Build & Survival (beta): the voxel sandbox. */
  survival(): void;
  /** The "Rejoin your match" button: back into the lobby whose seat the server keeps. */
  rejoin(offer: RejoinOffer): void;
  /** The party panel's buttons. */
  party: PartyUi;
}

export type ServerState = 'connecting' | 'online' | 'offline';

function modeName(mode: GameType): string {
  return t(`realms.mode.${mode}` as I18nKey);
}

function iconButton(icon: ShellIcon, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `bc-btn ${cls}`, type: 'button', onclick: onClick }, iconEl(icon), h('span', { text: label }));
  return b;
}

/**
 * The front door: the arena shooter. A big PLAY (quick play in the player's favourite mode), the mode playlist
 * with live player counts, lobbies, private matches and joining friends by code, the profile card with the level
 * bar, the daily challenges, loadouts and armory, settings and language, and a small Build & Survival entry.
 * Drawn over the live flythrough of an arena map. DOM is built once; the setters only update what changed.
 */
export class HomeScreen {
  readonly el: HTMLDivElement;
  private mode: GameType;
  private readonly playBtn: HTMLButtonElement;
  private readonly playMode: HTMLSpanElement;
  private readonly playLabel: HTMLSpanElement;
  readonly partyPanel: PartyPanel;
  private partyView: PartyView | null = null;
  private readonly playSub: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly cards = new Map<GameType, { el: HTMLButtonElement; count: HTMLSpanElement }>();
  private readonly profileEl: HTMLButtonElement;
  private readonly challengesEl: HTMLElement;
  private readonly onlineEls: HTMLElement[] = [];
  private readonly codeInput: HTMLInputElement;
  /** "12 modes · 9 online" in the playlist header. */
  private readonly playlistMeta: HTMLSpanElement;
  private stats: ModeStats[] = [];
  private server: ServerState = 'connecting';
  /** "Rejoin your match": the seat the server keeps for this browser (hidden when there is none). */
  private readonly rejoinEl: HTMLElement;
  private rejoinTimer = 0;

  constructor(private readonly host: HomeHost, opts: { mode: GameType; version: string; mapName: string }) {
    this.mode = REALMS_MODES.includes(opts.mode) ? opts.mode : REALMS_MODES[0];
    const wm = wordmarkSvg({ cell: 10 });
    const brand = h('div', { class: 'home-brand' },
      h('img', { class: 'home-emblem', src: svgDataUrl(emblemSvg()), alt: '', draggable: false }),
      h('div', { class: 'home-brand-text' },
        h('h1', { class: 'home-wordmark' }, h('img', { src: svgDataUrl(wm.svg), alt: 'BunkCraft', draggable: false })),
        h('div', { class: 'home-tagline', text: t('home.tagline') })),
    );

    // PLAY: the first focusable control (keyboard and controller land here).
    this.playMode = h('span', { class: 'bc-play-mode' });
    this.playSub = h('span', { class: 'bc-play-sub' });
    this.playLabel = h('span', { text: t('home.play') });
    this.playBtn = h('button', { class: 'bc-play', type: 'button', onclick: () => this.host.play(this.mode) },
      h('span', { class: 'bc-play-label' }, iconEl('play'), this.playLabel),
      this.playMode, this.playSub);
    this.partyPanel = new PartyPanel(host.party);
    this.partyPanel.setAvailable(false);
    this.status = h('div', { class: 'home-status', role: 'status', 'aria-live': 'polite' });
    this.rejoinEl = h('section', { class: 'bc-panel home-rejoin', 'aria-label': t('rejoin.title'), hidden: true });

    const lobbies = iconButton('list', t('home.lobbies'), () => this.host.lobbies());
    const priv = iconButton('lock', t('home.private'), () => this.host.privateMatch(this.mode));
    this.onlineEls.push(lobbies, priv);

    this.codeInput = h('input', { class: 'bc-input', type: 'text', maxLength: 80, placeholder: t('home.code'), 'aria-label': t('home.code'), spellcheck: false, autocomplete: 'off' });
    const join = h('button', { class: 'bc-btn primary-ghost', type: 'button', onclick: () => this.join() }, h('span', { text: t('home.join') }));
    this.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    this.onlineEls.push(this.codeInput, join);
    const friends = h('section', { class: 'bc-panel home-friends', 'aria-label': t('home.friends') },
      h('div', { class: 'bc-eyebrow' }, iconEl('users'), h('span', { text: t('home.friends') })),
      h('div', { class: 'home-code-row' }, this.codeInput, join));

    const nav = h('nav', { class: 'home-nav', 'aria-label': t('home.loadouts') },
      iconButton('crate', t('home.loadouts'), () => this.host.loadouts(), 'flat'),
      iconButton('target', t('home.armory'), () => this.host.armory(), 'flat'),
      iconButton('chart', t('home.stats'), () => this.host.stats(), 'flat'),
    );

    const main = h('main', { class: 'home-main' },
      this.rejoinEl,
      this.playBtn,
      h('div', { class: 'home-row' }, lobbies, priv),
      this.partyPanel.el,
      friends,
      nav,
      this.status,
    );

    // The playlist: one card per mode, the selected one is what PLAY starts.
    const grid = h('div', { class: 'home-modes', role: 'group', 'aria-label': t('home.playlistLabel') });
    for (const mode of REALMS_MODES) {
      const count = h('span', { class: 'mode-count' });
      const el = h('button', { class: 'mode-card', type: 'button', 'data-mode': mode, 'aria-pressed': 'false' },
        h('img', { class: 'mode-icon', src: realmsIcon(mode), alt: '', draggable: false }),
        h('span', { class: 'mode-text' }, h('span', { class: 'mode-name', text: modeName(mode) }), count));
      el.title = t(`realms.desc.${mode}` as I18nKey);
      el.addEventListener('click', () => {
        // In a party the leader picks the mode.
        if (this.partyRole() === 'member') return;
        // A second press on the selected mode plays it (Enter twice from the keyboard, a double click).
        if (this.mode === mode && el.dataset.armed === '1') { this.host.play(mode); return; }
        this.select(mode);
        el.dataset.armed = '1';
        window.setTimeout(() => { delete el.dataset.armed; }, 600);
      });
      el.addEventListener('dblclick', () => { if (this.partyRole() !== 'member') this.host.play(mode); });
      this.cards.set(mode, { el, count });
      grid.append(el);
    }
    this.playlistMeta = h('span', { class: 'bc-dim', text: t('home.modes', REALMS_MODES.length) });
    const playlist = h('section', { class: 'bc-panel home-playlist', 'aria-label': t('home.playlist') },
      h('div', { class: 'bc-panel-head' }, h('h2', { class: 'bc-h2', text: t('home.playlist') }), this.playlistMeta),
      grid);

    this.challengesEl = h('section', { class: 'bc-panel home-challenges', 'aria-label': t('home.challenges') });
    this.challengesEl.addEventListener('click', () => this.host.challenges());

    this.profileEl = h('button', { class: 'home-profile', type: 'button', onclick: () => this.host.profile() });
    const util = h('div', { class: 'home-util' },
      this.profileEl,
      h('div', { class: 'home-util-row' },
        iconButton('globe', t('home.language'), () => this.host.language(), 'flat icon-only'),
        iconButton('gear', t('home.settings'), () => this.host.settings(), 'flat icon-only'),
      ),
    );
    for (const b of util.querySelectorAll<HTMLButtonElement>('.icon-only')) b.setAttribute('aria-label', b.textContent ?? '');

    const build = h('button', { class: 'home-build', type: 'button', onclick: () => this.host.survival() },
      iconEl('cube'),
      h('span', { class: 'home-build-text' },
        h('span', { class: 'home-build-title' }, t('home.build'), h('em', { text: t('home.beta') })),
        h('span', { class: 'home-build-hint', text: t('home.buildHint') })),
      iconEl('chevron'));

    const foot = h('footer', { class: 'home-foot' },
      build,
      h('div', { class: 'home-foot-meta' },
        h('span', { text: t('home.map', opts.mapName) }),
        h('span', { text: opts.version }),
        h('span', { text: t('title.disclaimer') })));

    this.el = h('div', { class: 'screen bc home' },
      h('div', { class: 'home-scrim', 'aria-hidden': 'true' }),
      brand,
      main,
      h('div', { class: 'home-side' }, playlist, this.challengesEl, util),
      foot,
    );
    this.el.setAttribute('aria-label', 'BunkCraft');
    this.select(this.mode, false);
    this.setProfile(null, null, false);
    this.setServer('connecting');
  }

  get selectedMode(): GameType {
    return this.mode;
  }

  private join(): void {
    this.host.joinCode(this.codeInput.value);
  }

  private select(mode: GameType, notify = true): void {
    this.mode = mode;
    for (const [m, c] of this.cards) {
      c.el.classList.toggle('selected', m === mode);
      c.el.setAttribute('aria-pressed', String(m === mode));
    }
    this.playMode.textContent = modeName(mode);
    this.renderPlaySub();
    if (notify) this.host.selectMode(mode);
  }

  /** What the party makes of the big button: the leader plays for everybody, the others toggle READY. */
  private partyRole(): 'none' | 'leader' | 'member' {
    const v = this.partyView;
    return !v ? 'none' : v.me === v.leader ? 'leader' : 'member';
  }

  /** The party changed (null = no party): the party panel, the PLAY button, and the playlist that follows the leader. */
  setParty(view: PartyView | null): void {
    this.partyView = view;
    this.partyPanel.setView(view);
    const role = this.partyRole();
    const me = view?.members.find((m) => m.id === view.me);
    const on = role === 'member' && !!me?.ready;
    this.playBtn.classList.toggle('member', role === 'member');
    this.playBtn.classList.toggle('on', on);
    if (role === 'member') this.playBtn.setAttribute('aria-pressed', String(on)); else this.playBtn.removeAttribute('aria-pressed');
    this.playLabel.textContent = role === 'member' ? (on ? t('party.readyOn') : t('party.readyUp')) : t('home.play');
    if (role === 'member' && view && view.mode !== this.mode && REALMS_MODES.includes(view.mode)) this.select(view.mode, false);
    for (const c of this.cards.values()) {
      c.el.classList.toggle('party-locked', role === 'member');
      c.el.setAttribute('aria-disabled', String(role === 'member'));
    }
    this.renderPlaySub();
  }

  private renderPlaySub(): void {
    const role = this.partyRole();
    if (role === 'member') { this.playSub.textContent = this.partyView!.members.find((m) => m.id === this.partyView!.me)?.ready ? t('party.readyCancel') : t('party.readyHint'); return; }
    if (this.server === 'connecting') { this.playSub.textContent = t('home.connecting'); return; }
    if (role === 'leader') { this.playSub.textContent = t('party.leaderSub', this.partyView!.members.length); return; }
    if (this.server === 'offline') { this.playSub.textContent = t('home.quickPlay'); return; }
    const s = this.stats.find((x) => x.gameType === this.mode);
    this.playSub.textContent = `${t('home.quickPlay')} · ${s && s.players > 0 ? t('home.online', s.players) : t('home.nobody')}`;
  }

  setServer(state: ServerState): void {
    this.server = state;
    const off = state !== 'online';
    this.playBtn.disabled = off;
    if (off) this.partyPanel.setAvailable(false);
    for (const el of this.onlineEls) (el as HTMLButtonElement | HTMLInputElement).disabled = off;
    for (const c of this.cards.values()) c.el.classList.toggle('offline', state === 'offline');
    this.el.classList.toggle('offline', state === 'offline');
    if (state === 'offline') this.setStatus(t('realms.offline'), true);
    this.renderPlaySub();
  }

  /** Live player counts per mode. */
  setStats(stats: ModeStats[]): void {
    this.stats = stats;
    for (const [mode, c] of this.cards) {
      const s = stats.find((x) => x.gameType === mode);
      const n = s?.players ?? 0;
      c.count.textContent = n > 0 ? t('home.online', n) : '';
      c.el.classList.toggle('busy', n > 0);
    }
    const total = stats.reduce((sum, s) => sum + s.players, 0);
    this.playlistMeta.textContent = total > 0 ? `${t('home.modes', REALMS_MODES.length)} · ${t('home.online', total)}` : t('home.modes', REALMS_MODES.length);
    this.renderPlaySub();
  }

  /**
   * The offer to get back into the match this browser was dropped from (the server still keeps the seat), with the
   * time left counting down; `null` hides it. The offer goes away by itself when the time is up.
   */
  setRejoin(offer: RejoinOffer | null): void {
    window.clearInterval(this.rejoinTimer);
    const el = this.rejoinEl;
    el.hidden = !offer;
    if (!offer) { el.replaceChildren(); return; }
    const end = Date.now() + offer.secondsLeft * 1000;
    const sub = h('div', { class: 'home-rejoin-sub' });
    const render = () => { sub.textContent = t('rejoin.sub', modeName(offer.gameType), formatCode(offer.ticket.code), formatLeft((end - Date.now()) / 1000)); };
    render();
    const button = h('button', { class: 'bc-btn primary-ghost', type: 'button', onclick: () => this.host.rejoin(offer) }, iconEl('play'), h('span', { text: t('rejoin.button') }));
    el.replaceChildren(
      h('div', { class: 'bc-eyebrow' }, iconEl('users'), h('span', { text: t('rejoin.title') })),
      h('div', { class: 'home-rejoin-row' }, sub, button));
    this.rejoinTimer = window.setInterval(() => {
      if (Date.now() >= end || !el.isConnected) {
        window.clearInterval(this.rejoinTimer);
        if (Date.now() >= end) { el.hidden = true; el.replaceChildren(); this.setStatus(t('rejoin.expired')); }
        return;
      }
      render();
    }, 1000);
  }

  setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  /** The profile card (and the daily challenges under the playlist). `name` null = guest without a name. */
  setProfile(p: ProfileData | null, name: string | null, profilesOn: boolean): void {
    const el = this.profileEl;
    el.style.background = '';
    if (!name) {
      el.replaceChildren(
        h('span', { class: 'home-avatar' }, iconEl('user')),
        h('span', { class: 'home-profile-text' },
          h('span', { class: 'home-profile-name', text: t('home.chooseName') }),
          h('span', { class: 'home-profile-sub', text: t('home.guestHint') })));
    } else if (!p) {
      el.replaceChildren(
        h('span', { class: 'home-avatar' }, iconEl('user')),
        h('span', { class: 'home-profile-text' },
          h('span', { class: 'home-profile-name', text: name }),
          h('span', { class: 'home-profile-sub', text: profilesOn ? t('home.connecting') : t('home.noProgress') })));
    } else {
      const r = rankOf(p);
      const lv = levelFromXp(p.xp);
      const fill = lv.need > 0 ? Math.round((lv.into / lv.need) * 100) : 100;
      el.style.background = `linear-gradient(90deg, rgba(7, 9, 13, 0.55), rgba(7, 9, 13, 0.82)), ${cardBackground(p.equip.card)}`;
      el.replaceChildren(
        rankBadge(r, true)!,
        h('span', { class: 'home-profile-text' },
          h('span', { class: 'home-profile-top' },
            h('span', { class: 'home-profile-name', text: p.name }),
            h('span', { class: 'home-profile-level', text: `${r.prestige > 0 ? `P${r.prestige} · ` : ''}${t('prog.level', r.level)}` })),
          h('span', { class: 'home-profile-sub', text: t(`ptitle.${p.equip.title}` as I18nKey) }),
          h('span', { class: `bc-bar${lv.need === 0 ? ' max' : ''}` }, h('i', { style: `width:${fill}%` })),
          h('span', { class: 'home-profile-xp', text: lv.need > 0 ? t('prog.xp', lv.into, lv.need) : t('prog.maxed') })));
    }
    el.setAttribute('aria-label', name ? `${name}${p ? `, ${t('prog.level', rankOf(p).level)}` : ''}` : t('home.chooseName'));
    this.renderChallenges(p);
  }

  private renderChallenges(p: ProfileData | null): void {
    const head = h('div', { class: 'bc-panel-head' },
      h('h2', { class: 'bc-h2', text: `${t('home.challenges')} · ${t('chal.daily')}` }),
      h('button', { class: 'bc-link', type: 'button', text: t('home.allChallenges'), onclick: (e: Event) => { e.stopPropagation(); this.host.challenges(); } }));
    if (!p) {
      this.challengesEl.classList.add('empty');
      this.challengesEl.replaceChildren(head, h('div', { class: 'bc-dim', text: t('home.guestHint') }));
      return;
    }
    this.challengesEl.classList.remove('empty');
    const key = periodKey('daily', Date.now());
    const state = currentState(p.daily, key);
    const rows = resolveChallenges('daily', state, key, rankOf(p)).map((c, i) => {
      const have = Math.min(c.target, state.progress[i] ?? 0);
      const done = have >= c.target;
      return h('div', { class: `home-chal${done ? ' done' : ''}`, 'data-challenge': c.id },
        h('span', { class: 'home-chal-text', text: challengeText(c) }),
        h('span', { class: 'home-chal-count', text: done ? t('chal.done') : `${have}/${c.target}` }),
        h('span', { class: 'bc-bar thin' }, h('i', { style: `width:${Math.round((have / c.target) * 100)}%` })));
    });
    this.challengesEl.replaceChildren(head, ...rows);
  }
}
