/**
 * The Docker gate (MATCH_ISOLATION=container): the only process with the Docker socket. A separate, small entry point
 * (dist-server/dockerGate.js), run as its own compose service; see server/match/DockerGate.ts and docs/SECURITY.md.
 *
 *   DOCKER_GATE_SECRET (required, 32+ chars)  DOCKER_UPSTREAM (unix:///var/run/docker.sock)  DOCKER_GATE_PORT (2375)
 *   MATCH_IMAGE, MATCH_NETWORK, MATCH_OWNER, MATCH_CPUS, MATCH_MEMORY, MATCH_PIDS: the same values as the control plane.
 */
import { log } from './Log';
import { type DockerGate, gateFromEnv } from './match/DockerGate';

let gate: DockerGate;
try {
  gate = gateFromEnv(process.env);
} catch (e) {
  log.error('docker gate: bad configuration', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
gate.start().catch((e: unknown) => {
  log.error('docker gate failed to start', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
const stop = () => { void gate.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', (e) => log.error('uncaught exception', { error: e.stack ?? String(e) }));
