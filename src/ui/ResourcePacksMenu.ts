import type { SettingsStore } from '../core/Settings';
import { BUILTIN_PACKS, IMPORTED_PREFIX, type ImportedPack, PROCEDURAL_PACK_ID } from '../rendering/TexturePacks';
import { button, h, menuScreen } from './dom';

export interface ResourcePackActions {
  listImported(): Promise<ImportedPack[]>;
  importFile(file: File): Promise<void>;
  remove(id: string): Promise<void>;
  /** Icon (data URL) shown next to each pack. */
  icon(): string;
}

interface Entry {
  id: string;
  name: string;
  detail: string;
  importedId?: string;
}

/**
 * Resource pack selection. Besides the bundled packs, players can load textures from
 * their own Minecraft installation (client .jar) or any Java resource pack (.zip).
 * Imported textures are stored only in this browser and are never bundled with the game.
 */
export function resourcePacksScreen(store: SettingsStore, actions: ResourcePackActions, onDone: () => void): HTMLDivElement {
  const list = h('div', { class: 'world-list' });
  const status = h('div', { class: 'error' });
  const fileInput = h('input', { type: 'file', accept: '.jar,.zip', class: 'hidden' });

  const render = (entries: Entry[]) => {
    list.replaceChildren(...entries.map((e) => {
      const selected = store.values.texturePack === e.id;
      const item = h('div', { class: `world-item pack-item${selected ? ' selected' : ''}` },
        h('img', { class: 'world-icon', src: actions.icon(), alt: '', draggable: false }),
        h('div', { class: 'world-text' },
          h('div', { class: 'world-name', text: e.name }),
          h('div', { class: 'world-meta', text: e.detail }),
          h('div', { class: 'world-meta', text: selected ? 'Selected' : 'Click to use' }),
        ),
      );
      item.addEventListener('click', () => {
        store.set('texturePack', e.id);
        render(entries);
      });
      if (e.importedId) {
        const del = button('Delete', () => void actions.remove(e.importedId!));
        del.addEventListener('click', (ev) => ev.stopPropagation());
        item.append(del);
      }
      return item;
    }));
  };

  const load = async () => {
    const imported = await actions.listImported();
    render([
      ...BUILTIN_PACKS.map((p) => ({ id: p.id, name: p.name, detail: p.credit })),
      { id: PROCEDURAL_PACK_ID, name: 'Procedural', detail: 'BunkCraft\'s own generated pixel art' },
      ...imported.map((p) => ({
        id: IMPORTED_PREFIX + p.id,
        name: p.name,
        detail: `Imported ${new Date(p.created).toLocaleDateString()} · ${Object.keys(p.files).length} textures · this browser only`,
        importedId: p.id,
      })),
    ]);
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    status.textContent = `Importing ${file.name}...`;
    try {
      await actions.importFile(file);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });

  void load();
  return menuScreen('Select Resource Packs', [
    list,
    h('div', { class: 'hint', style: 'margin-top: calc(var(--s) * 8)' },
      h('div', { text: 'Use the original Minecraft textures from your own copy of Minecraft (1.13 or newer):' }),
      h('div', { class: 'path', text: '%APPDATA%\\.minecraft\\versions\\<version>\\<version>.jar' }),
      h('div', { text: 'or any Java Edition resource pack (.zip). Textures stay in this browser.' }),
    ),
    status,
    fileInput,
  ], [
    button('Open Pack File...', () => fileInput.click(), { cls: 'w150' }),
    button('Done', onDone, { cls: 'w150' }),
  ], { list: true });
}
