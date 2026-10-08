import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKIN_MAX_BYTES, SKIN_SIZE, type SkinErrorCode, canonicalSkin, isSkinHash } from '../../src/skins/SkinFormat';
import { log } from '../Log';
import type { ProfileService } from '../progression/ProfileService';
import { RateLimiter } from '../Security';
import { PngError, decodePng, encodePng } from './Png';

export interface SkinServiceOptions {
  /** `<DATA_DIR>`: skins live in `<DATA_DIR>/skins/<hash>.png`, bans and reports next to it. */
  dataDir: string;
  profiles: ProfileService;
  /** Most bytes of skin files this server keeps (uploads of new skins are refused beyond it). */
  maxBytes: number;
  /** Uploads (valid or not) per profile per hour. */
  uploadsPerHour: number;
}

export type UploadResult =
  | { ok: true; hash: string; created: boolean }
  | { ok: false; status: number; code: SkinErrorCode; error: string };

/** One reported skin as the admin page shows it. */
export interface SkinReport {
  hash: string;
  count: number;
  first: number;
  last: number;
  /** Names of players seen wearing it when it was reported (context for the moderator). */
  names: string[];
  banned: boolean;
}

interface StoredReport { count: number; first: number; last: number; reporters: string[]; names: string[] }

const MAX_REPORTED_HASHES = 500;
const MAX_REPORTERS = 100;
const MAX_NAMES = 5;
const FILE = /^[0-9a-f]{64}\.png$/;

/** Hash that identifies a skin: sha256 of its canonical RGBA pixels (so equal skins dedup whatever the file looked like). */
export function skinHashOf(canonicalRgba: Uint8Array): string {
  return createHash('sha256').update('bunkcraft-skin-v1').update(canonicalRgba).digest('hex');
}

/**
 * Custom player skins. Uploads are validated and re-encoded here (Png.ts + SkinFormat.canonicalSkin), stored
 * content-addressed, tied to a signed progression profile, rate limited per profile and capped in total size.
 * Reported and banned hashes are kept for the admin page; a banned hash is never served or handed to a client.
 * Moderating the content is the operator's job (docs/SERVER.md).
 */
export class SkinService {
  readonly dir: string;
  private readonly bansFile: string;
  private readonly reportsFile: string;
  private readonly bans = new Set<string>();
  private readonly reports = new Map<string, StoredReport>();
  private readonly limiter: RateLimiter;
  private readonly known = new Map<string, number>();
  private bytes = 0;
  private readonly cache = new Map<string, Buffer>();
  /** Called when a profile's skin changed (profile id) or hashes were banned (no id): games tell their players. */
  onChange: ((profileId?: string) => void) | null = null;

  constructor(private readonly opts: SkinServiceOptions) {
    this.dir = join(opts.dataDir, 'skins');
    this.bansFile = join(opts.dataDir, 'skin-bans.json');
    this.reportsFile = join(opts.dataDir, 'skin-reports.json');
    this.limiter = new RateLimiter(opts.uploadsPerHour, 3_600_000);
    mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir)) {
      if (!FILE.test(f)) continue;
      try {
        const size = statSync(join(this.dir, f)).size;
        this.known.set(f.slice(0, 64), size);
        this.bytes += size;
      } catch { /* vanished */ }
    }
    this.load();
  }

  get count(): number {
    return this.known.size;
  }

  get storedBytes(): number {
    return this.bytes;
  }

  get maxBytes(): number {
    return this.opts.maxBytes;
  }

  private load(): void {
    try {
      if (existsSync(this.bansFile)) for (const h of JSON.parse(readFileSync(this.bansFile, 'utf8')) as unknown[]) if (isSkinHash(h)) this.bans.add(h);
    } catch (e) {
      log.error('skin-bans.json unreadable', { error: String(e) });
    }
    try {
      if (existsSync(this.reportsFile)) {
        for (const [h, r] of Object.entries(JSON.parse(readFileSync(this.reportsFile, 'utf8')) as Record<string, Partial<StoredReport>>)) {
          if (!isSkinHash(h) || !r || typeof r !== 'object') continue;
          this.reports.set(h, {
            count: Number(r.count) || 1, first: Number(r.first) || 0, last: Number(r.last) || 0,
            reporters: Array.isArray(r.reporters) ? r.reporters.filter((x) => typeof x === 'string').slice(0, MAX_REPORTERS) : [],
            names: Array.isArray(r.names) ? r.names.filter((x) => typeof x === 'string').slice(0, MAX_NAMES) : [],
          });
        }
      }
    } catch (e) {
      log.error('skin-reports.json unreadable', { error: String(e) });
    }
  }

  private save(file: string, data: unknown): void {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(data));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      log.error('saving skin moderation data failed', { error: String(e) });
    }
  }

  // ---------------------------------------------------------------- serving

  isBanned(hash: string): boolean {
    return this.bans.has(hash);
  }

  /** The canonical PNG of a skin, or null when it is unknown or banned (a banned skin is never served). */
  read(hash: string): Buffer | null {
    if (!isSkinHash(hash) || this.bans.has(hash) || !this.known.has(hash)) return null;
    const hit = this.cache.get(hash);
    if (hit) return hit;
    try {
      const data = readFileSync(join(this.dir, `${hash}.png`));
      this.cache.set(hash, data);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return data;
    } catch {
      return null;
    }
  }

  /** The skin a profile wears now: '' for none, a missing file or a banned hash. */
  effective(profileId: string | undefined): string {
    const hash = profileId ? this.opts.profiles.get(profileId)?.skin : '';
    return hash && !this.bans.has(hash) && this.known.has(hash) ? hash : '';
  }

  // ---------------------------------------------------------------- uploads

  /** Validates, canonicalises and stores an uploaded file for a profile, and makes it the profile's skin. */
  upload(profileId: string, body: Uint8Array): UploadResult {
    if (!this.limiter.take(profileId)) return { ok: false, status: 429, code: 'rate', error: 'Too many skin uploads, try again later' };
    if (body.length > SKIN_MAX_BYTES) return { ok: false, status: 413, code: 'too-large', error: 'The file is larger than 16 KB' };
    let canonical: Uint8Array;
    try {
      const png = decodePng(body);
      const px = canonicalSkin(png.rgba, png.width, png.height);
      if (!px) return { ok: false, status: 400, code: 'size', error: `A skin is ${SKIN_SIZE}x${SKIN_SIZE} (or the old ${SKIN_SIZE}x${SKIN_SIZE / 2})` };
      canonical = px;
    } catch (e) {
      if (!(e instanceof PngError)) throw e;
      const code: SkinErrorCode = e.code === 'too-large' ? 'too-large' : e.code === 'not-png' ? 'not-png' : e.code === 'size' ? 'size'
        : e.code === 'animated' ? 'animated' : e.code === 'interlaced' ? 'interlaced' : e.code === 'format' ? 'format' : 'corrupt';
      return { ok: false, status: 400, code, error: e.message };
    }
    const hash = skinHashOf(canonical);
    if (this.bans.has(hash)) return { ok: false, status: 403, code: 'banned', error: 'This skin is not allowed on this server' };
    const created = !this.known.has(hash);
    if (created) {
      const png = encodePng(canonical, SKIN_SIZE, SKIN_SIZE);
      if (png.length > SKIN_MAX_BYTES) return { ok: false, status: 400, code: 'too-large', error: 'The skin does not compress small enough' };
      if (this.bytes + png.length > this.opts.maxBytes) {
        log.warn('skin storage full', { bytes: this.bytes, max: this.opts.maxBytes });
        return { ok: false, status: 507, code: 'storage', error: 'This server cannot store more skins' };
      }
      const file = join(this.dir, `${hash}.png`);
      try {
        writeFileSync(`${file}.tmp`, png);
        renameSync(`${file}.tmp`, file);
      } catch (e) {
        log.error('writing a skin failed', { error: String(e) });
        return { ok: false, status: 500, code: 'storage', error: 'Could not store the skin' };
      }
      this.known.set(hash, png.length);
      this.bytes += png.length;
    }
    this.assign(profileId, hash);
    return { ok: true, hash, created };
  }

  /** Back to the default skin. */
  clear(profileId: string): void {
    this.assign(profileId, '');
  }

  private assign(profileId: string, hash: string): void {
    const p = this.opts.profiles.get(profileId);
    if (!p || p.skin === hash) return;
    p.skin = hash;
    this.opts.profiles.store.touch(profileId);
    this.onChange?.(profileId);
  }

  // ---------------------------------------------------------------- reports and bans

  /**
   * Notes a report against a skin somebody wears. `reporter` is an opaque id (profile id or address) so one person
   * counts once per skin. Returns false for a skin this server does not know or a report already made.
   */
  report(hash: string, reporter: string, wearer: string): boolean {
    if (!isSkinHash(hash) || !this.known.has(hash)) return false;
    const who = createHash('sha256').update(reporter).digest('hex').slice(0, 16);
    let r = this.reports.get(hash);
    if (!r) {
      if (this.reports.size >= MAX_REPORTED_HASHES) return false;
      r = { count: 0, first: Date.now(), last: 0, reporters: [], names: [] };
      this.reports.set(hash, r);
    }
    if (r.reporters.includes(who)) return false;
    if (r.reporters.length < MAX_REPORTERS) r.reporters.push(who);
    r.count++;
    r.last = Date.now();
    if (wearer && !r.names.includes(wearer) && r.names.length < MAX_NAMES) r.names.push(wearer);
    this.saveReports();
    log.warn('skin reported', { hash: hash.slice(0, 12), reports: r.count });
    return true;
  }

  listReports(): SkinReport[] {
    return [...this.reports.entries()]
      .map(([hash, r]) => ({ hash, count: r.count, first: r.first, last: r.last, names: [...r.names], banned: this.bans.has(hash) }))
      .sort((a, b) => b.count - a.count || b.last - a.last);
  }

  listBans(): string[] {
    return [...this.bans].sort();
  }

  /** Bans a hash: it is no longer served, uploaded or shown to players; connected players are told. */
  ban(hash: string): boolean {
    if (!isSkinHash(hash)) return false;
    this.bans.add(hash);
    this.cache.delete(hash);
    this.save(this.bansFile, this.listBans());
    log.warn('skin banned', { hash: hash.slice(0, 12) });
    this.onChange?.();
    return true;
  }

  unban(hash: string): boolean {
    if (!this.bans.delete(hash)) return false;
    this.save(this.bansFile, this.listBans());
    this.onChange?.();
    return true;
  }

  /** The admin dismissed the reports of a hash (it is fine). */
  dismiss(hash: string): boolean {
    if (!this.reports.delete(hash)) return false;
    this.saveReports();
    return true;
  }

  private saveReports(): void {
    this.save(this.reportsFile, Object.fromEntries(this.reports));
  }

  /** Deletes a skin file for good (admin); its reports stay. */
  purge(hash: string): boolean {
    const size = this.known.get(hash);
    if (size === undefined) return false;
    try { unlinkSync(join(this.dir, `${hash}.png`)); } catch { /* already gone */ }
    this.known.delete(hash);
    this.cache.delete(hash);
    this.bytes -= size;
    this.onChange?.();
    return true;
  }

  prune(): void {
    this.limiter.prune();
  }
}
