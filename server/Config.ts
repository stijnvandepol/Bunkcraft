import { join, resolve } from 'node:path';
import type { GameMode } from '../src/player/GameMode';
import { parseGameMode } from './GameServer';
import { chunkWorkerCount } from './chunkgen/ChunkGenPool';
import { type BotDifficulty, parseBotDifficulty } from './bots/BotSkill';

/** Everything the server reads from the environment, in one typed place (documented in docs/SERVER.md). */
export interface Config {
  port: number;
  /** Listen address (HOST); unset = every interface. 127.0.0.1 behind a reverse proxy on the same machine. */
  host?: string;
  /** Directory with the built game. */
  staticDir: string;
  dataDir: string;
  trustProxy: boolean;
  /** Use the CF-Connecting-IP header as the client address (TRUST_CLOUDFLARE): only behind a Cloudflare Tunnel. */
  trustCloudflare: boolean;
  /** Addresses/IPv4 CIDRs allowed to send CF-Connecting-IP (TRUSTED_PROXY_ADDRS): the cloudflared host. Default loopback. */
  trustedProxyAddrs: string[];
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
  /** Minutes an empty game stays in memory before it is saved and unloaded (default 5). */
  roomIdleUnloadMin: number;
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
  /** Chunk generation threads (CHUNK_WORKERS): default min(2, cores − 1), 0 = on the main thread. */
  chunkWorkers: number;
  /** Realms quick play lobbies fill with bots up to this many players (QUICKPLAY_BOTS, 0 = off). */
  quickPlayBots: number;
  /** Difficulty of those bots (QUICKPLAY_BOT_DIFFICULTY: easy, normal, hard, veteran). */
  quickPlayBotDifficulty: BotDifficulty;
  /** Build the bots' navigation graphs of every arena in the background at start-up (BOT_PREWARM; off under Vitest). */
  botPrewarm: boolean;
  /** Realms profiles and XP (PROFILES, default on). */
  profiles: boolean;
  /** Most profiles kept in DATA_DIR/profiles (MAX_PROFILES). */
  maxProfiles: number;
  /** New profiles per client address per hour (PROFILE_CREATE_LIMIT). */
  profileCreateLimit: number;
  /** HMAC secret for profile tokens (PROFILE_SECRET); unset = DATA_DIR/profiles/secret.key. */
  profileSecret?: string;
  /** Player accounts: username + password on top of profiles (ACCOUNTS, default on; needs profiles). */
  accounts: boolean;
  /** Most accounts kept in DATA_DIR/accounts (MAX_ACCOUNTS). */
  maxAccounts: number;
  /** New accounts per client address per hour (ACCOUNT_REGISTER_LIMIT). */
  accountRegisterLimit: number;
  /** Days a login stays valid without use (ACCOUNT_SESSION_DAYS). */
  accountSessionDays: number;
  /** Custom player skins (SKINS, default on; needs profiles). Content moderation is the operator's job (docs/SERVER.md). */
  skins: boolean;
  /** Most megabytes of skin files kept in DATA_DIR/skins (SKIN_STORAGE_MB). */
  skinStorageMb: number;
  /** Skin uploads per profile per hour (SKIN_UPLOAD_LIMIT). */
  skinUploadLimit: number;
  /** Seconds an arcade game keeps a dropped player's seat, score and match XP for a rejoin (REJOIN_GRACE_SEC, default 120, 0 = off). */
  rejoinGraceSec: number;
  /** Parties: friends queue together (PARTIES, default on; needs games). */
  parties: boolean;
  /** Most parties alive at once (MAX_PARTIES). */
  maxParties: number;
  /** New parties per client address per hour (PARTY_CREATE_LIMIT). */
  partyCreateLimit: number;
  /** What this process is (ROLE): the full server (control plane) or a match runner started for one arena lobby. */
  role: 'server' | 'match';
  /** Where arena matches run (MATCH_ISOLATION): in this process (default) or one container per lobby. */
  matchIsolation: 'inprocess' | 'container';
  /** How match runners are started (MATCH_DRIVER): Docker containers, or plain child processes (development, tests). */
  matchDriver: 'docker' | 'process';
  /** Docker Engine API of the socket proxy (DOCKER_HOST): http://host:port, or unix:///path for a local smoke test. */
  dockerHost: string;
  /** Image for match containers (MATCH_IMAGE); empty = the image of this container (looked up at start-up). */
  matchImage: string;
  /** Docker network match containers join (MATCH_NETWORK): internal, no route to the internet. */
  matchNetwork: string;
  /** Per match container: CPUs (MATCH_CPUS), memory in MiB (MATCH_MEMORY, "256m" style accepted), processes (MATCH_PIDS). */
  matchCpus: number;
  matchMemoryMb: number;
  matchPids: number;
  /** Idle match runners kept ready so quick play starts at once (MATCH_WARM_POOL). */
  matchWarmPool: number;
  /** Most match runners at once, warm ones included (MAX_MATCH_CONTAINERS); above it new lobbies run in this process. */
  maxMatchContainers: number;
  /** Seconds an empty match container (no players, no kept or held seats) lives on (MATCH_IDLE_GRACE_SEC). */
  matchIdleGraceSec: number;
  /** Shared secret of the internal API (MATCH_SECRET); unset = DATA_DIR/match-secret.key. Runners only get a key derived from it. */
  matchSecret?: string;
  /** Internal API of the control plane for match runners (INTERNAL_PORT, INTERNAL_HOST): never published. */
  internalPort: number;
  internalHost: string;
  /** How runners reach that API (CONTROL_URL), e.g. http://bunkcraft:3001 on the internal network. */
  controlUrl: string;
  /** Label put on (and required of) every match container, so the control plane never touches other containers (MATCH_OWNER). */
  matchOwner: string;
  /** Match runner only: its id, its key and the port it listens on (set by the control plane, never by hand). */
  matchId: string;
  matchToken: string;
  matchPort: number;
}

const flag = (v: string | undefined, dflt: boolean): boolean => (v === undefined || v === '' ? dflt : !/^(0|off|false|no)$/i.test(v));
const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : dflt;
};
/** "256m", "1g", "512" (MiB) → MiB. */
export function parseMemoryMb(v: string | undefined, dflt: number): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)b?\s*$/i.exec(v ?? '');
  if (!m) return dflt;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return Math.round(unit === 'g' ? n * 1024 : unit === 'k' ? n / 1024 : n);
}
const list = (v: string | undefined): string[] => (v ?? '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const guard = (env.INVENTORY_GUARD ?? 'enforce').toLowerCase();
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || undefined,
    staticDir: resolve(env.STATIC_DIR ?? 'dist'),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    trustProxy: flag(env.TRUST_PROXY, false),
    trustCloudflare: flag(env.TRUST_CLOUDFLARE, false),
    trustedProxyAddrs: list(env.TRUSTED_PROXY_ADDRS).length ? list(env.TRUSTED_PROXY_ADDRS) : ['127.0.0.1', '::1'],
    mainWorld: flag(env.MAIN_WORLD, true),
    roomsEnabled: flag(env.ROOMS, true),
    worldName: env.WORLD_NAME ?? 'BunkCraft Server',
    seed: env.SEED,
    gameMode: parseGameMode(env.GAMEMODE),
    motd: env.MOTD ?? 'Welcome to BunkCraft!',
    maxPlayers: num(env.MAX_PLAYERS, 20),
    maxRooms: num(env.MAX_ROOMS, 200),
    roomMaxPlayers: num(env.ROOM_MAX_PLAYERS, 12),
    roomExpireDays: num(env.ROOM_EXPIRE_DAYS, 60),
    roomIdleUnloadMin: Math.max(0.1, num(env.ROOM_IDLE_UNLOAD_MIN, 5)),
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
    chunkWorkers: chunkWorkerCount(env.CHUNK_WORKERS),
    quickPlayBots: Math.max(0, Math.floor(num(env.QUICKPLAY_BOTS, 8))),
    quickPlayBotDifficulty: parseBotDifficulty(env.QUICKPLAY_BOT_DIFFICULTY?.toLowerCase()) ?? 'normal',
    botPrewarm: flag(env.BOT_PREWARM, !env.VITEST),
    profiles: flag(env.PROFILES, true),
    maxProfiles: Math.max(0, Math.floor(num(env.MAX_PROFILES, 50_000))),
    profileCreateLimit: Math.max(1, Math.floor(num(env.PROFILE_CREATE_LIMIT, 10))),
    profileSecret: env.PROFILE_SECRET || undefined,
    accounts: flag(env.ACCOUNTS, true),
    maxAccounts: Math.max(0, Math.floor(num(env.MAX_ACCOUNTS, 20_000))),
    accountRegisterLimit: Math.max(1, Math.floor(num(env.ACCOUNT_REGISTER_LIMIT, 5))),
    accountSessionDays: Math.max(1, Math.min(365, num(env.ACCOUNT_SESSION_DAYS, 30))),
    skins: flag(env.SKINS, true),
    skinStorageMb: Math.max(1, num(env.SKIN_STORAGE_MB, 128)),
    skinUploadLimit: Math.max(1, Math.floor(num(env.SKIN_UPLOAD_LIMIT, 5))),
    rejoinGraceSec: Math.max(0, Math.min(3600, num(env.REJOIN_GRACE_SEC, 120))),
    parties: flag(env.PARTIES, true),
    maxParties: Math.max(1, Math.floor(num(env.MAX_PARTIES, 2000))),
    partyCreateLimit: Math.max(1, Math.floor(num(env.PARTY_CREATE_LIMIT, 20))),
    role: env.ROLE === 'match' ? 'match' : 'server',
    matchIsolation: env.MATCH_ISOLATION === 'container' ? 'container' : 'inprocess',
    matchDriver: env.MATCH_DRIVER === 'process' ? 'process' : 'docker',
    dockerHost: env.DOCKER_HOST || 'http://docker-proxy:2375',
    matchImage: env.MATCH_IMAGE ?? '',
    matchNetwork: env.MATCH_NETWORK || 'bunkcraft_match',
    matchCpus: Math.max(0.1, Math.min(8, num(env.MATCH_CPUS, 1))),
    matchMemoryMb: Math.max(96, Math.min(4096, parseMemoryMb(env.MATCH_MEMORY, 256))),
    matchPids: Math.max(16, Math.min(1024, Math.floor(num(env.MATCH_PIDS, 64)))),
    matchWarmPool: Math.max(0, Math.min(16, Math.floor(num(env.MATCH_WARM_POOL, 1)))),
    maxMatchContainers: Math.max(1, Math.min(256, Math.floor(num(env.MAX_MATCH_CONTAINERS, 16)))),
    matchIdleGraceSec: Math.max(5, Math.min(3600, num(env.MATCH_IDLE_GRACE_SEC, 30))),
    matchSecret: env.MATCH_SECRET || undefined,
    internalPort: num(env.INTERNAL_PORT, 3001),
    internalHost: env.INTERNAL_HOST || '0.0.0.0',
    controlUrl: env.CONTROL_URL || 'http://bunkcraft:3001',
    matchOwner: (env.MATCH_OWNER || 'bunkcraft').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 63) || 'bunkcraft',
    matchId: env.MATCH_ID ?? '',
    matchToken: env.MATCH_TOKEN ?? '',
    matchPort: num(env.MATCH_PORT, 3100),
  };
}

export const backupDirOf = (c: Config): string => join(c.dataDir, 'backups');
