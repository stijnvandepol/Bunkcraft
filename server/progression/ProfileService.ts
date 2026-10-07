import { join } from 'node:path';
import {
  type MatchOutcome, type MatchTally, type ProfileData, type ProgressReport, applyMatch, cleanName, prestigeUp, rankOf, setEquip,
} from '../../src/modes/progression/Profile';
import { rankCode } from '../../src/modes/progression/Levels';
import { log } from '../Log';
import { ProfileSigner, loadSecret } from './ProfileTokens';
import { ProfileStore } from './ProfileStore';

export interface ProfileServiceOptions {
  /** `<DATA_DIR>`: profiles live in `<DATA_DIR>/profiles/`. */
  dataDir: string;
  maxProfiles: number;
  /** PROFILE_SECRET; unset = a random secret kept in `<DATA_DIR>/profiles/secret.key`. */
  secret?: string;
  /** Milliseconds between writes of changed profiles (default 5000). */
  flushMs?: number;
}

/**
 * Realms progression on the server: issues and checks profile tokens, loads and saves profiles, and is the only
 * place XP is granted (`award`, called by GameServer when a match ends or a player leaves one). Shared by every
 * game on the server, so progress follows the player from lobby to lobby.
 */
export class ProfileService {
  readonly store: ProfileStore;
  private readonly signer: ProfileSigner;
  private readonly timer: NodeJS.Timeout;

  constructor(opts: ProfileServiceOptions) {
    const dir = join(opts.dataDir, 'profiles');
    this.signer = new ProfileSigner(loadSecret(join(dir, 'secret.key'), opts.secret));
    this.store = new ProfileStore({ dir, maxProfiles: opts.maxProfiles });
    this.timer = setInterval(() => this.flush(), opts.flushMs ?? 5000);
    this.timer.unref();
  }

  /** A new profile and its token (shown once), or null when the server keeps no more profiles. */
  create(name: unknown): { token: string; profile: ProfileData } | null {
    if (this.store.full) return null;
    const { id, token } = this.signer.issue();
    const profile = this.store.create(id, cleanName(name));
    if (!profile) return null;
    log.info('profile created', { profiles: this.store.count });
    return { token, profile };
  }

  /** The profile id of a valid token (signature only, no disk access). */
  verify(token: unknown): string | null {
    return this.signer.verify(token);
  }

  /** The profile behind a token, or null (bad token, or the profile is gone). */
  resolve(token: unknown): ProfileData | null {
    const id = this.signer.verify(token);
    return id ? this.store.get(id) : null;
  }

  get(id: string): ProfileData | null {
    return this.store.get(id);
  }

  /** Roster rank code of a profile (0 when unknown). */
  rank(id: string | undefined): number {
    const p = id ? this.store.get(id) : null;
    if (!p) return 0;
    const r = rankOf(p);
    return rankCode(r.level, r.prestige);
  }

  /** Remembers the name a profile last played with (display only). */
  seen(id: string, name: string): void {
    const p = this.store.get(id);
    if (!p || p.name === name) return;
    p.name = cleanName(name);
    this.store.touch(id);
  }

  /** Grants a match to a profile; null when the profile does not exist. */
  award(id: string, tally: MatchTally, outcome: MatchOutcome, nowMs = Date.now()): ProgressReport | null {
    const p = this.store.get(id);
    if (!p) return null;
    const report = applyMatch(p, tally, outcome, nowMs);
    this.store.touch(id);
    return report;
  }

  prestige(id: string): ProfileData | null {
    const p = this.store.get(id);
    if (!p || !prestigeUp(p)) return null;
    this.store.touch(id);
    return p;
  }

  equip(id: string, change: { title?: unknown; card?: unknown; camos?: unknown }): { ok: boolean; profile: ProfileData } | null {
    const p = this.store.get(id);
    if (!p) return null;
    const ok = setEquip(p, change);
    this.store.touch(id);
    return { ok, profile: p };
  }

  flush(): void {
    try {
      this.store.flush();
    } catch (e) {
      log.error('saving profiles failed', { error: String(e) });
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}
