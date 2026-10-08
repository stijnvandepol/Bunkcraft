import type { Team } from '../modes/GameTypes';
import { skinPrefs } from '../net/SkinPrefs';
import { button, h, menuScreen } from './dom';
import { t } from './i18n';

export interface PlayerRow { id: number; name: string; skin: string; team: Team | '' }

/**
 * Who is here and what they wear: for every player with a custom skin a button to hide that skin (remembered in this
 * browser) and one to report it to the server operator. Opened from the pause menu, where the mouse is free (the
 * Tab scoreboard is held with the pointer locked and cannot be clicked).
 */
export function playersScreen(rows: () => PlayerRow[], report: (id: number) => void, done: () => void): HTMLDivElement {
  const list = h('div', { class: 'prog-panel players-list' });
  const reported = new Set<string>();
  const render = () => {
    const players = rows();
    const lines: HTMLElement[] = [];
    if (!skinPrefs.showCustom) lines.push(h('div', { class: 'hint', text: t('players.off') }));
    for (const p of players) {
      const hidden = p.skin !== '' && skinPrefs.isHidden(p.skin);
      const actions: HTMLElement[] = [];
      if (p.skin) {
        actions.push(button(hidden ? t('players.show') : t('players.hide'), () => { skinPrefs.setHidden(p.skin, !hidden); render(); }, { cls: 'realms-small' }));
        actions.push(button(reported.has(p.skin) ? t('players.reported') : t('players.report'), () => {
          if (reported.has(p.skin)) return;
          reported.add(p.skin);
          report(p.id);
          render();
        }, { cls: 'realms-small', disabled: reported.has(p.skin) }));
      }
      lines.push(h('div', { class: 'prog-row players-row', 'data-player': p.name },
        h('div', { class: 'grow' }, h('span', { text: p.name }), h('span', { class: 'muted', text: p.skin ? t('players.custom') : t('players.default') })),
        h('div', { class: 'row' }, ...actions)));
    }
    if (players.length === 0) lines.push(h('div', { class: 'prog-muted', text: t('players.none') }));
    list.replaceChildren(...lines);
  };
  render();
  return menuScreen(t('players.title'), [list], [button(t('common.back'), done, { cls: 'w150' })], { list: true, cls: 'bc' });
}
