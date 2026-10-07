import { DAILY_POOL, type ChallengeDef, WEEKLY_POOL } from '../modes/progression/Challenges';
import type { Unlock } from '../modes/progression/Unlocks';
import { OPTICS, type OpticId, PERKS, type PerkId, weaponDef } from '../modes/Weapons';
import { type I18nKey, t } from './i18n';

/** "Get 10 kills with an SMG" in the current language. */
export function challengeText(c: ChallengeDef): string {
  if (c.stat === 'class') return t('chal.class', c.target, t(`wclass.${c.weaponClass ?? 'ar'}` as I18nKey));
  return t(`chal.${c.stat}` as I18nKey, c.target);
}

export function challengeById(id: string): ChallengeDef | undefined {
  return DAILY_POOL.find((c) => c.id === id) ?? WEEKLY_POOL.find((c) => c.id === id);
}

/** Display name of an unlock: the weapon, optic or perk name, or the translated title / card. */
export function unlockName(u: Pick<Unlock, 'kind' | 'id'>): string {
  switch (u.kind) {
    case 'primary':
    case 'secondary': return weaponDef(u.id)?.name ?? u.id;
    case 'optic': return OPTICS[u.id as OpticId]?.name ?? u.id;
    case 'perk': return PERKS[u.id as PerkId]?.name ?? u.id;
    case 'title': return t(`ptitle.${u.id}` as I18nKey);
    case 'card': return t(`card.${u.id}` as I18nKey);
  }
}

/** "Primary: LMG". */
export function unlockLabel(u: Pick<Unlock, 'kind' | 'id'>): string {
  return `${t(`unlock.${u.kind}` as I18nKey)}: ${unlockName(u)}`;
}

/** What is needed for a title or card that is still locked ("level 30", "prestige 1", "10 challenges"). */
export function lockText(u: Unlock): string {
  if (u.prestige !== undefined) return t('lock.prestige', u.prestige);
  if (u.challenges !== undefined) return t('lock.challenges', u.challenges);
  return t('lock.level', u.level);
}

export function camoName(id: string): string {
  return t(`camo.${id}` as I18nKey);
}

/** "2 h 05 min", "3 d 4 h", "45 min". */
export function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440), hr = Math.floor((min % 1440) / 60), m = min % 60;
  if (d > 0) return `${d} d ${hr} h`;
  if (hr > 0) return `${hr} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}
