/**
 * BunkCraft server: serves the built game (dist/) and hosts multiplayer on the same port.
 *
 *   npm run build && npm start
 *
 * Multiplayer: players create their own game (room) from the menu and share its code or
 * link; rooms live at /ws/<CODE>. /ws (no code) is the optional always-on main world.
 *
 * The server itself is in App.ts and every setting in Config.ts (documented in docs/SERVER.md):
 * PORT, DATA_DIR, TRUST_PROXY, TRUST_CLOUDFLARE, MAIN_WORLD, WORLD_NAME, SEED, GAMEMODE, MOTD, MAX_PLAYERS, ROOMS, MAX_ROOMS,
 * ROOM_MAX_PLAYERS, ROOM_EXPIRE_DAYS, ROOM_CREATE_LIMIT, ADMIN_TOKEN, METRICS_TOKEN, OPS, ALLOWED_ORIGINS,
 * MAX_CONNECTIONS, MAX_CONN_PER_IP, BACKUP_KEEP, BACKUP_INTERVAL_MIN, INVENTORY_GUARD, BINARY_PROTOCOL,
 * LOG_LEVEL, LOG_FORMAT.
 */
import { startServer } from './App';
import { loadConfig } from './Config';
import { log } from './Log';

const config = loadConfig();

startServer(config).then((server) => {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down: saving games and telling players to reconnect', { signal });
    // Clients get a reconnect hint: with a restart (Docker, systemd) they are back within seconds.
    const hard = setTimeout(() => process.exit(1), 5000);
    hard.unref();
    server.close(config.reconnectHintMs).then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}, (e: unknown) => {
  log.error('server failed to start', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});

// A bug in one game must not take the others down silently: log it, keep serving.
process.on('uncaughtException', (e) => log.error('uncaught exception', { error: e.stack ?? String(e) }));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) }));
