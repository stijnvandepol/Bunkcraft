import { RUNNER_ID } from './Internal';

/**
 * The one container spec the control plane ever sends to the Docker Engine API (POST /containers/create), and the
 * check every spec passes before it is sent. Nothing a player sends ends up here: the lobby is handed to the runner
 * later over the internal API. The only variable parts are the generated runner id, its derived key and operator
 * settings (image, network, limits), and each of those is validated again in `validateMatchSpec`.
 *
 * What a match container gets: our image only, a non-root user, a read-only root filesystem with a small /tmp,
 * no capabilities, no privilege escalation, no mounts or devices, no published ports, the internal match network
 * only, and hard CPU/memory/process limits. AutoRemove: Docker deletes it when it stops (no DELETE permission needed).
 */

export interface MatchSpecParams {
  id: string;
  key: string;
  image: string;
  network: string;
  controlUrl: string;
  owner: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  logLevel: string;
  /** The control plane's version, as a label (which image generation started it). */
  version: string;
}

export interface MatchSpecPolicy {
  image: string;
  network: string;
  owner: string;
  maxCpus: number;
  maxMemoryMb: number;
  maxPids: number;
}

export const MATCH_PORT = 3100;
export const LABEL_ROLE = 'nl.bunkhosting.bunkcraft.role';
export const LABEL_OWNER = 'nl.bunkhosting.bunkcraft.owner';
export const LABEL_RUNNER = 'nl.bunkhosting.bunkcraft.runner';
export const LABEL_VERSION = 'nl.bunkhosting.bunkcraft.version';

const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;
const NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const OWNER = /^[a-zA-Z0-9_.-]{1,63}$/;
const CONTROL_URL = /^http:\/\/[a-zA-Z0-9.-]{1,253}(:\d{1,5})?$/;
const LOG_LEVEL = /^(debug|info|warn|error)$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
/** User id of "node" in the official Node images. */
const USER = '1000:1000';

const envNum = (v: string | undefined, dflt: number): number => {
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

/**
 * The match container settings from the environment. The control plane (Config) and the Docker gate (DockerGate)
 * both read them here, so the spec one builds is exactly the spec the other lets through.
 */
export function matchSettingsFromEnv(env: NodeJS.ProcessEnv): {
  matchImage: string; matchNetwork: string; matchOwner: string; matchCpus: number; matchMemoryMb: number; matchPids: number;
} {
  return {
    matchImage: env.MATCH_IMAGE ?? '',
    matchNetwork: env.MATCH_NETWORK || 'bunkcraft_match',
    matchOwner: (env.MATCH_OWNER || 'bunkcraft').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 63) || 'bunkcraft',
    matchCpus: Math.max(0.1, Math.min(8, envNum(env.MATCH_CPUS, 1))),
    matchMemoryMb: Math.max(96, Math.min(4096, parseMemoryMb(env.MATCH_MEMORY, 256))),
    matchPids: Math.max(16, Math.min(1024, Math.floor(envNum(env.MATCH_PIDS, 64)))),
  };
}

export function containerName(id: string): string {
  return `bunkcraft-match-${id}`;
}

export interface ContainerCreate {
  name: string;
  body: Record<string, unknown>;
}

export function buildMatchSpec(p: MatchSpecParams): ContainerCreate {
  const memory = Math.round(p.memoryMb) * 1024 * 1024;
  // V8 heap well below the container limit: an overload shows up as GC first, not as the OOM killer.
  const heapMb = Math.max(64, Math.floor(p.memoryMb * 0.6));
  const spec: ContainerCreate = {
    name: containerName(p.id),
    body: {
      Image: p.image,
      User: USER,
      Env: [
        'ROLE=match',
        `MATCH_ID=${p.id}`,
        `MATCH_TOKEN=${p.key}`,
        `CONTROL_URL=${p.controlUrl}`,
        `MATCH_PORT=${MATCH_PORT}`,
        `LOG_LEVEL=${p.logLevel}`,
        'MATCH_TMP=/tmp',
        'BOT_PREWARM=off',
        'CHUNK_WORKERS=0',
        `NODE_OPTIONS=--max-old-space-size=${heapMb} --max-semi-space-size=8`,
      ],
      Labels: {
        [LABEL_ROLE]: 'match',
        [LABEL_OWNER]: p.owner,
        [LABEL_RUNNER]: p.id,
        [LABEL_VERSION]: p.version,
      },
      ExposedPorts: { [`${MATCH_PORT}/tcp`]: {} },
      // The image's healthcheck asks port 3000, which a runner does not serve.
      Healthcheck: { Test: ['NONE'] },
      StopTimeout: 10,
      HostConfig: {
        NetworkMode: p.network,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        NanoCpus: Math.round(p.cpus * 1e9),
        Memory: memory,
        MemorySwap: memory,
        PidsLimit: Math.floor(p.pids),
        AutoRemove: true,
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
      },
    },
  };
  validateMatchSpec(spec, { image: p.image, network: p.network, owner: p.owner, maxCpus: p.cpus, maxMemoryMb: p.memoryMb, maxPids: p.pids });
  return spec;
}

const TOP_KEYS = new Set(['Image', 'User', 'Env', 'Labels', 'ExposedPorts', 'Healthcheck', 'StopTimeout', 'HostConfig']);
const HOST_KEYS = new Set([
  'NetworkMode', 'ReadonlyRootfs', 'Tmpfs', 'CapDrop', 'SecurityOpt', 'NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit', 'AutoRemove', 'RestartPolicy', 'LogConfig',
]);
const ENV: Record<string, RegExp> = {
  ROLE: /^match$/,
  MATCH_ID: RUNNER_ID,
  MATCH_TOKEN: KEY,
  CONTROL_URL,
  MATCH_PORT: new RegExp(`^${MATCH_PORT}$`),
  LOG_LEVEL,
  MATCH_TMP: /^\/tmp$/,
  BOT_PREWARM: /^off$/,
  CHUNK_WORKERS: /^0$/,
  NODE_OPTIONS: /^--max-old-space-size=\d{2,5} --max-semi-space-size=\d{1,3}$/,
};

function fail(why: string): never {
  throw new Error(`unsafe match container spec: ${why}`);
}

function exactKeys(o: unknown, allowed: Set<string>, where: string): Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${where} is not an object`);
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(`${where}.${k} is not allowed`);
  return o as Record<string, unknown>;
}

/** Throws unless the spec is exactly the shape buildMatchSpec makes, within the policy. */
export function validateMatchSpec(spec: ContainerCreate, policy: MatchSpecPolicy): void {
  const runner = /^bunkcraft-match-([a-z0-9]{8,24})$/.exec(spec.name);
  if (!runner) fail('name');
  const b = exactKeys(spec.body, TOP_KEYS, 'body');
  if (!IMAGE.test(policy.image) || b.Image !== policy.image) fail('image');
  if (b.User !== USER) fail('user must be 1000:1000');
  if (!Array.isArray(b.Env)) fail('env');
  const seen = new Set<string>();
  for (const e of b.Env) {
    if (typeof e !== 'string') fail('env entry');
    const eq = e.indexOf('=');
    const k = e.slice(0, eq);
    const v = e.slice(eq + 1);
    if (eq < 1 || !ENV[k] || seen.has(k) || !ENV[k].test(v)) fail(`env ${k || e}`);
    seen.add(k);
  }
  if (seen.size !== Object.keys(ENV).length) fail('env incomplete');
  if (!b.Env.includes(`MATCH_ID=${runner[1]}`)) fail('env id does not match the name');
  const labels = exactKeys(b.Labels, new Set([LABEL_ROLE, LABEL_OWNER, LABEL_RUNNER, LABEL_VERSION]), 'Labels');
  if (labels[LABEL_ROLE] !== 'match' || labels[LABEL_RUNNER] !== runner[1]) fail('labels');
  if (!OWNER.test(policy.owner) || labels[LABEL_OWNER] !== policy.owner) fail('owner label');
  if (typeof labels[LABEL_VERSION] !== 'string' || !VERSION.test(labels[LABEL_VERSION])) fail('version label');
  const ports = exactKeys(b.ExposedPorts, new Set([`${MATCH_PORT}/tcp`]), 'ExposedPorts');
  if (Object.keys(ports).length !== 1) fail('ports');
  const hc = exactKeys(b.Healthcheck, new Set(['Test']), 'Healthcheck');
  if (!Array.isArray(hc.Test) || hc.Test.length !== 1 || hc.Test[0] !== 'NONE') fail('healthcheck');
  if (typeof b.StopTimeout !== 'number' || b.StopTimeout < 1 || b.StopTimeout > 30) fail('stop timeout');
  const h = exactKeys(b.HostConfig, HOST_KEYS, 'HostConfig');
  if (!NETWORK.test(policy.network) || h.NetworkMode !== policy.network) fail('network');
  if (['host', 'bridge', 'default', 'none'].includes(policy.network) || policy.network.startsWith('container:')) fail('network must be the internal match network');
  if (h.ReadonlyRootfs !== true) fail('read-only root filesystem');
  const tmpfs = exactKeys(h.Tmpfs, new Set(['/tmp']), 'Tmpfs');
  if (typeof tmpfs['/tmp'] !== 'string' || !/^rw,noexec,nosuid,size=\d{1,4}m$/.test(tmpfs['/tmp'])) fail('tmpfs');
  if (!Array.isArray(h.CapDrop) || h.CapDrop.length !== 1 || h.CapDrop[0] !== 'ALL') fail('capabilities');
  if (!Array.isArray(h.SecurityOpt) || h.SecurityOpt.length !== 1 || h.SecurityOpt[0] !== 'no-new-privileges:true') fail('security options');
  const cpus = Number(h.NanoCpus) / 1e9;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > policy.maxCpus + 1e-9) fail('cpu limit');
  const mem = Number(h.Memory);
  if (!Number.isInteger(mem) || mem < 64 * 1048576 || mem > policy.maxMemoryMb * 1048576 || h.MemorySwap !== mem) fail('memory limit');
  if (!Number.isInteger(h.PidsLimit) || (h.PidsLimit as number) < 16 || (h.PidsLimit as number) > policy.maxPids) fail('pids limit');
  if (h.AutoRemove !== true) fail('auto remove');
  const rp = exactKeys(h.RestartPolicy, new Set(['Name']), 'RestartPolicy');
  if (rp.Name !== 'no') fail('restart policy');
  const lc = exactKeys(h.LogConfig, new Set(['Type', 'Config']), 'LogConfig');
  if (lc.Type !== 'json-file') fail('log driver');
  exactKeys(lc.Config, new Set(['max-size', 'max-file']), 'LogConfig.Config');
}
