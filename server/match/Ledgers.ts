import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normalizeCode } from '../../src/net/protocol';
import { log } from '../Log';

/**
 * What the control plane must remember across its own restarts (an update) about the matches running in containers,
 * kept in small JSON files next to match-runners.json and always written atomically (temp file + rename):
 *
 * - AdmissionLedger: the profiles the control plane itself let into each lobby. A runner may only grant XP to these;
 *   a lobby adopted after a restart gets its list back from here (never from the runner).
 * - GrantLedger: the XP grant ids already paid. A runner retries a grant whose answer was lost; a restart between
 *   two tries must not pay twice.
 */

const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GRANT_ID = /^[a-z0-9]{8,24}\.\d{1,12}$/;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null; // first start, or no records
  }
}

function writeAtomic(file: string, data: unknown, what: string): void {
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    log.warn(`${what} not saved`, { error: String(e) });
  }
}

export class AdmissionLedger {
  private readonly lobbies = new Map<string, Set<string>>();

  constructor(private readonly file: string, private readonly maxLobbies = 2048, private readonly maxPerLobby = 512) {
    const raw = readJson(file);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [code, ids] of Object.entries(raw)) {
      if (normalizeCode(code) !== code || !Array.isArray(ids)) continue;
      const set = new Set(ids.filter((id): id is string => typeof id === 'string' && PROFILE_ID.test(id)).slice(-maxPerLobby));
      if (set.size) this.lobbies.set(code, set);
      if (this.lobbies.size >= maxLobbies) break;
    }
  }

  /** A profile the control plane let into a lobby; written at once when it is new. */
  admit(code: string, pid: string): void {
    if (!PROFILE_ID.test(pid)) return;
    let set = this.lobbies.get(code);
    if (set?.has(pid)) return;
    if (!set) {
      set = new Set();
      this.lobbies.set(code, set);
      // Oldest lobby first (a Map keeps insertion order): records of lobbies that ended without a `forget`.
      while (this.lobbies.size > this.maxLobbies) this.lobbies.delete(this.lobbies.keys().next().value!);
    }
    set.add(pid);
    while (set.size > this.maxPerLobby) set.delete(set.values().next().value!);
    this.save();
  }

  /** The profiles admitted to a lobby (empty when none). */
  admitted(code: string): string[] {
    return [...(this.lobbies.get(code) ?? [])];
  }

  /** The lobby ended: its records go. */
  forget(code: string): void {
    if (this.lobbies.delete(code)) this.save();
  }

  /** Keeps only these lobbies (after adoption: the lobbies no runner runs any more are over). */
  retain(codes: Iterable<string>): void {
    const keep = new Set(codes);
    let changed = false;
    for (const code of [...this.lobbies.keys()]) if (!keep.has(code)) { this.lobbies.delete(code); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    const out: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [code, set] of this.lobbies) out[code] = [...set];
    writeAtomic(this.file, out, 'match admissions');
  }
}

export class GrantLedger {
  /** Grant id → when it was paid (ms). */
  private readonly paid = new Map<string, number>();

  constructor(private readonly file: string, private readonly ttlMs = 24 * 3_600_000, private readonly max = 20_000, private readonly now: () => number = Date.now) {
    const raw = readJson(file);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const t = this.now();
    const rows = Object.entries(raw)
      .filter((e): e is [string, number] => GRANT_ID.test(e[0]) && typeof e[1] === 'number' && Number.isFinite(e[1]) && t - e[1] < this.ttlMs)
      .sort((a, b) => a[1] - b[1])
      .slice(-this.max);
    for (const [id, at] of rows) this.paid.set(id, at);
  }

  /** Whether this grant was paid already (within the TTL). */
  has(id: string): boolean {
    const at = this.paid.get(id);
    return at !== undefined && this.now() - at < this.ttlMs;
  }

  /** The grant is paid: on disk before the answer goes back. */
  record(id: string): void {
    if (!GRANT_ID.test(id)) return;
    const t = this.now();
    this.paid.delete(id);
    this.paid.set(id, t);
    for (const [k, at] of this.paid) {
      if (this.paid.size <= this.max && t - at < this.ttlMs) break;
      this.paid.delete(k);
    }
    const out: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [k, at] of this.paid) out[k] = at;
    writeAtomic(this.file, out, 'xp grant records');
  }
}
