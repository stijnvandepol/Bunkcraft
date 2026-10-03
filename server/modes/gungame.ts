import type { WeaponDef } from '../../src/modes/Weapons';
import type { Match, MatchPlayer } from '../Match';
import { BaseLogic, type Kit, type MatchResult, topPlayer } from './ModeLogic';

/**
 * Gun game: every kill moves you one step up the weapon ladder (`def.ladder`, ending with the
 * knife). A kill with the knife also sets the victim one step back. Whoever kills with the last
 * weapon (the knife) finishes the ladder and wins; on time the highest level wins.
 * `MatchPlayer.pts` is the level (0 = first weapon).
 */
export class GunGameLogic extends BaseLogic {
  private ladder(m: Match): string[] {
    return m.def.ladder ?? ['rifle', 'knife'];
  }

  /** Weapon id of a level (clamped to the last one). */
  weaponAt(m: Match, level: number): string {
    const l = this.ladder(m);
    return l[Math.max(0, Math.min(l.length - 1, level))];
  }

  loadoutFor(m: Match, p: MatchPlayer): Kit {
    // The level weapon plus the knife: no choice, so a bad level can still be survived by stabbing.
    return { primary: this.weaponAt(m, p.pts), secondary: 'knife', melee: 'knife' };
  }

  onKill(m: Match, killer: MatchPlayer | null, victim: MatchPlayer, weapon: WeaponDef): void {
    if (!killer || killer === victim) return;
    if (weapon.id === 'knife' && victim.pts > 0) {
      victim.pts--;
      m.event('level-down', victim.team, victim.id, `${killer.name} knifed ${victim.name}`);
    }
    killer.pts++;
    if (killer.pts < this.ladder(m).length) {
      m.event('level-up', killer.team, killer.id, this.weaponAt(m, killer.pts));
      // The rest of the life goes on with the next weapon.
      if (killer.alive) m.giveGear(killer, this.weaponAt(m, killer.pts), 'knife', 'knife');
    }
  }

  checkEnd(m: Match): MatchResult | null {
    const top = this.ladder(m).length;
    return [...m.players.values()].some((p) => p.pts >= top) ? this.winner(m) : null;
  }

  winner(m: Match): MatchResult {
    return topPlayer(m, (p) => p.pts);
  }

  scoreText(m: Match): string {
    return `${this.ladder(m).length} weapons, the knife is last`;
  }
}
