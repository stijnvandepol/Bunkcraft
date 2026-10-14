import {
  type ClassSpec, CLASS_STORAGE_KEY, DEFAULT_CLASS, LAST_CLASS_STORAGE_KEY, LOADOUT_PRESETS, loadSavedClass, sameClass, validateClass,
} from './Loadouts';

/**
 * The player's saved classes (Create-a-Class): CLASS_SLOTS named classes and which one is equipped. The server keeps
 * it in the Realms profile (server/progression, POST /api/profile/classes); a guest without a profile keeps it in this
 * browser only. One sanitiser for both sides: whatever arrives (a file, a request, localStorage) becomes a book of
 * exactly CLASS_SLOTS valid classes.
 */
export const CLASS_SLOTS = 5;
/** Longest class name (characters). */
export const CLASS_NAME_MAX = 20;
/** Largest class book a request may carry (bytes of JSON): five full classes with long names stay far below it. */
export const CLASS_BOOK_MAX_BYTES = 2048;
/** localStorage key of the class book (guests, and the offline copy of a profile's book). */
export const CLASS_BOOK_STORAGE_KEY = 'bunkcraft.arcadeClasses';

export interface SavedClass extends ClassSpec {
  /** The player's name for it; '' = the default label ("Class 1"). */
  name: string;
}

export interface ClassBook {
  classes: SavedClass[];
  /** Index of the equipped class (0..CLASS_SLOTS-1). */
  sel: number;
}

/** Letters, digits, spaces and a little punctuation; trimmed, cut to CLASS_NAME_MAX. Anything else is dropped. */
export function cleanClassName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\p{L}\p{N} _.'!#&()+-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, CLASS_NAME_MAX);
}

/** The starting book: the level-1 presets, then two copies of the default class. */
export function defaultBook(): ClassBook {
  const starters = ['assault', 'breacher', 'scout'].map((id) => LOADOUT_PRESETS.find((p) => p.id === id)!);
  const classes: SavedClass[] = [];
  for (let i = 0; i < CLASS_SLOTS; i++) {
    const p = starters[i];
    classes.push(p ? { ...validateClass(p), name: p.name } : { ...DEFAULT_CLASS, name: '' });
  }
  return { classes, sel: 0 };
}

/** A clean book from anything: a list cut or padded to CLASS_SLOTS, every class validated, the selection in range. */
export function sanitizeBook(raw: unknown): ClassBook {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.classes) ? r.classes : [];
  const base = defaultBook();
  const classes = base.classes.map((d, i) => {
    const c = list[i];
    if (!c || typeof c !== 'object') return d;
    return { ...validateClass(c), name: cleanClassName((c as Record<string, unknown>).name) };
  });
  const sel = typeof r.sel === 'number' && Number.isInteger(r.sel) && r.sel >= 0 && r.sel < CLASS_SLOTS ? r.sel : 0;
  return { classes, sel };
}

/**
 * Whether a request body has the shape of a class book (the server's check before it stores one): an object with a
 * `classes` list of at most CLASS_SLOTS objects, a whole-number `sel`, no other keys, and small. The fields inside
 * are then cleaned by `sanitizeBook` (an unknown weapon becomes the default, like everywhere else).
 */
export function bookShapeOk(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'classes' && k !== 'sel')) return false;
  if (!Array.isArray(r.classes) || r.classes.length > CLASS_SLOTS) return false;
  if (r.sel !== undefined && (typeof r.sel !== 'number' || !Number.isInteger(r.sel) || r.sel < 0 || r.sel >= CLASS_SLOTS)) return false;
  for (const c of r.classes) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    for (const v of Object.values(c as Record<string, unknown>)) if (typeof v !== 'string') return false;
  }
  try {
    return JSON.stringify(raw).length <= CLASS_BOOK_MAX_BYTES;
  } catch {
    return false;
  }
}

/** The equipped class of a book. */
export function equipped(b: ClassBook): SavedClass {
  return b.classes[b.sel] ?? b.classes[0];
}

/** Two books with the same classes, names and selection. */
export function sameBook(a: ClassBook, b: ClassBook): boolean {
  return a.sel === b.sel && a.classes.length === b.classes.length
    && a.classes.every((c, i) => c.name === b.classes[i].name && sameClass(c, b.classes[i]));
}

/**
 * The book from this browser's storage. Without a saved book, the old single custom class (before multiple classes)
 * moves into slot 1; a class picked last that was not the custom one (a preset) goes into slot 2 and stays equipped.
 */
export function loadLocalBook(storage: Pick<Storage, 'getItem'> | null): ClassBook {
  try {
    const raw = storage?.getItem(CLASS_BOOK_STORAGE_KEY);
    if (raw) return sanitizeBook(JSON.parse(raw));
  } catch { /* broken JSON or blocked storage: migrate or start fresh */ }
  return migrateBook(loadSavedClass(storage), loadSavedClass(storage, LAST_CLASS_STORAGE_KEY));
}

/** The book for an old single custom class and the class picked last (either may be absent). */
export function migrateBook(custom: ClassSpec | null, last: ClassSpec | null): ClassBook {
  const b = defaultBook();
  if (custom) b.classes[0] = { ...validateClass(custom), name: '' };
  if (!last) return b;
  const have = b.classes.findIndex((c) => sameClass(c, validateClass(last)));
  if (have >= 0) b.sel = have;
  else {
    const p = LOADOUT_PRESETS.find((x) => sameClass(x, last));
    b.classes[1] = { ...validateClass(last), name: p?.name ?? '' };
    b.sel = 1;
  }
  return b;
}

export function saveLocalBook(storage: Pick<Storage, 'setItem'> | null, b: ClassBook): void {
  try {
    storage?.setItem(CLASS_BOOK_STORAGE_KEY, JSON.stringify(b));
  } catch { /* private mode, quota: the classes last for this visit */ }
}

export { CLASS_STORAGE_KEY, LAST_CLASS_STORAGE_KEY };
