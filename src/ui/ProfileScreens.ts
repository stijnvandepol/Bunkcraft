import { getMap } from '../modes/maps';
import { CAMOS, type CamoDef, camoUnlocked, weaponLevel } from '../modes/progression/Camos';
import { type ChallengePeriod, activeChallenges, currentState, periodEndsIn, periodKey } from '../modes/progression/Challenges';
import { canPrestige, levelFromXp } from '../modes/progression/Levels';
import { type ProfileData, accuracy, favouriteWeapon, kd, rankOf } from '../modes/progression/Profile';
import { CARDS, TITLES, hasUnlock, isUnlocked, unlockLevel } from '../modes/progression/Unlocks';
import { REALMS_MODES } from '../modes/Realms';
import { PRIMARY_WEAPONS, SECONDARY_WEAPONS, weaponDef } from '../modes/Weapons';
import { currentProfile, equip, onProfile, prestige } from '../net/ProfileApi';
import { button, h, menuScreen } from './dom';
import { type I18nKey, t } from './i18n';
import { camoName, challengeText, duration, lockText } from './ProgressText';
import { cardBackground, rankBadge } from './RankBadge';
import { realmsModeName } from './RealmsMenu';
import type { ScreenStack } from './Screens';

/** CSS swatch of a camo: its palette as hard stripes (the real pattern is painted on the 3D model). */
function camoSwatch(c: CamoDef): string {
  if (c.palette.length === 0) return 'linear-gradient(135deg, #3d4147, #2a2d31)';
  const n = c.palette.length;
  const stops = c.palette.map((col, i) => `${col} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(', ');
  return `linear-gradient(135deg, ${stops})`;
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'prog-stat' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', text: value }));
}

/** "4 min ago", or the date for older matches. */
function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  if (min < 1440) return `${Math.round(min / 60)} h`;
  return new Date(at).toLocaleDateString();
}

/**
 * Realms progression screens: the profile banner in the hub header (rank icon, title, level bar), the combat
 * record (stats), daily and weekly challenges, the armory (weapon levels and camos) and the profile screen
 * (title, calling card, prestige). Everything shown comes from the server's profile; nothing here grants XP.
 */
export class ProfileScreens {
  constructor(private readonly stack: ScreenStack) {}

  /** The banner for the Realms header; follows the profile while it is on screen. Click opens the profile. */
  banner(): HTMLElement {
    const el = h('div', { class: 'realms-profile', tabIndex: 0, role: 'button' });
    const render = (p: ProfileData | null) => {
      if (!p) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      const r = rankOf(p);
      const lv = levelFromXp(p.xp);
      const fill = lv.need > 0 ? Math.round((lv.into / lv.need) * 100) : 100;
      el.style.background = cardBackground(p.equip.card);
      el.replaceChildren(
        rankBadge(r, true)!,
        h('div', { class: 'rp-text' },
          h('div', { class: 'rp-top' },
            h('span', { class: 'rp-name' }, `${p.name} `, h('span', { class: 'rp-title', text: t(`ptitle.${p.equip.title}` as I18nKey) })),
            h('span', { class: 'rp-level', text: `${r.prestige > 0 ? `${t('prog.prestige', r.prestige)} - ` : ''}${t('prog.level', r.level)}` }),
          ),
          h('div', { class: `xp-bar${lv.need === 0 ? ' max' : ''}` }, h('i', { style: `width:${fill}%` })),
          h('div', { class: 'rp-xp', text: lv.need > 0 ? t('prog.xp', lv.into, lv.need) : canPrestige(r) ? t('prog.max') : t('prog.maxed') }),
        ),
      );
    };
    const off = onProfile((p) => {
      if (!el.isConnected && el.dataset.shown) { off(); return; }
      render(p);
    });
    // The first render happens before the element is in the page; later ones stop once it is gone.
    el.dataset.shown = '1';
    el.addEventListener('click', () => this.showProfile());
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.showProfile(); });
    return el;
  }

  /** Small buttons under the banner: Stats, Challenges, Armory. */
  buttons(): HTMLElement {
    return h('div', { class: 'realms-progress-row' },
      button(t('prog.stats'), () => this.showStats(), { cls: 'realms-small' }),
      button(t('prog.challenges'), () => this.showChallenges(), { cls: 'realms-small' }),
      button(t('prog.armory'), () => this.showArmory(), { cls: 'realms-small' }),
    );
  }

  private noProfile(title: string): void {
    this.stack.push(menuScreen(title, [h('div', { class: 'hint', text: t('prog.none') })], [
      button(t('common.back'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
  }

  showStats(): void {
    const p = currentProfile();
    if (!p) return this.noProfile(t('rstats.title'));
    const s = p.stats;
    const fav = favouriteWeapon(p);
    const played = s.wins + s.losses + s.draws;
    const panel = h('div', { class: 'prog-panel' },
      h('div', { class: 'prog-grid' },
        stat(t('rstats.kd'), kd(s.kills, s.deaths)),
        stat(t('rstats.kills'), String(s.kills)),
        stat(t('rstats.deaths'), String(s.deaths)),
        stat(t('rstats.assists'), String(s.assists)),
        stat(t('rstats.wins'), String(s.wins)),
        stat(t('rstats.losses'), String(s.losses)),
        stat(t('rstats.winRate'), `${played > 0 ? Math.round((s.wins / played) * 100) : 0}%`),
        stat(t('rstats.accuracy'), `${accuracy(s.hits, s.shots)}%`),
        stat(t('rstats.headshots'), `${s.headshots} (${s.kills > 0 ? Math.round((s.headshots / s.kills) * 100) : 0}%)`),
        stat(t('rstats.favourite'), fav ? weaponDef(fav)?.name ?? fav : '-'),
        stat(t('rstats.bestStreak'), String(s.bestStreak)),
        stat(t('rstats.timePlayed'), duration(s.seconds * 1000)),
        stat(t('rstats.objectives'), `${s.captures} / ${s.zones}`),
        stat(t('rstats.matches'), String(s.matches)),
      ),
      h('div', { class: 'prog-section-title', text: t('rstats.modes') }),
      ...REALMS_MODES.filter((m) => p.modes[m]).map((m) => {
        const r = p.modes[m]!;
        return h('div', { class: 'prog-row' },
          h('div', { class: 'grow' }, h('span', { text: realmsModeName(m) }),
            h('span', { class: 'muted', text: t('rstats.modeRow', r.matches, r.wins, kd(r.kills, r.deaths)) })));
      }),
      h('div', { class: 'prog-section-title', text: t('rstats.recent') }),
      ...(p.recent.length === 0 ? [h('div', { class: 'prog-muted', text: t('rstats.none') })] : p.recent.map((m) =>
        h('div', { class: 'prog-row' },
          h('div', { class: 'grow' },
            h('span', { text: `${realmsModeName(m.mode)} - ${getMap(m.map).name}` }),
            h('span', { class: 'muted', text: t('rstats.recentRow', m.kills, m.deaths, m.assists, m.xp) })),
          h('div', { class: 'right' },
            h('div', { class: m.result === 'win' ? 'good' : m.result === 'loss' ? 'bad' : '', text: t(`rstats.${m.result}` as I18nKey) }),
            h('div', { class: 'muted', text: ago(m.at) })),
        ))),
    );
    this.stack.push(menuScreen(t('rstats.title'), [panel], [button(t('common.back'), () => this.stack.pop(), { cls: 'w150' })], { list: true }));
  }

  showChallenges(): void {
    const p = currentProfile();
    if (!p) return this.noProfile(t('chal.title'));
    const now = Date.now();
    const section = (period: ChallengePeriod) => {
      const key = periodKey(period, now);
      const state = currentState(period === 'daily' ? p.daily : p.weekly, key);
      return [
        h('div', { class: 'prog-section-title', text: `${t(period === 'daily' ? 'chal.daily' : 'chal.weekly')} - ${t('chal.resets', duration(periodEndsIn(period, now)))}` }),
        ...activeChallenges(period, key).map((c, i) => {
          const have = Math.min(c.target, state.progress[i] ?? 0);
          const done = have >= c.target;
          return h('div', { class: `prog-row${done ? ' done' : ''}`, 'data-challenge': c.id },
            h('div', { class: 'grow' },
              h('span', { text: challengeText(c) }),
              h('div', { class: 'xp-bar' }, h('i', { style: `width:${Math.round((have / c.target) * 100)}%` }))),
            h('div', { class: 'right' },
              h('div', { class: done ? 'good' : '', text: done ? t('chal.done') : `${have} / ${c.target}` }),
              h('div', { class: 'muted', text: t('chal.reward', c.xp) })),
          );
        }),
      ];
    };
    const panel = h('div', { class: 'prog-panel' }, ...section('daily'), ...section('weekly'));
    this.stack.push(menuScreen(t('chal.title'), [panel], [button(t('common.back'), () => this.stack.pop(), { cls: 'w150' })], { list: true }));
  }

  showArmory(): void {
    const p = currentProfile();
    if (!p) return this.noProfile(t('armory.title'));
    const rank = rankOf(p);
    const panel = h('div', { class: 'prog-panel' }, h('div', { class: 'prog-muted', text: t('armory.hint') }));
    const weapons: { id: string; kind: 'primary' | 'secondary' }[] = [
      ...PRIMARY_WEAPONS.map((id) => ({ id, kind: 'primary' as const })),
      ...SECONDARY_WEAPONS.map((id) => ({ id, kind: 'secondary' as const })),
    ];
    for (const { id, kind } of weapons) {
      const w = weaponDef(id)!;
      const rec = p.weapons[id];
      const xp = rec?.xp ?? 0;
      const lv = weaponLevel(xp);
      const open = isUnlocked(kind, id, rank);
      const chosen = p.equip.camos[id] ?? 'none';
      const swatches = h('div', { class: 'camo-row' }, ...CAMOS.map((c) => {
        const ok = camoUnlocked(c.id, xp);
        const sw = h('div', {
          class: `camo-swatch${ok ? '' : ' locked'}${c.id === chosen ? ' selected' : ''}`,
          style: `background:${camoSwatch(c)}`,
          title: ok ? camoName(c.id) : `${camoName(c.id)} - ${t('armory.camoLocked', c.level)}`,
          'data-camo': c.id,
        });
        if (ok) {
          sw.addEventListener('click', () => {
            void equip({ camos: { [id]: c.id } }).then(() => { this.stack.pop(); this.showArmory(); });
          });
        }
        return sw;
      }));
      panel.append(h('div', { class: 'prog-row', 'data-weapon': id },
        h('div', { class: 'grow' },
          h('span', { text: w.name }),
          h('span', { class: open ? 'muted' : 'bad', text: open ? `${t('armory.level', lv.level)} - ${t('armory.kills', rec?.kills ?? 0)}` : t('armory.locked', unlockLevel(kind, id)) }),
          h('div', { class: `xp-bar${lv.need === 0 ? ' max' : ''}` }, h('i', { style: `width:${lv.need > 0 ? Math.round((lv.into / lv.need) * 100) : 100}%` })),
          swatches,
        ),
      ));
    }
    this.stack.push(menuScreen(t('armory.title'), [panel], [button(t('common.back'), () => this.stack.pop(), { cls: 'w150' })], { list: true }));
  }

  /** Title, calling card and prestige. */
  showProfile(): void {
    const p = currentProfile();
    if (!p) return this.noProfile(t('custom.title'));
    const rank = rankOf(p);
    const titles = TITLES.filter((u) => hasUnlock(u, rank, p.stats.challenges));
    const cards = CARDS.filter((u) => hasUnlock(u, rank, p.stats.challenges));
    const lockedTitles = TITLES.filter((u) => !titles.includes(u));
    const lockedCards = CARDS.filter((u) => !cards.includes(u));
    const banner = this.banner();
    const titleBtn = button(t('custom.titleLabel', t(`ptitle.${p.equip.title}` as I18nKey)), () => {
      const i = titles.findIndex((u) => u.id === p.equip.title);
      void equip({ title: titles[(i + 1) % titles.length].id }).then(() => { this.stack.pop(); this.showProfile(); });
    }, { cls: 'w150' });
    const cardBtn = button(t('custom.card', t(`card.${p.equip.card}` as I18nKey)), () => {
      const i = cards.findIndex((u) => u.id === p.equip.card);
      void equip({ card: cards[(i + 1) % cards.length].id }).then(() => { this.stack.pop(); this.showProfile(); });
    }, { cls: 'w150' });
    const can = canPrestige(rank);
    const prestigeBtn = button(t('custom.prestige', rank.prestige + 1), () => this.confirmPrestige(rank.prestige + 1), { cls: 'w150', disabled: !can });
    const locked = [
      ...lockedTitles.map((u) => t('custom.locked', t(`ptitle.${u.id}` as I18nKey), lockText(u))),
      ...lockedCards.map((u) => t('custom.locked', t(`card.${u.id}` as I18nKey), lockText(u))),
    ];
    const panel = h('div', { class: 'prog-panel', style: 'align-items: center;' },
      banner,
      h('div', { class: 'prog-muted', text: t('custom.created', new Date(p.created).toLocaleDateString()) }),
      h('div', { class: 'row' }, titleBtn, cardBtn),
      prestigeBtn,
      h('div', { class: 'prog-muted', text: t('custom.prestigeHint') }),
      ...locked.map((line) => h('div', { class: 'prog-muted', text: line })),
    );
    this.stack.push(menuScreen(t('custom.title'), [panel], [button(t('common.back'), () => this.stack.pop(), { cls: 'w150' })], { list: true }));
  }

  private confirmPrestige(next: number): void {
    this.stack.push(menuScreen(t('custom.prestige', next), [
      h('div', { class: 'prog-panel', style: 'align-items: center;' },
        h('div', { class: 'hint', text: t('custom.prestigeSure', next) }),
        h('div', { class: 'prog-muted', text: t('custom.prestigeHint') })),
    ], [
      button(t('custom.prestige', next), () => {
        void prestige().then(() => { this.stack.pop(); this.stack.pop(); this.showProfile(); });
      }, { cls: 'w150' }),
      button(t('common.cancel'), () => this.stack.pop(), { cls: 'w150' }),
    ]));
  }
}
