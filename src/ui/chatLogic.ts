/**
 * Pure chat logic (no DOM): input history with Up/Down, `/` command completion and Minecraft colour codes.
 * The usage strings mirror `server/Commands.ts` (`/help` data); tests/chatLogic.test.ts keeps both in sync.
 */

/** Command name → usage line, as the server's /help prints them. */
export const SERVER_COMMAND_USAGE: Readonly<Record<string, string>> = {
  help: '/help',
  list: '/list',
  seed: '/seed',
  spawn: '/spawn',
  say: '/say <message>',
  kick: '/kick <name> [reason]',
  ban: '/ban <name> [reason]',
  unban: '/unban <name>',
  banlist: '/banlist',
  op: '/op <name>',
  deop: '/deop <name>',
  whitelist: '/whitelist add|remove <name> | on | off | list',
  tp: '/tp <name> [to <name>]',
  gamemode: '/gamemode survival|creative|hardcore|spectator',
  time: '/time set day|noon|night|midnight',
  weather: '/weather clear|rain|thunder [seconds]',
  difficulty: '/difficulty [peaceful|easy|normal|hard]',
  gamerule: '/gamerule <rule> [value]',
  spawnpoint: '/spawnpoint [name]',
  effect: '/effect give <name> <effect> [seconds] [level] | /effect clear <name> [effect]',
  give: '/give <name> <item> [count]',
};

/** Singleplayer has no server: only the commands the game runs locally. */
export const LOCAL_COMMAND_USAGE: Readonly<Record<string, string>> = {
  help: '/help',
  weather: SERVER_COMMAND_USAGE.weather,
  difficulty: SERVER_COMMAND_USAGE.difficulty,
  gamerule: SERVER_COMMAND_USAGE.gamerule,
  spawnpoint: SERVER_COMMAND_USAGE.spawnpoint,
  effect: SERVER_COMMAND_USAGE.effect,
};

/**
 * Completion candidates for the text typed so far. `/we` gives `/weather`; after a command name the fixed words of its
 * usage (`/weather ` gives clear, rain, thunder). Returns full replacement strings, sorted, at most `max` of them.
 */
export function suggestCommands(input: string, usage: Readonly<Record<string, string>> = SERVER_COMMAND_USAGE, max = 10): string[] {
  if (!input.startsWith('/')) return [];
  const parts = input.slice(1).split(' ');
  const first = parts[0].toLowerCase();
  if (parts.length === 1) {
    return Object.keys(usage).filter((n) => n.startsWith(first)).sort().slice(0, max).map((n) => `/${n}`);
  }
  const line = usage[first];
  if (!line) return [];
  // Optional fixed words ("[peaceful|easy]") complete like required ones.
  const slot = line.split(' ').slice(1)[parts.length - 2]?.replace(/^\[(.*)\]$/, '$1');
  if (!slot || !/^[a-z]+(\|[a-z]+)+$/.test(slot) && !/^[a-z]+$/.test(slot)) return [];
  const typed = parts[parts.length - 1].toLowerCase();
  const prefix = input.slice(0, input.length - typed.length);
  return slot.split('|').filter((w) => w.startsWith(typed) && w !== typed).sort().slice(0, max).map((w) => prefix + w);
}

/** The longest text all candidates start with (Tab fills in as much as is certain). */
export function commonPrefix(items: readonly string[]): string {
  if (items.length === 0) return '';
  let p = items[0];
  for (const s of items) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/** Sent messages, oldest first. Up/Down walk through them like Minecraft; the half-typed line is kept as a draft. */
export class ChatHistory {
  private readonly items: string[] = [];
  private cursor = -1;
  private draft = '';

  constructor(private readonly limit = 100) {}

  get length(): number {
    return this.items.length;
  }

  /** Remember a sent line (consecutive duplicates are stored once) and reset navigation. */
  push(text: string): void {
    const t = text.trim();
    if (t && this.items[this.items.length - 1] !== t) {
      this.items.push(t);
      if (this.items.length > this.limit) this.items.shift();
    }
    this.reset();
  }

  reset(): void {
    this.cursor = -1;
    this.draft = '';
  }

  /** Up: an older line; `current` is stored as the draft on the first step. Stays on the oldest at the end. */
  up(current: string): string {
    if (this.items.length === 0) return current;
    if (this.cursor === -1) {
      this.draft = current;
      this.cursor = this.items.length - 1;
    } else if (this.cursor > 0) this.cursor--;
    return this.items[this.cursor];
  }

  /** Down: a newer line, then the draft again. */
  down(current: string): string {
    if (this.cursor === -1) return current;
    if (this.cursor < this.items.length - 1) return this.items[++this.cursor];
    this.cursor = -1;
    return this.draft;
  }
}

/** Minecraft's formatting colours (§0-§f). */
export const CHAT_COLORS: Readonly<Record<string, string>> = {
  '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa', '4': '#aa0000', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa',
  '8': '#555555', '9': '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};

export interface ChatSegment { text: string; color: string | null }

/** Splits `§c`-style colour codes into coloured segments; with `colors` off the codes are stripped (Chat Settings > Colors). */
export function parseChatColors(text: string, colors = true): ChatSegment[] {
  const out: ChatSegment[] = [];
  let color: string | null = null;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, color: colors ? color : null });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '§' && i + 1 < text.length) {
      const code = text[i + 1].toLowerCase();
      if (code in CHAT_COLORS || code === 'r') {
        flush();
        color = code === 'r' ? null : CHAT_COLORS[code];
        i++;
        continue;
      }
    }
    buf += text[i];
  }
  flush();
  return out;
}
