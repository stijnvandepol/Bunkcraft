import { type Rank, parseRank, rankTier } from '../modes/progression/Levels';
import { CARD_STYLES } from '../modes/progression/Unlocks';
import { h } from './dom';
import { t } from './i18n';
import './progression.css';

/** Badge colour per tier (five levels each): stone, green, blue, purple, orange, red, silver, gold, diamond, magenta, white. */
const TIER_COLORS = ['#8a8a8a', '#5aa83a', '#3d85c6', '#8e6cd3', '#e69138', '#d23c3c', '#c8c8d0', '#ffcc33', '#5fe0e8', '#ff55ff', '#ffffff'];

/**
 * The rank icon next to a name (scoreboard, kill feed, lobby panel, Realms hub): a small pixel badge in the
 * tier colour with the level in it; prestige ranks get a dark badge with a gold rim and the prestige number.
 * The number is drawn by CSS from a data attribute, so the element adds no text to the name next to it.
 */
export function rankBadge(rank: Rank | number | null | undefined, big = false): HTMLSpanElement | null {
  const r = typeof rank === 'number' ? parseRank(rank) : rank ?? null;
  if (!r) return null;
  const el = h('span', {
    class: `rank-badge${r.prestige > 0 ? ' prestige' : ''}${big ? ' big' : ''}`,
    style: `--rank:${TIER_COLORS[rankTier(r.level)]}`,
    'data-lv': String(r.level),
    title: r.prestige > 0 ? `${t('prog.prestige', r.prestige)} - ${t('prog.level', r.level)}` : t('prog.level', r.level),
    'aria-hidden': 'true',
  });
  if (r.prestige > 0) el.setAttribute('data-p', String(r.prestige));
  return el;
}

/** CSS background of a calling card (procedural: a gradient with a pixel checker of the accent colour). */
export function cardBackground(card: string): string {
  const c = CARD_STYLES[card] ?? CARD_STYLES.stone;
  const px = 'calc(var(--s) * 4)';
  return `linear-gradient(45deg, ${c.accent}22 25%, transparent 25%, transparent 75%, ${c.accent}22 75%) 0 0 / ${px} ${px}, `
    + `linear-gradient(90deg, ${c.from}, ${c.to})`;
}
