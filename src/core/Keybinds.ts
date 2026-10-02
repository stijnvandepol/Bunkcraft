/**
 * Rebindable controls, modelled on Minecraft Java 1.21's Key Binds screen.
 *
 * A binding is a `KeyboardEvent.code` (e.g. "KeyW", "ShiftLeft") or a mouse button
 * written as "Mouse<button>" ("Mouse0" = left, "Mouse1" = middle, "Mouse2" = right,
 * "Mouse3"/"Mouse4" = side buttons). An empty string means "Not Bound".
 *
 * Only actions the game implements are listed. F1 (hide HUD), F3 (debug) and Escape stay
 * fixed, as in Minecraft.
 */

export type KeybindCategory = 'Movement' | 'Gameplay' | 'Inventory' | 'Multiplayer' | 'Arcade';

export interface KeybindDef {
  /** Minecraft's option id, also the storage key in settings. */
  readonly id: string;
  readonly name: string;
  readonly category: KeybindCategory;
  readonly defaultCode: string;
  /**
   * Actions that only exist in one kind of game (the Minecraft sandbox or the arcade shooters).
   * The same key may be bound to a sandbox-only and an arcade-only action without a conflict.
   */
  readonly scope?: 'sandbox' | 'arcade';
}

/** Action indices into {@link KEYBINDS} and the resolved bindings array. */
export const KB = {
  FORWARD: 0,
  BACK: 1,
  LEFT: 2,
  RIGHT: 3,
  JUMP: 4,
  SNEAK: 5,
  SPRINT: 6,
  ATTACK: 7,
  USE: 8,
  PICK: 9,
  DROP: 10,
  INVENTORY: 11,
  /** Hotbar Slot 1; slots 2–9 follow consecutively. */
  HOTBAR_1: 12,
  CHAT: 21,
  COMMAND: 22,
  /** Arcade game types. Fire and aim reuse ATTACK and USE. */
  RELOAD: 23,
  SCOREBOARD: 24,
  LOADOUT: 25,
  WEAPON_1: 26,
  WEAPON_2: 27,
  WEAPON_3: 28,
  QUICK_SWITCH: 29,
} as const;

const hotbar: KeybindDef[] = [];
for (let i = 1; i <= 9; i++) hotbar.push({ id: `key.hotbar.${i}`, name: `Hotbar Slot ${i}`, category: 'Inventory', defaultCode: `Digit${i}`, scope: 'sandbox' });

/**
 * Every rebindable action, in {@link KB} index order. Defaults keep BunkCraft's existing
 * controls where they differ from Minecraft: Sprint on Left Shift, Sneak (fly down) on C.
 */
export const KEYBINDS: readonly KeybindDef[] = [
  { id: 'key.forward', name: 'Walk Forwards', category: 'Movement', defaultCode: 'KeyW' },
  { id: 'key.back', name: 'Walk Backwards', category: 'Movement', defaultCode: 'KeyS' },
  { id: 'key.left', name: 'Strafe Left', category: 'Movement', defaultCode: 'KeyA' },
  { id: 'key.right', name: 'Strafe Right', category: 'Movement', defaultCode: 'KeyD' },
  { id: 'key.jump', name: 'Jump', category: 'Movement', defaultCode: 'Space' },
  { id: 'key.sneak', name: 'Sneak', category: 'Movement', defaultCode: 'KeyC' },
  { id: 'key.sprint', name: 'Sprint', category: 'Movement', defaultCode: 'ShiftLeft' },
  { id: 'key.attack', name: 'Attack/Destroy', category: 'Gameplay', defaultCode: 'Mouse0' },
  { id: 'key.use', name: 'Use Item/Place Block', category: 'Gameplay', defaultCode: 'Mouse2' },
  { id: 'key.pickItem', name: 'Pick Block', category: 'Gameplay', defaultCode: 'Mouse1', scope: 'sandbox' },
  { id: 'key.drop', name: 'Drop Selected Item', category: 'Inventory', defaultCode: 'KeyQ', scope: 'sandbox' },
  { id: 'key.inventory', name: 'Open/Close Inventory', category: 'Inventory', defaultCode: 'KeyE', scope: 'sandbox' },
  ...hotbar,
  { id: 'key.chat', name: 'Open Chat', category: 'Multiplayer', defaultCode: 'KeyT' },
  { id: 'key.command', name: 'Open Command', category: 'Multiplayer', defaultCode: 'Slash' },
  { id: 'key.arcade.reload', name: 'Reload', category: 'Arcade', defaultCode: 'KeyR', scope: 'arcade' },
  { id: 'key.arcade.scoreboard', name: 'Scoreboard (Hold)', category: 'Arcade', defaultCode: 'Tab', scope: 'arcade' },
  { id: 'key.arcade.loadout', name: 'Loadout Menu', category: 'Arcade', defaultCode: 'KeyB', scope: 'arcade' },
  { id: 'key.arcade.weapon1', name: 'Primary Weapon', category: 'Arcade', defaultCode: 'Digit1', scope: 'arcade' },
  { id: 'key.arcade.weapon2', name: 'Secondary Weapon', category: 'Arcade', defaultCode: 'Digit2', scope: 'arcade' },
  { id: 'key.arcade.weapon3', name: 'Melee Weapon', category: 'Arcade', defaultCode: 'Digit3', scope: 'arcade' },
  { id: 'key.arcade.quickSwitch', name: 'Quick Switch Weapon', category: 'Arcade', defaultCode: 'KeyQ', scope: 'arcade' },
];

export const KEYBIND_CATEGORIES: readonly KeybindCategory[] = ['Movement', 'Gameplay', 'Inventory', 'Multiplayer', 'Arcade'];

/** Keys with a fixed meaning that cannot be bound (Escape cancels/unbinds while listening). */
export const RESERVED_CODES: ReadonlySet<string> = new Set(['Escape', 'F1', 'F3']);

/** Stored form: action id → code. */
export type KeybindMap = Record<string, string>;

export function defaultKeybinds(): KeybindMap {
  const m: KeybindMap = {};
  for (const k of KEYBINDS) m[k.id] = k.defaultCode;
  return m;
}

const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export function isValidCode(code: unknown): code is string {
  return typeof code === 'string' && (code === '' || (CODE_PATTERN.test(code) && !RESERVED_CODES.has(code)));
}

/** A complete map from untrusted stored data: unknown ids are dropped, missing or invalid ones get the default. */
export function sanitizeKeybinds(raw: unknown): KeybindMap {
  const m = defaultKeybinds();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    for (const k of KEYBINDS) {
      if (Object.prototype.hasOwnProperty.call(r, k.id) && isValidCode(r[k.id])) m[k.id] = r[k.id] as string;
    }
  }
  return m;
}

/** Bindings as an array in {@link KB} order, for allocation-free lookups in the game loop. */
export function resolveKeybinds(map: KeybindMap): string[] {
  return KEYBINDS.map((k) => map[k.id] ?? k.defaultCode);
}

/** Do two actions ever exist in the same game? Sandbox-only and arcade-only actions never do. */
function sharesGame(a: KeybindDef, b: KeybindDef): boolean {
  return !a.scope || !b.scope || a.scope === b.scope;
}

/** Indices (in {@link KB} order) of actions whose code is also used by another action of the same game. */
export function conflictingActions(map: KeybindMap): Set<number> {
  const bad = new Set<number>();
  KEYBINDS.forEach((a, i) => {
    const code = map[a.id];
    if (!code) return;
    for (let j = i + 1; j < KEYBINDS.length; j++) {
      if (map[KEYBINDS[j].id] === code && sharesGame(a, KEYBINDS[j])) {
        bad.add(i);
        bad.add(j);
      }
    }
  });
  return bad;
}

const NAMED: Record<string, string> = {
  Mouse0: 'Left Button', Mouse1: 'Middle Button', Mouse2: 'Right Button',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps Lock',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Control', ControlRight: 'Right Control',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Win', MetaRight: 'Right Win',
  ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
  ContextMenu: 'Menu', PrintScreen: 'Print Screen', ScrollLock: 'Scroll Lock', Pause: 'Pause', NumLock: 'Num Lock',
  Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', IntlBackslash: '\\',
  NumpadAdd: 'Keypad +', NumpadSubtract: 'Keypad -', NumpadMultiply: 'Keypad *', NumpadDivide: 'Keypad /',
  NumpadDecimal: 'Keypad Decimal', NumpadEnter: 'Keypad Enter', NumpadEqual: 'Keypad =',
};

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Minecraft-style display name for a code ("Left Shift", "Left Button", "W"). */
export function keyDisplayName(code: string): string {
  if (code === '') return 'Not Bound';
  if (IS_MAC && code === 'MetaLeft') return 'Left Cmd';
  if (IS_MAC && code === 'MetaRight') return 'Right Cmd';
  if (IS_MAC && code === 'AltLeft') return 'Left Option';
  if (IS_MAC && code === 'AltRight') return 'Right Option';
  const named = NAMED[code];
  if (named) return named;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `Keypad ${m[1]}`;
  m = /^Mouse([0-9]+)$/.exec(code);
  if (m) return `Button ${Number(m[1]) + 1}`;
  return code;
}
