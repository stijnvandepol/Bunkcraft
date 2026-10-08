import { type PartyMemberView, type PartyView, partyLink } from '../modes/Party';
import { parseRank } from '../modes/progression/Levels';
import { h } from './dom';
import { t } from './i18n';
import { rankBadge } from './RankBadge';
import { iconEl } from './shellIcons';

/** What the panel's buttons do (the flows live in RealmsMenu and src/net/PartyApi.ts). */
export interface PartyUi {
  create(): void;
  /** A typed party code or invite link. */
  join(raw: string): void;
  leave(): void;
  kick(memberId: string): void;
  promote(memberId: string): void;
}

/**
 * The party on the home screen. Without a party: create one, or join one with a code. In a party: the code (and a
 * link to copy), the members with their level icon, a crown on the leader, their ready state, and for the leader a
 * button per member to hand over the crown or remove them. The list is real buttons in the natural tab order (the
 * menu's arrow-key navigation moves between them), a polite live region says who joined or left, and the DOM is only
 * rebuilt when something changed, so a poll every second does not steal focus.
 */
export class PartyPanel {
  readonly el: HTMLElement;
  private view: PartyView | null = null;
  private available = false;
  private busy = false;
  private signature = '';
  private readonly body: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private readonly codeInput: HTMLInputElement;
  private readonly note: HTMLDivElement;
  private noteTimer = 0;

  constructor(private readonly host: PartyUi) {
    this.codeInput = h('input', {
      class: 'bc-input party-input', type: 'text', maxLength: 80, placeholder: t('party.code'), 'aria-label': t('party.code'), spellcheck: false, autocomplete: 'off',
    });
    this.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submit(); });
    this.body = h('div', { class: 'party-body' });
    this.live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.note = h('div', { class: 'party-note', role: 'status', 'aria-live': 'polite' });
    this.el = h('section', { class: 'bc-panel home-party', 'aria-label': t('party.title'), 'data-party': 'off' }, this.body, this.note, this.live);
    this.render();
  }

  /** Whether the server has parties at all (otherwise the panel stays hidden). */
  setAvailable(on: boolean): void {
    this.available = on;
    this.el.hidden = !on;
    this.render();
  }

  setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.render();
  }

  setView(view: PartyView | null): void {
    this.view = view;
    this.render();
  }

  /** Words for screen readers (and the line under the panel): who joined, who left. */
  announce(text: string): void {
    this.live.textContent = '';
    window.setTimeout(() => { this.live.textContent = text; }, 30);
    this.say(text);
  }

  /** A short line under the panel; goes away by itself. */
  say(text: string, error = false): void {
    this.note.textContent = text;
    this.note.classList.toggle('error', error);
    window.clearTimeout(this.noteTimer);
    if (text) this.noteTimer = window.setTimeout(() => { this.note.textContent = ''; }, 6000);
  }

  focusCode(): void {
    this.codeInput.focus();
  }

  private submit(): void {
    const v = this.codeInput.value.trim();
    if (!v) { this.codeInput.focus(); return; }
    this.host.join(v);
  }

  private render(): void {
    const v = this.view;
    const sig = JSON.stringify([this.available, this.busy, v ? { ...v, ticket: undefined } : null]);
    if (sig === this.signature) return;
    this.signature = sig;
    this.el.dataset.party = v ? 'on' : 'off';
    // Keep the focus on the same control across a rebuild.
    const active = document.activeElement as HTMLElement | null;
    const key = active && this.body.contains(active) ? active.dataset.key : undefined;
    const typed = this.codeInput.value;
    this.body.replaceChildren(...(v ? this.inParty(v) : this.noParty()));
    if (!v) this.codeInput.value = typed;
    if (key) (this.body.querySelector(`[data-key="${key}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private noParty(): Node[] {
    const create = h('button', { class: 'bc-btn primary-ghost', type: 'button', 'data-key': 'create', onclick: () => this.host.create() },
      iconEl('plus'), h('span', { text: t('party.create') }));
    const join = h('button', { class: 'bc-btn', type: 'button', 'data-key': 'join', onclick: () => this.submit() }, h('span', { text: t('party.join') }));
    create.disabled = join.disabled = this.codeInput.disabled = this.busy;
    return [
      h('div', { class: 'bc-eyebrow' }, iconEl('users'), h('span', { text: t('party.title') })),
      h('div', { class: 'party-hint', text: t('party.hint') }),
      h('div', { class: 'home-code-row' }, create),
      h('div', { class: 'home-code-row' }, this.codeInput, join),
    ];
  }

  private inParty(v: PartyView): Node[] {
    const me = v.me === v.leader;
    const copy = h('button', { class: 'bc-btn flat', type: 'button', 'data-key': 'copy', onclick: () => void this.copyLink(v.code) },
      iconEl('link'), h('span', { text: t('party.copy') }));
    const leave = h('button', { class: 'bc-btn flat', type: 'button', 'data-key': 'leave', onclick: () => this.host.leave() }, h('span', { text: t('party.leave') }));
    const list = h('ul', { class: 'party-list', 'aria-label': t('party.members') }, ...v.members.map((m) => this.member(v, m, me)));
    const here = v.members.filter((m) => m.online && m.status === 'menu');
    const ready = here.filter((m) => m.ready).length;
    const foot = me
      ? (ready >= here.length ? t('party.allReady') : t('party.readyCount', ready, here.length))
      : t('party.waiting');
    return [
      h('div', { class: 'bc-eyebrow' }, iconEl('users'), h('span', { text: t('party.title') }),
        h('span', { class: 'party-count', text: t('party.count', v.members.length, v.max) })),
      h('div', { class: 'party-head' },
        h('span', { class: 'party-code', 'aria-label': `${t('party.code')} ${v.code.split('').join(' ')}`, text: v.code }),
        h('span', { class: 'party-head-actions' }, copy, leave)),
      list,
      h('div', { class: `party-foot${me && ready >= here.length ? ' all' : ''}`, text: foot }),
    ];
  }

  private member(v: PartyView, m: PartyMemberView, iAmLeader: boolean): HTMLElement {
    const you = m.id === v.me;
    const rank = parseRank(m.rank);
    const badge = rank ? rankBadge(rank) : null;
    const state = !m.online ? 'offline' : m.status === 'game' ? 'game' : m.ready ? 'ready' : 'idle';
    const chip = m.leader && state !== 'offline' && state !== 'game' ? null : h('span', { class: `party-chip ${state}`, text: stateText(state) });
    const actions = iAmLeader && !you
      ? h('span', { class: 'party-actions' },
        h('button', {
          class: 'bc-btn flat icon-only', type: 'button', 'data-key': `lead-${m.id}`, title: t('party.makeLeader', m.name),
          'aria-label': t('party.makeLeader', m.name), onclick: () => this.host.promote(m.id),
        }, iconEl('crown'), h('span', { text: t('party.makeLeader', m.name) })),
        h('button', {
          class: 'bc-btn flat icon-only danger', type: 'button', 'data-key': `kick-${m.id}`, title: t('party.kick', m.name),
          'aria-label': t('party.kick', m.name), onclick: () => this.host.kick(m.id),
        }, iconEl('close'), h('span', { text: t('party.kick', m.name) })))
      : null;
    return h('li', { class: `party-member${m.leader ? ' leader' : ''}${you ? ' you' : ''}${m.online ? '' : ' away'}`, 'data-member': m.id },
      badge ?? h('span', { class: 'party-guest', 'aria-hidden': 'true' }),
      rank ? h('span', { class: 'sr-only', text: t('prog.level', rank.level) }) : null,
      h('span', { class: 'party-name', text: m.name }),
      you ? h('span', { class: 'party-you', text: `(${t('party.you')})` }) : null,
      m.leader ? h('span', { class: 'party-crown', title: t('party.leader'), role: 'img', 'aria-label': t('party.leader') }, iconEl('crown')) : null,
      chip,
      actions);
  }

  private async copyLink(code: string): Promise<void> {
    const link = partyLink(location.origin, code);
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      // No clipboard permission: select the link in a temporary field and copy by hand.
      const tmp = h('textarea', { value: link, readOnly: true, style: 'position:fixed;opacity:0;' });
      document.body.append(tmp);
      tmp.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      tmp.remove();
    }
    this.say(ok ? t('party.copied') : link);
  }
}

function stateText(state: 'offline' | 'game' | 'ready' | 'idle'): string {
  return state === 'offline' ? t('party.offline') : state === 'game' ? t('party.inMatch') : state === 'ready' ? t('party.ready') : t('party.notReady');
}
