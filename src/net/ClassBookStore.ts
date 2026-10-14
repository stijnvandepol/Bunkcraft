import { type ClassBook, loadLocalBook, sameBook, sanitizeBook, saveLocalBook } from '../modes/ClassBook';
import { onProfile, saveClasses } from './ProfileApi';

/**
 * The browser side of the Create-a-Class book. A profile's book lives on the server (it follows the player to another
 * browser); this browser keeps a copy in localStorage, which is all a guest (no profile, a server without profiles)
 * has. The first time a profile without classes loads, the browser's book (with the old single custom class migrated
 * into slot 1) is uploaded. Edits save locally at once and to the server shortly after (debounced).
 */
const SAVE_DELAY_MS = 600;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

let book: ClassBook | null = null;
let timer = 0;
let hasProfile = false;
/** An edit waits to be saved: a profile arriving meanwhile carries the older book and must not overwrite it. */
let pending = false;
const listeners = new Set<(b: ClassBook) => void>();

function current(): ClassBook {
  if (!book) {
    book = loadLocalBook(storage());
    onProfile((p) => {
      hasProfile = !!p;
      if (!p) return;
      if (pending) return;
      if (p.classes) {
        const server = sanitizeBook(p.classes);
        if (!sameBook(server, book!)) adopt(server);
      } else schedule();
    });
  }
  return book;
}

function adopt(b: ClassBook): void {
  book = b;
  saveLocalBook(storage(), b);
  for (const fn of listeners) fn(b);
}

function schedule(): void {
  if (!hasProfile || typeof window === 'undefined') return;
  window.clearTimeout(timer);
  pending = true;
  timer = window.setTimeout(() => { void saveClasses(current()).finally(() => { pending = false; }); }, SAVE_DELAY_MS);
}

/** The player's classes (loaded from this browser on first use, then kept in step with the profile). */
export function classBook(): ClassBook {
  return current();
}

/** A changed book (Create-a-Class): saved in this browser now and in the profile shortly after. */
export function setClassBook(b: ClassBook): void {
  current();
  book = sanitizeBook(b);
  saveLocalBook(storage(), book);
  for (const fn of listeners) fn(book);
  schedule();
}

/** Called whenever the book changes (an edit elsewhere, the profile's book arriving). Returns the unsubscribe function. */
export function onClassBook(fn: (b: ClassBook) => void): () => void {
  current();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
