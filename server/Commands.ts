import { ALL_ITEMS, getItemDef } from '../src/items/ItemRegistry';
import { NAME_PATTERN } from '../src/net/protocol';
import { GAME_MODES, type GameMode } from '../src/player/GameMode';

/** Moderation data of one game; lives in world.json. Names are compared case-insensitively. */
export interface BanEntry { name: string; ipHash?: string; reason: string; by: string; at: number }
export interface Moderation {
  ops: string[];
  bans: BanEntry[];
  whitelist: { on: boolean; names: string[] };
}

export function emptyModeration(): Moderation {
  return { ops: [], bans: [], whitelist: { on: false, names: [] } };
}

export const lc = (name: string): string => name.toLowerCase();

/** Who runs a command. `owner` = holds the owner token (or the server admin token). */
export interface Actor { name: string; op: boolean; owner: boolean }

/** A connected player as the commands see it. */
export interface Target { name: string; op: boolean; owner: boolean; x: number; y: number; z: number }

/** What commands need from the game; implemented by GameServer (and by a stub in the tests). */
export interface CommandHost {
  readonly mod: Moderation;
  /** Arcade game: no time, give, gamemode or weather. */
  readonly arcade: boolean;
  readonly gameMode: GameMode;
  /** Moderation commands exist only when the game has an owner (created through the API) or the server has ops. */
  readonly moderated: boolean;
  online(): Target[];
  find(name: string): Target | null;
  reply(to: string, text: string): void;
  broadcastSystem(text: string): void;
  say(from: string, text: string): void;
  kick(name: string, reason: string): void;
  /** Bans by name and, when the player is online, by address. */
  ban(name: string, by: string, reason: string): void;
  unban(name: string): boolean;
  /** Persists `mod` and tells whoever's status changed. */
  setOp(name: string, op: boolean): void;
  save(): void;
  teleport(name: string, x: number, y: number, z: number): void;
  setGameMode(mode: GameMode): void;
  setTime(time: number): void;
  setWeather?(kind: string): boolean;
  give(name: string, itemId: number, count: number): boolean;
  seed(): number;
  spawn(name: string): void;
}

export const TIME_PRESETS: Record<string, number> = { day: 0.04, noon: 0.25, night: 0.55, midnight: 0.75 };
const WEATHERS = ['clear', 'rain', 'thunder'];

type Level = 'all' | 'op' | 'owner';
interface Def { usage: string; level: Level; run(h: CommandHost, a: Actor, args: string[]): void }

function nameArg(h: CommandHost, a: Actor, args: string[], i = 0): string | null {
  const n = args[i];
  if (!n) { h.reply(a.name, 'Missing player name.'); return null; }
  if (!NAME_PATTERN.test(n)) { h.reply(a.name, `"${n.slice(0, 20)}" is not a valid player name.`); return null; }
  return n;
}

/** Ops cannot act on other ops; only owners can. Nobody can act on an owner but an owner. */
function canTouch(h: CommandHost, a: Actor, target: string): boolean {
  const t = h.find(target);
  const targetIsOp = t?.op ?? h.mod.ops.includes(lc(target));
  if (t?.owner && !a.owner) { h.reply(a.name, `${t.name} is the owner of this game.`); return false; }
  if (targetIsOp && !a.owner) { h.reply(a.name, `Only the owner can do that to an operator.`); return false; }
  return true;
}

/** Resolves an item by id or by name ("stick", "oak planks"). */
export function resolveItem(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    return getItemDef(id) ? id : null;
  }
  const want = raw.toLowerCase().replace(/[\s-]+/g, '_').replace(/^minecraft:/, '');
  for (let id = 1; id < 256; id++) if (getItemDef(id)?.name === want) return id;
  for (const id of ALL_ITEMS) if (getItemDef(id)?.name === want) return id;
  return null;
}

const COMMANDS: Record<string, Def> = {
  help: {
    usage: '/help', level: 'all', run: (h, a) => {
      const list = Object.entries(COMMANDS).filter(([, d]) => allowed(h, a, d)).map(([n, d]) => d.usage.replace(/^\/\S+/, `/${n}`));
      h.reply(a.name, `Commands: ${list.join(', ')}`);
    },
  },
  list: {
    usage: '/list', level: 'all', run: (h, a) => {
      const on = h.online();
      h.reply(a.name, `${on.length} online: ${on.map((p) => p.name).join(', ')}`);
    },
  },
  seed: { usage: '/seed', level: 'all', run: (h, a) => h.reply(a.name, `Seed: [${h.seed()}]`) },
  spawn: {
    usage: '/spawn', level: 'all', run: (h, a) => {
      if (h.arcade) return h.reply(a.name, 'Not available in this game type');
      h.spawn(a.name);
    },
  },
  say: {
    usage: '/say <message>', level: 'op', run: (h, a, args) => {
      if (args.length === 0) return h.reply(a.name, 'Usage: /say <message>');
      h.broadcastSystem(`[${a.name}] ${args.join(' ')}`);
    },
  },
  kick: {
    usage: '/kick <name> [reason]', level: 'op', run: (h, a, args) => {
      const n = nameArg(h, a, args);
      if (!n) return;
      const t = h.find(n);
      if (!t) return h.reply(a.name, `${n} is not online.`);
      if (lc(t.name) === lc(a.name)) return h.reply(a.name, 'You cannot kick yourself.');
      if (!canTouch(h, a, n)) return;
      h.kick(t.name, args.slice(1).join(' ') || 'Kicked by an operator');
      h.broadcastSystem(`${t.name} was kicked by ${a.name}`);
    },
  },
  ban: {
    usage: '/ban <name> [reason]', level: 'op', run: (h, a, args) => {
      const n = nameArg(h, a, args);
      if (!n) return;
      if (lc(n) === lc(a.name)) return h.reply(a.name, 'You cannot ban yourself.');
      if (!canTouch(h, a, n)) return;
      h.ban(n, a.name, args.slice(1).join(' ') || 'Banned by an operator');
      h.broadcastSystem(`${n} was banned by ${a.name}`);
    },
  },
  unban: {
    usage: '/unban <name>', level: 'op', run: (h, a, args) => {
      const n = nameArg(h, a, args);
      if (!n) return;
      h.reply(a.name, h.unban(n) ? `Unbanned ${n}.` : `${n} is not banned.`);
    },
  },
  banlist: {
    usage: '/banlist', level: 'op', run: (h, a) => {
      h.reply(a.name, h.mod.bans.length ? `Banned: ${h.mod.bans.map((b) => b.name).join(', ')}` : 'Nobody is banned.');
    },
  },
  op: {
    usage: '/op <name>', level: 'owner', run: (h, a, args) => {
      const n = nameArg(h, a, args);
      if (!n) return;
      if (h.mod.ops.includes(lc(n))) return h.reply(a.name, `${n} is already an operator.`);
      h.setOp(n, true);
      h.reply(a.name, `${n} is now an operator.`);
    },
  },
  deop: {
    usage: '/deop <name>', level: 'owner', run: (h, a, args) => {
      const n = nameArg(h, a, args);
      if (!n) return;
      if (!h.mod.ops.includes(lc(n))) return h.reply(a.name, `${n} is not an operator.`);
      const t = h.find(n);
      if (t?.owner) return h.reply(a.name, 'The owner always keeps operator rights.');
      h.setOp(n, false);
      h.reply(a.name, `${n} is no longer an operator.`);
    },
  },
  whitelist: {
    usage: '/whitelist add|remove <name> | on | off | list', level: 'op', run: (h, a, args) => {
      const w = h.mod.whitelist;
      switch ((args[0] ?? '').toLowerCase()) {
        case 'on': w.on = true; h.save(); return h.reply(a.name, 'Whitelist is on: only listed players and operators can join.');
        case 'off': w.on = false; h.save(); return h.reply(a.name, 'Whitelist is off.');
        case 'list': return h.reply(a.name, `Whitelist is ${w.on ? 'on' : 'off'}: ${w.names.join(', ') || '(empty)'}`);
        case 'add': {
          const n = nameArg(h, a, args, 1);
          if (!n) return;
          if (!w.names.includes(lc(n))) w.names.push(lc(n));
          h.save();
          return h.reply(a.name, `Added ${n} to the whitelist.`);
        }
        case 'remove': {
          const n = nameArg(h, a, args, 1);
          if (!n) return;
          w.names = w.names.filter((x) => x !== lc(n));
          h.save();
          return h.reply(a.name, `Removed ${n} from the whitelist.`);
        }
        default: return h.reply(a.name, 'Usage: /whitelist add|remove <name> | on | off | list');
      }
    },
  },
  tp: {
    usage: '/tp <name> [to <name>]', level: 'op', run: (h, a, args) => {
      if (h.arcade) return h.reply(a.name, 'Not available in this game type');
      const [first, second] = [args[0], args[1] && args[1].toLowerCase() === 'to' ? args[2] : args[1]];
      const dest = h.find(second ?? first ?? '');
      const mover = second ? h.find(first) : h.find(a.name);
      if (!dest || !mover) return h.reply(a.name, `Player not found. Online: ${h.online().map((p) => p.name).join(', ')}`);
      h.teleport(mover.name, dest.x, dest.y, dest.z);
      h.reply(a.name, `Teleported ${mover.name} to ${dest.name}.`);
    },
  },
  gamemode: {
    usage: '/gamemode survival|creative|hardcore|spectator', level: 'op', run: (h, a, args) => {
      if (h.arcade) return h.reply(a.name, 'Not available in this game type');
      const mode = (args[0] ?? '').toLowerCase() as GameMode;
      if (!GAME_MODES.includes(mode)) return h.reply(a.name, `Usage: /gamemode ${GAME_MODES.join('|')} (applies to everyone in this game)`);
      h.setGameMode(mode);
      h.broadcastSystem(`${a.name} set the game mode to ${mode}`);
    },
  },
  time: {
    usage: '/time set day|noon|night|midnight', level: 'op', run: (h, a, args) => {
      if (h.arcade) return h.reply(a.name, 'The time is fixed in this game type');
      const key = (args[1] ?? '').toLowerCase();
      if (args[0]?.toLowerCase() === 'set' && key in TIME_PRESETS) {
        h.setTime(TIME_PRESETS[key]);
        h.broadcastSystem(`${a.name} set the time to ${key}`);
        return;
      }
      h.reply(a.name, 'Usage: /time set day|noon|night|midnight');
    },
  },
  weather: {
    usage: '/weather clear|rain|thunder', level: 'op', run: (h, a, args) => {
      const kind = (args[0] ?? '').toLowerCase();
      if (!WEATHERS.includes(kind)) return h.reply(a.name, 'Usage: /weather clear|rain|thunder');
      if (!h.setWeather) return h.reply(a.name, 'Weather is not available on this server yet.');
      if (h.setWeather(kind)) h.broadcastSystem(`${a.name} set the weather to ${kind}`);
      else h.reply(a.name, 'Weather is not available in this game type.');
    },
  },
  give: {
    usage: '/give <name> <item> [count]', level: 'op', run: (h, a, args) => {
      if (h.arcade || h.gameMode !== 'creative') return h.reply(a.name, '/give only works in creative games.');
      const n = nameArg(h, a, args);
      if (!n) return;
      const id = resolveItem(args[1] ?? '');
      if (id === null) return h.reply(a.name, `Unknown item "${(args[1] ?? '').slice(0, 24)}". Use its id or name, like stick or oak_planks.`);
      const max = getItemDef(id)?.maxStack ?? 64;
      const count = Math.min(max, Math.max(1, Math.floor(Number(args[2] ?? 1)) || 1));
      if (!h.give(n, id, count)) return h.reply(a.name, `${n} is not online.`);
      h.reply(a.name, `Gave ${count} x ${getItemDef(id)?.displayName ?? id} to ${n}.`);
    },
  },
};

function allowed(h: CommandHost, a: Actor, d: Def): boolean {
  if (d.level === 'all') return true;
  if (!h.moderated) return false;
  return d.level === 'op' ? a.op || a.owner : a.owner;
}

/**
 * Runs a chat command line (starting with "/"). Permissions are checked here, on the server;
 * the client only ever sends the text.
 */
export function runCommand(h: CommandHost, actor: Actor, line: string): void {
  const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
  const name = (cmd ?? '').toLowerCase();
  const def = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!def) return h.reply(actor.name, `Unknown command: /${name.slice(0, 24)}. Type /help for help.`);
  if (!allowed(h, actor, def)) {
    // Rooms from before owners existed keep the old open /time.
    if (name === 'time' && !h.moderated) return COMMANDS.time.run(h, actor, args);
    return h.reply(actor.name, h.moderated ? 'You do not have permission to use that command.' : 'Moderation is not enabled in this game.');
  }
  def.run(h, actor, args);
}
