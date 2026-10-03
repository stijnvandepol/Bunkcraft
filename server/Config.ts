import { join, resolve } from 'node:path';
import type { GameMode } from '../src/player/GameMode';
import { parseGameMode } from './GameServer';

/** Everything the server reads from the environment, in one typed place (documented in docs/SERVER.md). */
export interface Config {
  port: number;
  /** Directory with the built game. */
  staticDir: string;
  dataDir: string;
  trustProxy: boolean;
  mainWorld: boolean;
  roomsEnabled: boolean;
  worldName: string;
  seed?: string;
  gameMode: GameMode;
  motd: string;
  maxPlayers: number;
  maxRooms: number;
  roomMaxPlayers: number;
  roomExpireDays: number;
  roomCreateLimit: number;
  /** Bearer token for /api/admin/* and /admin; unset = admin API disabled. */
  adminToken?: string;
  /** Bearer token for /metrics; unset = loopback only (or the admin token when that is set). */
  metricsToken?: string;
  /** Names that are operators of the main world. */
  ops: string[];
  /** WebSocket Origin allow-list (and CORS for the API); empty = any origin. */
  allowedOrigins: string[];
  maxConnections: number;
  maxConnPerIp: number;
  /** Keep this many backups per world (0 = no backups). */
  backupKeep: number;
  backupIntervalMin: number;
  inventoryGuard: 'enforce' | 'warn' | 'off';
  binary: boolean;
  /** Public server list size. */
  listMax: number;
  /** Max wrong passwords per address per 10 minutes. */
  passwordFailLimit: number;
  /** Milliseconds clients are told to wait before reconnecting after a restart. */
  reconnectHintMs: number;
}

const flag = (v: string | undefined, dflt: boolean): boolean => (v === undefined || v === '' ? dflt : !/^(0|off|false|no)$/i.test(v));
const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : dflt;
};
const list = (v: string | undefined): string[] => (v ?? '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const guard = (env.INVENTORY_GUARD ?? 'enforce').toLowerCase();
  return {
    port: num(env.PORT, 3000),
    staticDir: resolve(env.STATIC_DIR ?? 'dist'),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    trustProxy: flag(env.TRUST_PROXY, false),
    mainWorld: flag(env.MAIN_WORLD, true),
    roomsEnabled: flag(env.ROOMS, true),
    worldName: env.WORLD_NAME ?? 'BunkCraft Server',
    seed: env.SEED,
    gameMode: parseGameMode(env.GAMEMODE),
    motd: env.MOTD ?? 'Welcome to BunkCraft!',
    maxPlayers: num(env.MAX_PLAYERS, 20),
    maxRooms: num(env.MAX_ROOMS, 200),
    roomMaxPlayers: num(env.ROOM_MAX_PLAYERS, 8),
    roomExpireDays: num(env.ROOM_EXPIRE_DAYS, 60),
    roomCreateLimit: num(env.ROOM_CREATE_LIMIT, 6),
    adminToken: env.ADMIN_TOKEN || undefined,
    metricsToken: env.METRICS_TOKEN || undefined,
    ops: list(env.OPS),
    allowedOrigins: list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '').toLowerCase()),
    maxConnections: num(env.MAX_CONNECTIONS, 500),
    maxConnPerIp: num(env.MAX_CONN_PER_IP, 10),
    backupKeep: Math.max(0, Math.floor(num(env.BACKUP_KEEP, 12))),
    backupIntervalMin: Math.max(1, num(env.BACKUP_INTERVAL_MIN, 60)),
    inventoryGuard: guard === 'off' || guard === 'warn' ? guard : 'enforce',
    binary: flag(env.BINARY_PROTOCOL, true),
    listMax: num(env.LIST_MAX, 50),
    passwordFailLimit: num(env.PASSWORD_FAIL_LIMIT, 5),
    reconnectHintMs: num(env.RECONNECT_HINT_MS, 8000),
  };
}

export const backupDirOf = (c: Config): string => join(c.dataDir, 'backups');
