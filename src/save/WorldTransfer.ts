import { downloadBlob } from '../ui/download';
import { ARCHIVE_EXTENSION, buildBackup, buildWorldArchive, parseArchive, safeFileName } from './WorldArchive';
import { type SaveSystem, type WorldMeta, newWorldId } from './SaveSystem';

/**
 * Stores parsed worlds in the save system. A world whose id already exists gets a new id,
 * so importing never overwrites an existing world (importing a backup twice gives copies).
 */
export async function importArchive(save: SaveSystem, bytes: Uint8Array): Promise<WorldMeta[]> {
  const parsed = parseArchive(bytes);
  const taken = new Set((await save.listWorlds()).map((w) => w.id));
  const imported: WorldMeta[] = [];
  for (const { meta, records } of parsed) {
    if (taken.has(meta.id)) meta.id = newWorldId();
    taken.add(meta.id);
    for (const r of records) r.worldId = meta.id;
    await save.saveWorld(meta);
    await save.saveRawChunks(records);
    imported.push(meta);
  }
  return imported;
}

/** Bytes of a `.bunkworld` file for one stored world. */
export async function exportArchive(save: SaveSystem, meta: WorldMeta): Promise<Uint8Array> {
  return buildWorldArchive(meta, await save.loadRawChunks(meta.id));
}

/** Browser glue for the Select World screen: file downloads and file picking. */
export class WorldTransfer {
  constructor(private readonly save: SaveSystem) {}

  async exportWorld(meta: WorldMeta): Promise<void> {
    const bytes = await exportArchive(this.save, meta);
    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${safeFileName(meta.name)}${ARCHIVE_EXTENSION}`);
  }

  /** One zip with every world, for moving to another browser or as a safety copy. */
  async backupAll(): Promise<number> {
    const worlds = await this.save.listWorlds();
    const archives = [];
    for (const w of worlds) archives.push({ name: `${safeFileName(w.name)}-${w.id}${ARCHIVE_EXTENSION}`, bytes: await exportArchive(this.save, w) });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([buildBackup(archives) as BlobPart], { type: 'application/zip' }), `bunkcraft-backup-${stamp}.zip`);
    return worlds.length;
  }

  async importFile(file: File): Promise<WorldMeta[]> {
    return importArchive(this.save, new Uint8Array(await file.arrayBuffer()));
  }
}
