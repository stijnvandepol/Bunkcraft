import { type StatTracker, formatDistance, formatPlayTime } from '../player/StatTracker';
import { button, h, menuScreen } from './dom';
import { t } from './i18n';

/** Rows of the Statistics screen: label key, value formatter. */
export function statisticRows(stats: Pick<StatTracker, 'get'>): { label: string; value: string }[] {
  const n = (v: number) => v.toLocaleString('en-US');
  return [
    { label: t('stats.timePlayed'), value: formatPlayTime(stats.get('playMs')) },
    { label: t('stats.distanceWalked'), value: formatDistance(stats.get('walkedCm')) },
    { label: t('stats.jumps'), value: n(stats.get('jumps')) },
    { label: t('stats.blocksMined'), value: n(stats.get('mined')) },
    { label: t('stats.blocksPlaced'), value: n(stats.get('placed')) },
    { label: t('stats.mobsKilled'), value: n(stats.get('killed')) },
    { label: t('stats.deaths'), value: n(stats.get('deaths')) },
  ];
}

/** Minecraft's Statistics screen: a dark list of "label ... value" rows. */
export function statisticsScreen(stats: Pick<StatTracker, 'get'>, close: () => void): HTMLDivElement {
  const rows = statisticRows(stats).map((r, i) => h('div', { class: `stat-row${i % 2 ? ' alt' : ''}` },
    h('span', { text: r.label }), h('span', { class: 'stat-value', text: r.value })));
  return menuScreen(t('stats.title'), [h('div', { class: 'stat-list' }, ...rows)], [button(t('common.done'), close)], { list: true });
}
