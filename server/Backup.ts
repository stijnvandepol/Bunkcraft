import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './Log';

/**
 * Rotating backups of world.json. world.json itself is written atomically (temp file + rename), so
 * copying it at any moment gives a consistent file. Each world gets `<backupDir>/<name>/<timestamp>.json`;
 * a copy is only made when the world changed since the newest backup, and only the newest `keep` stay.
 */
const stamp = (t: number): string => new Date(t).toISOString().replace(/[:.]/g, '-');

/** Newest-first list of backup files for one world. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
}

/** Copies `src` into `dir` when it changed since the last backup, then trims to `keep`. Returns the new file or null. */
export function backupFile(src: string, dir: string, keep: number, now = Date.now()): string | null {
  if (keep <= 0 || !existsSync(src)) return null;
  mkdirSync(dir, { recursive: true });
  const existing = listBackups(dir);
  if (existing.length > 0 && statSync(src).mtimeMs <= statSync(join(dir, existing[0])).mtimeMs) return null;
  let name = `${stamp(now)}.json`;
  // Two backups in the same millisecond (tests) must not overwrite each other.
  while (existsSync(join(dir, name))) name = `${stamp(now++)}.json`;
  const tmp = join(dir, `${name}.tmp`);
  copyFileSync(src, tmp);
  renameSync(tmp, join(dir, name));
  for (const old of listBackups(dir).slice(keep)) rmSync(join(dir, old), { force: true });
  return name;
}

/** Backs up the main world and every room; returns how many files were copied. */
export function backupAll(dataDir: string, backupDir: string, keep: number, now = Date.now()): number {
  let copied = 0;
  try {
    if (backupFile(join(dataDir, 'world.json'), join(backupDir, 'main'), keep, now)) copied++;
    const roomsDir = join(dataDir, 'rooms');
    if (existsSync(roomsDir)) {
      for (const code of readdirSync(roomsDir)) {
        if (!/^[A-Z0-9]{6}$/.test(code)) continue;
        if (backupFile(join(roomsDir, code, 'world.json'), join(backupDir, code), keep, now)) copied++;
      }
      // Backups of games that no longer exist are kept for 30 days (an accidental delete can be undone), then dropped.
      if (existsSync(backupDir)) {
        for (const code of readdirSync(backupDir)) {
          if (code === 'main' || existsSync(join(roomsDir, code))) continue;
          const newest = listBackups(join(backupDir, code))[0];
          const age = newest ? now - statSync(join(backupDir, code, newest)).mtimeMs : Infinity;
          if (age > 30 * 86_400_000) rmSync(join(backupDir, code), { recursive: true, force: true });
        }
      }
    }
  } catch (e) {
    log.error('backup failed', { error: String(e) });
  }
  if (copied > 0) log.info('backup done', { files: copied });
  return copied;
}
