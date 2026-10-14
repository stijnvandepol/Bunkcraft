import { type ChildProcess, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { hostname } from 'node:os';
import { log } from '../Log';
import {
  type ContainerCreate, LABEL_OWNER, LABEL_ROLE, LABEL_RUNNER, LABEL_VERSION, MATCH_PORT, type MatchSpecPolicy, buildMatchSpec,
  containerName, validateMatchSpec,
} from './ContainerSpec';
import { RUNNER_ID } from './Internal';

/** A runner as a driver knows it: its id and the container id (Docker) or process. */
export interface RunnerHandle {
  id: string;
  ref: string;
  /** Docker: the image (id) it runs and the control plane version that started it. */
  image?: string;
  version?: string;
}

export interface RunnerStats {
  /** CPU in cores (1 = one full core) over the last interval, memory in use and its limit. */
  cpu: number;
  memBytes: number;
  memLimitBytes: number;
}

/** Starts and stops match runners. The pool (MatchPool) decides when; the driver only knows how. */
export interface MatchDriver {
  readonly kind: 'docker' | 'process';
  /** Prepares (Docker: finds the image); throws when the driver cannot work. */
  init(): Promise<void>;
  start(id: string, key: string): Promise<RunnerHandle>;
  /** Where the runner listens once it reported its port. */
  urlFor(h: RunnerHandle, port: number): string;
  stop(h: RunnerHandle): Promise<void>;
  /** Runners of this owner that are running now (adopted after a control plane restart). */
  list(): Promise<RunnerHandle[]>;
  stats(h: RunnerHandle): Promise<RunnerStats | null>;
  /** The image new runners get (Docker), for status pages. */
  readonly image: string;
}

// ---------------------------------------------------------------------------------------------- Docker Engine API

/**
 * A minimal Docker Engine API client. `host` is the socket proxy (http://docker-proxy:2375) or, for a local smoke
 * test, unix:///var/run/docker.sock. Only the calls below exist: create, start, stop, list, inspect, stats, ping.
 */
export class DockerApi {
  private readonly base: { socketPath?: string; host?: string; port?: number };

  constructor(host: string) {
    if (host.startsWith('unix://')) this.base = { socketPath: host.slice(7) };
    else {
      const u = new URL(host);
      if (u.protocol !== 'http:') throw new Error('DOCKER_HOST must be http://host:port or unix:///path');
      this.base = { host: u.hostname, port: Number(u.port || 80) };
    }
  }

  // No API version in the path: Docker 29 refuses versions below 1.44 and older engines refuse newer ones; the unversioned
  // API is the engine's own, and the few fields used here are the same in every version since 1.41.
  request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpRequest({
        ...this.base, method, path, timeout: timeoutMs,
        headers: { host: 'docker', ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) },
      }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let parsed: unknown = text;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text answer */ }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('docker api timeout')));
      req.on('error', reject);
      req.end(data);
    });
  }

  private static check<T>(r: { status: number; body: T }, what: string, ok = [200, 201, 204, 304]): T {
    if (!ok.includes(r.status)) {
      const msg = typeof r.body === 'object' && r.body && 'message' in r.body ? String((r.body as { message: unknown }).message) : String(r.body);
      throw new Error(`${what}: ${r.status} ${msg.slice(0, 200)}`);
    }
    return r.body;
  }

  async create(spec: ContainerCreate): Promise<string> {
    const body = DockerApi.check(await this.request<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, spec.body), 'create');
    return body.Id;
  }

  async start(id: string): Promise<void> {
    DockerApi.check(await this.request('POST', `/containers/${encodeURIComponent(id)}/start`), 'start');
  }

  async stop(id: string, timeoutSec = 10): Promise<void> {
    // 404: already gone (AutoRemove), 304: already stopped.
    DockerApi.check(await this.request('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`, undefined, (timeoutSec + 10) * 1000), 'stop', [204, 304, 404]);
  }

  async list(labels: string[]): Promise<{ Id: string; Image: string; ImageID: string; Labels: Record<string, string>; State: string }[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    return DockerApi.check(await this.request<{ Id: string; Image: string; ImageID: string; Labels: Record<string, string>; State: string }[]>('GET', `/containers/json?filters=${filters}`), 'list');
  }

  async inspect(id: string): Promise<{ Id: string; Image: string; Config: { Image: string } } | null> {
    const r = await this.request<{ Id: string; Image: string; Config: { Image: string } }>('GET', `/containers/${encodeURIComponent(id)}/json`);
    return r.status === 404 ? null : DockerApi.check(r, 'inspect');
  }

  async stats(id: string): Promise<Record<string, unknown> | null> {
    const r = await this.request<Record<string, unknown>>('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false`, undefined, 8000);
    return r.status === 200 ? r.body : null;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.request('GET', '/_ping', undefined, 3000)).status === 200;
    } catch {
      return false;
    }
  }
}

export interface DockerDriverOptions {
  api: DockerApi;
  /** MATCH_IMAGE; empty = the image of the container this control plane runs in. */
  image: string;
  network: string;
  controlUrl: string;
  owner: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  logLevel: string;
  version: string;
}

export class DockerDriver implements MatchDriver {
  readonly kind = 'docker';
  image = '';

  constructor(private readonly o: DockerDriverOptions) {}

  private policy(): MatchSpecPolicy {
    return { image: this.image, network: this.o.network, owner: this.o.owner, maxCpus: this.o.cpus, maxMemoryMb: this.o.memoryMb, maxPids: this.o.pids };
  }

  async init(): Promise<void> {
    if (!(await this.o.api.ping())) throw new Error('Docker API (socket proxy) not reachable');
    if (this.o.image) { this.image = this.o.image; return; }
    // Our own container: its hostname is its short id. Its image id pins match containers to exactly this build, so an
    // update (new image) starts new matches on the new build and a rollback on the old one.
    const self = await this.o.api.inspect(hostname());
    if (!self) throw new Error('MATCH_IMAGE is not set and this process does not run in a container');
    this.image = self.Image;
  }

  async start(id: string, key: string): Promise<RunnerHandle> {
    const spec = buildMatchSpec({
      id, key, image: this.image, network: this.o.network, controlUrl: this.o.controlUrl, owner: this.o.owner,
      cpus: this.o.cpus, memoryMb: this.o.memoryMb, pids: this.o.pids, logLevel: this.o.logLevel, version: this.o.version,
    });
    // Built above from validated settings; checked again right before it leaves the process.
    validateMatchSpec(spec, this.policy());
    const ref = await this.o.api.create(spec);
    try {
      await this.o.api.start(ref);
    } catch (e) {
      await this.o.api.stop(ref, 1).catch(() => undefined);
      throw e;
    }
    return { id, ref, image: this.image, version: this.o.version };
  }

  urlFor(h: RunnerHandle): string {
    return `http://${containerName(h.id)}:${MATCH_PORT}`;
  }

  async stop(h: RunnerHandle): Promise<void> {
    await this.o.api.stop(h.ref, 10);
  }

  async list(): Promise<RunnerHandle[]> {
    const rows = await this.o.api.list([`${LABEL_ROLE}=match`, `${LABEL_OWNER}=${this.o.owner}`]);
    const out: RunnerHandle[] = [];
    for (const r of rows) {
      const id = r.Labels?.[LABEL_RUNNER];
      // Only containers with exactly our labels; anything else on the host is none of our business.
      if (r.State !== 'running' || typeof id !== 'string' || !RUNNER_ID.test(id) || r.Labels[LABEL_OWNER] !== this.o.owner) continue;
      out.push({ id, ref: r.Id, image: r.ImageID, version: r.Labels[LABEL_VERSION] });
    }
    return out;
  }

  async stats(h: RunnerHandle): Promise<RunnerStats | null> {
    const s = await this.o.api.stats(h.ref).catch(() => null) as null | {
      cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
      precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
      memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
    };
    if (!s?.cpu_stats || !s.memory_stats) return null;
    const cpuDelta = (s.cpu_stats.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats.online_cpus ?? 1;
    // Same formula as `docker stats` (memory without the page cache).
    const usage = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0);
    return { cpu: sysDelta > 0 ? (cpuDelta / sysDelta) * cpus : 0, memBytes: Math.max(0, usage), memLimitBytes: s.memory_stats.limit ?? 0 };
  }
}

// ---------------------------------------------------------------------------------------------- child processes

export interface ProcessDriverOptions {
  /** Command that starts the server, e.g. [node, dist-server/index.js] or [node, --import, tsx, server/index.ts]. */
  command: string[];
  controlUrl: string;
  logLevel: string;
  /** Extra environment for the children (tests). */
  env?: Record<string, string>;
}

/**
 * MATCH_DRIVER=process: runners are child processes of the control plane on 127.0.0.1. No resource limits and no
 * isolation beyond the OS process; for development and the integration tests, not for production.
 */
export class ProcessDriver implements MatchDriver {
  readonly kind = 'process';
  readonly image = 'process';
  private readonly children = new Map<string, ChildProcess>();
  /** Set by the control plane once its internal API listens. */
  controlUrl: string;

  constructor(private readonly o: ProcessDriverOptions) {
    this.controlUrl = o.controlUrl;
  }

  static defaultCommand(): string[] {
    const entry = process.argv[1] ?? '';
    return /dist-server[/\\]index\.js$/.test(entry) ? [process.execPath, entry] : [process.execPath, '--import', 'tsx', 'server/index.ts'];
  }

  async init(): Promise<void> {
    if (this.o.command.length === 0) throw new Error('no command');
  }

  async start(id: string, key: string): Promise<RunnerHandle> {
    const [cmd, ...args] = this.o.command;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: process.env.NODE_ENV ?? '',
        ROLE: 'match', MATCH_ID: id, MATCH_TOKEN: key, CONTROL_URL: this.controlUrl, MATCH_PORT: '0', MATCH_HOST: '127.0.0.1',
        LOG_LEVEL: this.o.logLevel, BOT_PREWARM: 'off', CHUNK_WORKERS: '0', ...this.o.env,
      },
    });
    this.children.set(id, child);
    child.on('exit', (code) => {
      this.children.delete(id);
      if (code) log.warn('match runner process exited', { runner: id, code });
    });
    return { id, ref: String(child.pid ?? 0) };
  }

  urlFor(_h: RunnerHandle, port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  async stop(h: RunnerHandle): Promise<void> {
    const child = this.children.get(h.id);
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      child.kill('SIGTERM');
    });
  }

  async list(): Promise<RunnerHandle[]> {
    return [];
  }

  async stats(): Promise<RunnerStats | null> {
    return null;
  }

  /** Kills every child (the control plane stops for good; tests). */
  killAll(): void {
    for (const c of this.children.values()) c.kill('SIGKILL');
    this.children.clear();
  }
}
