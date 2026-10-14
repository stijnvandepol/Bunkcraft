import { type ClassBook, CLASS_NAME_MAX, type SavedClass, cleanClassName } from '../modes/ClassBook';
import { type ClassSpec, LOADOUT_PRESETS, validateClass } from '../modes/Loadouts';
import type { Rank } from '../modes/progression/Levels';
import { type EquipKind, classUnlocked, isUnlocked, unlockLevel } from '../modes/progression/Unlocks';
import {
  ATTACHMENTS, OPTICS, type OpticId, PERKS, PERK_IDS, type PerkId, PRIMARY_WEAPONS, RAIL_IDS, SECONDARY_WEAPONS, UNDER_IDS, type WeaponDef,
  adsTimeFor, attachAllowed, fireMode, hipSpreadMul, magazineFor, opticAllowed, opticZoom, perksCompatible, rangeMulFor, recoilMul, weaponDef,
} from '../modes/Weapons';
import { h } from './dom';
import { type I18nKey, t } from './i18n';

/** A field of a class the editor changes. */
export type ClassField = 'primary' | 'optic' | 'under' | 'rail' | 'secondary' | 'perk' | 'perk2';

/** Which unlock table a field's items are in. */
const KIND: Record<ClassField, EquipKind> = {
  primary: 'primary', optic: 'optic', under: 'attachment', rail: 'attachment', secondary: 'secondary', perk: 'perk', perk2: 'perk',
};

/** Perk name for labels: perk names are product names, "No Perk" is a label. */
export function perkName(p: PerkId): string {
  return p === 'none' ? t('arc.noPerk') : PERKS[p].name;
}

/** The name of a saved class: the player's, or "Class 2". */
export function className(c: Pick<SavedClass, 'name'>, index: number): string {
  return c.name || t('cac.slot', index + 1);
}

/** "Assault Rifle (Red Dot, Laser) + Pistol". */
export function classLine(c: ClassSpec): string {
  const extras: string[] = [];
  if (c.optic !== 'iron') extras.push(OPTICS[c.optic].name);
  if (c.under !== 'none') extras.push(ATTACHMENTS[c.under].name);
  if (c.rail !== 'none') extras.push(ATTACHMENTS[c.rail].name);
  return `${weaponDef(c.primary)?.name ?? c.primary}${extras.length ? ` (${extras.join(', ')})` : ''} + ${weaponDef(c.secondary)?.name ?? c.secondary}`;
}

/** "Quickdraw + Ninja", or "No Perk". */
export function perksLine(c: Pick<ClassSpec, 'perk' | 'perk2'>): string {
  const names = [c.perk, c.perk2].filter((p) => p !== 'none').map((p) => PERKS[p].name);
  return names.length ? names.join(' + ') : t('arc.noPerk');
}

/** Stat bars of a primary with the optic, perks and attachments of a class. */
export function statRows(def: WeaponDef, c: ClassSpec): HTMLElement[] {
  const bar = (label: string, frac: number, value: string) => h('div', { class: 'arc-stat' },
    h('span', { text: `${label}  ${value}` }), h('div', { class: 'arc-stat-bar' }, h('i', { style: `width:${Math.round(Math.min(1, Math.max(0.05, frac)) * 100)}%` })));
  const mag = magazineFor(def, c);
  const ads = adsTimeFor(def, c.optic, c);
  const hip = def.spread * hipSpreadMul(def, c);
  const kick = def.recoil * recoilMul(def, c);
  return [
    bar(t('arc.stat.damage'), (def.damage * def.pellets * 0.6) / 100, String(def.damage * def.pellets)),
    bar(t('arc.stat.fireRate'), def.rpm / 1000, `${def.rpm}`),
    bar(t('arc.stat.range'), def.range / 100, `${Math.round(def.range * rangeMulFor(def, c))}`),
    bar(t('arc.stat.magazine'), mag / 75, String(mag)),
    bar(t('arc.stat.mobility'), (def.moveSpeed - 0.8) / 0.3, `${Math.round(def.moveSpeed * 100)}%`),
    bar(t('arc.stat.aimSpeed'), (0.5 - ads) / 0.4, `${ads.toFixed(2)}s`),
    bar(t('arc.stat.hipfire'), 1 - hip / 12, `${hip.toFixed(1)}°`),
    bar(t('arc.stat.control'), 1 - kick / 5, `${kick.toFixed(2)}`),
    h('div', { class: 'arc-card-desc', text: `${fireMode(def).toUpperCase()} · zoom ${(1 / opticZoom(def, c.optic)).toFixed(1)}x` }),
  ];
}

interface Item { field: ClassField; id: string; el: HTMLElement; tag: string }

/**
 * Create-a-Class: the player's saved classes (tabs; clicking one equips it), the templates (a preset fills the class
 * being edited), the editor columns (primary, optic, attachments, secondary, two perks) and the stats. The same component
 * runs on the home screen (Bunkhosting shell, with renaming) and in a match (over the HUD). It owns no storage: it
 * reports every change with `onChange` (ClassBookStore saves it, the match sends the equipped class to the server).
 */
export class ClassEditor {
  readonly el: HTMLDivElement;
  /** A new book; `equippedChanged` when the class to play with is another one or was edited. */
  onChange?: (book: ClassBook, equippedChanged: boolean) => void;
  private book: ClassBook;
  private rank: Rank = { level: 1, prestige: 0 };
  private readonly items: Item[] = [];
  private readonly slotEls: HTMLElement[] = [];
  private readonly presetEls = new Map<string, HTMLElement>();
  private nameInput: HTMLInputElement | null = null;
  private statsEl!: HTMLDivElement;
  private lineEl!: HTMLDivElement;

  constructor(book: ClassBook, private readonly opts: { rename: boolean }) {
    this.book = book;
    this.el = h('div', { class: 'cac-editor' });
    this.build();
  }

  /** Builds (or rebuilds after a language change) the whole editor. */
  build(): void {
    this.items.length = 0;
    this.slotEls.length = 0;
    this.presetEls.clear();
    const slots = h('div', { class: 'arc-loadout-cards cac-slots', role: 'tablist', 'aria-label': t('cac.classes') });
    this.book.classes.forEach((_, i) => {
      const b = h('button', { class: 'arc-chip cac-slot', type: 'button', role: 'tab', 'data-slot': String(i) });
      b.addEventListener('click', () => this.equip(i));
      this.slotEls.push(b);
      slots.append(b);
    });
    const presets = h('div', { class: 'arc-loadout-cards presets cac-presets' }, h('span', { class: 'cac-label', text: t('cac.templates') }));
    for (const pr of LOADOUT_PRESETS) {
      const chip = h('button', { class: 'arc-chip cac-preset', type: 'button', 'data-preset': pr.id, title: `${classLine(pr)} · ${perksLine(pr)}: ${t(`arc.class.${pr.id}`, pr.description)}`, text: pr.name });
      chip.addEventListener('click', () => this.loadPreset(pr.id));
      this.presetEls.set(pr.id, chip);
      presets.append(chip);
    }
    let rename: HTMLElement | null = null;
    if (this.opts.rename) {
      this.nameInput = h('input', { class: 'bc-input cac-name', type: 'text', maxLength: CLASS_NAME_MAX, 'aria-label': t('cac.name'), spellcheck: false, autocomplete: 'off' });
      this.nameInput.addEventListener('input', () => this.rename(this.nameInput!.value));
      this.nameInput.addEventListener('blur', () => this.render());
      rename = h('label', { class: 'cac-rename' }, h('span', { class: 'cac-label', text: t('cac.name') }), this.nameInput);
    } else this.nameInput = null;
    this.lineEl = h('div', { class: 'arc-class-line cac-line' });

    // A column holds one or more groups; `title` starts a new section (big head), `head` is a small sub-head within one.
    type Group = { title?: string; head?: string; field: ClassField; ids: readonly string[]; label: (id: string) => string; desc: (id: string) => string; tag?: (id: string) => string };
    const column = (...groups: Group[]) => {
      const col = h('div', { class: 'arc-cac-col', 'data-col': groups[0].field });
      for (const g of groups) {
        if (g.title) col.append(h('div', { class: 'arc-cac-head', text: g.title }));
        if (g.head) col.append(h('div', { class: 'arc-cac-sub', text: g.head }));
        for (const id of g.ids) {
          const tag = g.tag?.(id) ?? '';
          const el = h('div', { class: 'arc-cac-item', role: 'button', tabIndex: 0, title: g.desc(id), 'data-field': g.field, 'data-id': id, 'data-tag': tag },
            h('span', { text: g.label(id) }), h('em', { text: tag }));
          el.addEventListener('click', () => this.edit(g.field, id));
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.edit(g.field, id); } });
          this.items.push({ field: g.field, id, el, tag });
          col.append(el);
        }
      }
      return col;
    };
    const wName = (id: string) => weaponDef(id)!.name;
    const wDesc = (id: string) => t(`arc.role.${id}`, weaponDef(id)!.role);
    const wTag = (id: string) => fireMode(weaponDef(id)!).toUpperCase();
    const attName = (id: string) => (id === 'none' ? t('cac.none') : ATTACHMENTS[id as keyof typeof ATTACHMENTS].name);
    const attDesc = (id: string) => (id === 'none' ? '' : t(`cac.att.${id}` as I18nKey));
    const perkDesc = (id: string) => t(`arc.perk.${id}`, PERKS[id as PerkId].desc);
    const perkTag = (id: string) => { const c = PERKS[id as PerkId].cat; return c ? t(`cac.cat.${c}` as I18nKey) : ''; };
    this.statsEl = h('div', { class: 'arc-cac-stats' });
    const perks = (field: ClassField, title: string, head?: string): Group => ({ title, head, field, ids: PERK_IDS, label: (p) => perkName(p as PerkId), desc: perkDesc, tag: perkTag });
    const editor = h('div', { class: 'arc-cac' },
      column({ title: t('arc.cac.primary'), field: 'primary', ids: PRIMARY_WEAPONS, label: wName, desc: wDesc, tag: wTag }),
      column(
        { title: t('arc.cac.optic'), field: 'optic', ids: Object.keys(OPTICS), label: (o) => OPTICS[o as OpticId].name, desc: (o) => t(`arc.optic.${o}`, OPTICS[o as OpticId].desc) },
        { title: t('arc.cac.secondary'), field: 'secondary', ids: SECONDARY_WEAPONS, label: wName, desc: wDesc, tag: wTag },
      ),
      column(
        { title: t('cac.attachments'), head: t('cac.under'), field: 'under', ids: UNDER_IDS, label: attName, desc: attDesc },
        { head: t('cac.rail'), field: 'rail', ids: RAIL_IDS, label: attName, desc: attDesc },
      ),
      column(perks('perk', t('cac.perk1'))),
      column(perks('perk2', t('cac.perk2short'), t('cac.perk2'))),
      this.statsEl,
    );
    this.el.replaceChildren(slots, h('div', { class: 'cac-bar' }, rename, presets), this.lineEl, editor);
    this.render();
  }

  setBook(b: ClassBook): void {
    this.book = b;
    this.render();
  }

  /** Realms unlocks: items above the player's level are greyed out with the level they need and cannot be picked. */
  setRank(rank: Rank): void {
    this.rank = rank;
    this.render();
  }

  private get current(): SavedClass {
    return this.book.classes[this.book.sel] ?? this.book.classes[0];
  }

  private commit(classes: SavedClass[], sel: number, equippedChanged: boolean): void {
    this.book = { classes, sel };
    this.render();
    this.onChange?.(this.book, equippedChanged);
  }

  /** Clicking a class tab equips it (and shows it in the editor). */
  equip(i: number): void {
    if (i < 0 || i >= this.book.classes.length) return;
    this.commit(this.book.classes, i, i !== this.book.sel);
  }

  private replaceCurrent(c: SavedClass): void {
    const classes = this.book.classes.slice();
    classes[this.book.sel] = c;
    this.commit(classes, this.book.sel, true);
  }

  /** One field of the class being edited; a new primary keeps its optic and attachments only when they fit. */
  edit(field: ClassField, id: string): void {
    if (!this.pickable(field, id)) return;
    const cur = this.current;
    const next: Record<string, unknown> = { ...cur, [field]: id };
    if (field === 'primary') {
      const w = weaponDef(id)!;
      if (!opticAllowed(w, cur.optic)) next.optic = w.optics[0];
    }
    // A first perk from the second perk's category frees the second slot rather than being refused.
    if (field === 'perk' && !perksCompatible(id as PerkId, cur.perk2)) next.perk2 = 'none';
    this.replaceCurrent({ ...validateClass(next), name: cur.name });
  }

  /** A template fills the class being edited (its name too, unless the player named the class). */
  loadPreset(id: string): void {
    const pr = LOADOUT_PRESETS.find((p) => p.id === id);
    if (!pr || !classUnlocked(pr, this.rank)) return;
    const cur = this.current;
    const named = cur.name && !LOADOUT_PRESETS.some((p) => p.name === cur.name);
    this.replaceCurrent({ ...validateClass(pr), name: named ? cur.name : pr.name });
  }

  private rename(v: string): void {
    const name = cleanClassName(v);
    if (name === this.current.name) return;
    const classes = this.book.classes.slice();
    classes[this.book.sel] = { ...this.current, name };
    this.book = { classes, sel: this.book.sel };
    this.slotEls[this.book.sel].replaceChildren(h('b', { text: String(this.book.sel + 1) }), ` ${className(this.current, this.book.sel)}`);
    this.onChange?.(this.book, false);
  }

  /** Whether an item may be picked for the class being edited (unlocked, fits the weapon, perks from two categories). */
  private pickable(field: ClassField, id: string): boolean {
    const c = this.current;
    if (!(id === 'none' && (field === 'under' || field === 'rail' || field === 'perk' || field === 'perk2')) && !isUnlocked(KIND[field], id, this.rank)) return false;
    const w = weaponDef(c.primary)!;
    if (field === 'optic') return opticAllowed(w, id);
    if ((field === 'under' || field === 'rail') && id !== 'none') return attachAllowed(w, id);
    if (field === 'perk2') return id === 'none' || (id !== c.perk && perksCompatible(c.perk, id as PerkId));
    return true;
  }

  /** Draws the state: tabs, templates, selected and disabled items, the class line and the stats. */
  render(): void {
    const c = this.current;
    const w = weaponDef(c.primary)!;
    this.slotEls.forEach((el, i) => {
      const k = this.book.classes[i];
      el.replaceChildren(h('b', { text: String(i + 1) }), ` ${className(k, i)}`);
      el.classList.toggle('selected', i === this.book.sel);
      el.setAttribute('aria-selected', String(i === this.book.sel));
    });
    for (const [id, el] of this.presetEls) el.classList.toggle('locked', !classUnlocked(LOADOUT_PRESETS.find((p) => p.id === id)!, this.rank));
    for (const it of this.items) {
      const open = (it.id === 'none' && it.field !== 'primary') || isUnlocked(KIND[it.field], it.id, this.rank);
      it.el.classList.toggle('locked', !open);
      const em = it.el.querySelector('em');
      if (em) em.textContent = open ? it.tag : t('arc.cac.locked', unlockLevel(KIND[it.field], it.id));
      it.el.classList.toggle('selected', (c as unknown as Record<string, string>)[it.field] === it.id);
      it.el.classList.toggle('disabled', open && !this.pickable(it.field, it.id));
    }
    if (this.nameInput && document.activeElement !== this.nameInput) {
      this.nameInput.value = c.name;
      this.nameInput.placeholder = t('cac.slot', this.book.sel + 1);
    }
    this.lineEl.textContent = `${className(c, this.book.sel)}: ${classLine(c)} · ${perksLine(c)}`;
    this.statsEl.replaceChildren(
      h('div', { class: 'arc-card-name', text: w.name }),
      ...statRows(w, c),
      h('div', { class: 'arc-card-desc role', text: t(`arc.role.${w.id}`, w.role) }),
    );
  }
}
