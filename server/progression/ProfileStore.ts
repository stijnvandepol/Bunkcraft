import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProfileData, newProfile, sanitizeProfile } from '../../src/modes/progression/Profile';

/** A profile file larger than this is not written (the sanitiser keeps real ones far below it). */
export const MAX_PROFILE_BYTES = 32 * 1024;

export interface ProfileStoreOptions {
  /** `<DATA_DIR>/profiles`. */
  dir: string;
  /** Most profiles this server keeps (new ones are refused beyond it). */
  maxProfiles: number;
  /** Profiles kept in memory (least recently used ones are dropped after saving). */
  cacheSize?: number;
}

/**
 * Profiles on disk: one small JSON file per profile in `<dir>/<shard>/<id>.json`, the shard being the first two
 * characters of the id (keeps directories small). Loaded on demand, cached, written atomically (tmp + rename)
 * by `flush`, which the service calls every few seconds and on shutdown.
 */
export class ProfileStore {
  private readonly cache = new Map<string, ProfileData>();
  private readonly dirty = new Set<string>();
  private total = 0;

  constructor(private readonly opts: ProfileStoreOptions) {
    mkdirSync(opts.dir, { recursive: true });
    for (const shard of readdirSync(opts.dir)) {
      if (!/^[A-Za-z0-9_-]{2}$/.test(shard)) continue;
      try {
        this.total += readdirSync(join(opts.dir, shard)).filter((f) => f.endsWith('.json')).length;
      } catch { /* not a directory */ }
    }
  }

  get count(): number {
    return this.total;
  }

  get full(): boolean {
    return this.total >= this.opts.maxProfiles;
  }

  private file(id: string): string {
    return join(this.opts.dir, id.slice(0, 2), `${id}.json`);
  }

  /** A new, empty profile under `id`, or null when the server keeps no more profiles. */
  create(id: string, name: string, nowMs = Date.now()): ProfileData | null {
    if (this.full) return null;
    const p = newProfile(id, name, nowMs);
    this.total++;
    this.remember(p);
    this.dirty.add(id);
    try {
      this.flushOne(id);
    } catch {
      this.dirty.add(id); // written on the next flush
    }
    return p;
  }

  /** The profile of an id (from the cache or disk), or null when there is none or the file is unreadable. */
  get(id: string): ProfileData | null {
    const hit = this.cache.get(id);
    if (hit) {
      // Most recently used goes to the end of the map (LRU order).
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const file = this.file(id);
    if (!existsSync(file)) return null;
    try {
      const p = sanitizeProfile(JSON.parse(readFileSync(file, 'utf8')));
      if (!p || p.id !== id) return null;
      this.remember(p);
      return p;
    } catch {
      return null;
    }
  }

  /** The profile changed in memory: written on the next flush. */
  touch(id: string): void {
    if (this.cache.has(id)) this.dirty.add(id);
  }

  private remember(p: ProfileData): void {
    this.cache.set(p.id, p);
    const max = this.opts.cacheSize ?? 2000;
    if (this.cache.size <= max) return;
    for (const id of this.cache.keys()) {
      if (this.cache.size <= max) break;
      if (this.dirty.has(id)) {
        try {
          this.flushOne(id);
        } catch {
          this.dirty.add(id); // could not save: keep it in memory
          continue;
        }
      }
      this.cache.delete(id);
    }
  }

  private flushOne(id: string): void {
    const p = this.cache.get(id);
    this.dirty.delete(id);
    if (!p) return;
    const json = JSON.stringify(p);
    if (json.length > MAX_PROFILE_BYTES) return;
    const file = this.file(id);
    mkdirSync(join(this.opts.dir, id.slice(0, 2)), { recursive: true });
    writeFileSync(`${file}.tmp`, json);
    renameSync(`${file}.tmp`, file);
  }

  /** Writes every changed profile. Errors (disk full) keep them dirty for the next try. */
  flush(): void {
    for (const id of [...this.dirty]) {
      try {
        this.flushOne(id);
      } catch {
        this.dirty.add(id);
      }
    }
  }
}
