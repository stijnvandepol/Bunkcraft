import { camoDef } from '../modes/progression/Camos';
import { levelFromXp } from '../modes/progression/Levels';
import type { ProgressReport } from '../modes/progression/Profile';
import { weaponDef } from '../modes/Weapons';
import { h } from './dom';
import { type I18nKey, t } from './i18n';
import { camoName, challengeById, challengeText, unlockLabel } from './ProgressText';
import { rankBadge } from './RankBadge';

/**
 * The XP report on the match-end screen (Realms): each line of the breakdown, the total, the level bar filling
 * from the old to the new XP, and a level-up banner with what it unlocked, new camos and completed challenges.
 * Shown once per `progress` message; hidden again when the next match starts.
 */
export class ProgressPanel {
  readonly el: HTMLDivElement;

  constructor() {
    this.el = h('div', { class: 'xp-report hidden' });
  }

  show(r: ProgressReport): void {
    const before = levelFromXp(r.before.xp), after = levelFromXp(r.after.xp);
    const pct = (l: { into: number; need: number }) => (l.need > 0 ? Math.round((l.into / l.need) * 100) : 100);
    const fill = h('i', { style: `width:${after.level > before.level || r.after.prestige !== r.before.prestige ? 0 : pct(before)}%` });
    const lineText = (key: string): string => {
      if (key.startsWith('challenge.')) {
        const c = challengeById(key.slice('challenge.'.length));
        return `${t('xp.line.challenge')}: ${c ? challengeText(c) : ''}`;
      }
      return t(`xp.line.${key}` as I18nKey, key);
    };
    const notes: HTMLElement[] = [];
    if (after.level > before.level) notes.push(h('div', { class: 'xr-levelup', text: t('xp.levelUp', after.level) }));
    for (const u of r.unlocks) notes.push(h('div', { class: 'xr-note', text: t('xp.unlocked', unlockLabel(u)) }));
    for (const c of r.camos) {
      if (camoDef(c.camo)) notes.push(h('div', { class: 'xr-note', text: t('xp.newCamo', camoName(c.camo), weaponDef(c.weapon)?.name ?? c.weapon) }));
    }
    this.el.replaceChildren(
      h('div', { class: 'xr-head' },
        h('span', { text: t('xp.title') }),
        h('span', {}, rankBadge({ level: after.level, prestige: r.after.prestige }), t('prog.level', after.level))),
      h('div', { class: 'xr-lines' },
        ...r.lines.map((l) => h('div', { class: 'xr-line' },
          h('span', { text: l.count !== undefined && l.count > 0 ? `${lineText(l.key)} x${l.count}` : lineText(l.key) }),
          h('b', { text: `${l.xp >= 0 ? '+' : ''}${l.xp}` }))),
        h('div', { class: 'xr-line total' }, h('span', { text: t('xp.total') }), h('b', { text: `+${r.xp}` })),
      ),
      h('div', { class: `xp-bar${after.need === 0 ? ' max' : ''}` }, fill),
      ...notes,
    );
    this.el.classList.remove('hidden');
    // Let the bar animate from where it was to where it is now.
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pct(after)}%`; }));
  }

  hide(): void {
    this.el.classList.add('hidden');
  }
}
