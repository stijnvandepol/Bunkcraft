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

/** One line of a runner's output (the ops dashboard). */
export interface LogLine { stream: 'out' | 'err'; text: string }

/** Most log lines one request may ask for (the Docker gate refuses more). */
export const MAX_LOG_TAIL = 500;
const MAX_LOG_LINE = 2000;

/** Splits text into lines (the last `tail`, each cut at MAX_LOG_LINE characters) for one stream. */
function pushLines(out: LogLine[], stream: LogLine['stream'], text: string): void {
  for (const line of text.split(/\r?\n/)) if (line.length > 0) out.push({ stream, text: line.slice(0, MAX_LOG_LINE) });
}

/**
 * The answer of the Engine's GET /containers/{id}/logs. A container without a TTY (ours) answers a multiplexed stream:
 * frames of an 8-byte header (stream 1 = stdout, 2 = stderr, three zero bytes, a big-endian length) and the payload.
 * Anything else (a TTY container) is plain stdout. Only the last `tail` lines come back.
 */
export function demuxDockerLogs(buf: Buffer, tail = MAX_LOG_TAIL): LogLine[] {
  const out: LogLine[] = [];
  const muxed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!muxed) {
    pushLines(out, 'out', buf.toString('utf8'));
  } else {
    // Frames of one stream are joined first: a line may be split over two frames.
    let off = 0;
    let cur: LogLine['stream'] | null = null;
    let text = '';
    while (off + 8 <= buf.length) {
      const stream: LogLine['stream'] = buf[off] === 2 ? 'err' : 'out';
      const size = buf.readUInt32BE(off + 4);
      const end = Math.min(buf.length, off + 8 + size);
      if (cur !== null && cur !== stream) { pushLines(out, cur, text); text = ''; }
      cur = stream;
      text += buf.subarray(off + 8, end).toString('utf8');
      off = end;
    }
    if (cur !== null) pushLines(out, cur, text);
  }
  return out.length > tail ? out.slice(out.length - tail) : out;
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
  /** The last `tail` (at most MAX_LOG_TAIL) lines a runner wrote, stdout and stderr apart. Never follows. */
  logs(h: RunnerHandle, tail: number): Promise<LogLine[]>;
  /** The image new runners get (Docker), for status pages. */
  readonly image: string;
  /** CPU and memory limits of new runners (Docker; the ops dashboard may lower them). */
  limits?(): { cpus: number; memoryMb: number };
  setLimits?(cpus: number, memoryMb: number): void;
}

// ---------------------------------------------------------------------------------------------- Docker Engine API

/**
 * A minimal Docker Engine API client. `host` is the Docker gate (http://docker-gate:2375, see DockerGate.ts) or, for
 * a local test, unix:///var/run/docker.sock. Only the calls below exist: create, start, stop, list, inspect, stats,
 * ping, and the gate's image. `secret` is DOCKER_GATE_SECRET, sent as a bearer token.
 */
export class DockerApi {
  private readonly base: { socketPath?: string; host?: string; port?: number };

  constructor(host: string, private readonly secret?: string) {
    if (host.startsWith('unix://')) this.base = { socketPath: host.slice(7) };
    else {
      const u = new URL(host);
      if (u.protocol !== 'http:') throw new Error('DOCKER_HOST must be http://host:port or unix:///path');
      this.base = { host: u.hostname, port: Number(u.port || 80) };
    }
  }

  // No API version in the path: Docker 29 refuses versions below 1.44 and older engines refuse newer ones; the unversioned
  // API is the engine's own, and the few fields used here are the same in every version since 1.41.
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; body: T }> {
    const r = await this.raw(method, path, body, timeoutMs);
    const text = r.body.toString('utf8');
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text answer */ }
    return { status: r.status, body: parsed as T };
  }

  /** The answer as bytes (logs are a binary stream), at most 8 MiB. */
  raw(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; type: string; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpRequest({
        ...this.base, method, path, timeout: timeoutMs,
        headers: {
          host: 'docker', 'content-length': String(data?.length ?? 0), ...(data ? { 'content-type': 'application/json' } : {}),
          ...(this.secret ? { authorization: `Bearer ${this.secret}` } : {}),
        },
      }, (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) { res.destroy(new Error('docker api answer too large')); return; }
          parts.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(parts) }));
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

  /**
   * The last `tail` log lines of a container, never following. Through the Docker gate the answer is already split
   * into lines (JSON); a plain Engine socket answers the multiplexed stream, split here.
   */
  async logs(id: string, tail: number): Promise<LogLine[]> {
    const n = Math.max(1, Math.min(MAX_LOG_TAIL, Math.floor(tail) || 1));
    const r = await this.raw('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${n}`, undefined, 10_000);
    if (r.status !== 200) throw new Error(`logs: ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
    if (r.type.startsWith('application/json')) {
      const j = JSON.parse(r.body.toString('utf8')) as { lines?: unknown };
      if (!Array.isArray(j.lines)) return [];
      return j.lines.filter((l): l is LogLine => !!l && typeof l === 'object' && typeof (l as LogLine).text === 'string')
        .slice(-n).map((l) => ({ stream: l.stream === 'err' ? 'err' : 'out', text: l.text.slice(0, MAX_LOG_LINE) }));
    }
    return demuxDockerLogs(r.body, n);
  }

  /** The image the Docker gate lets match containers run, or null when this is not a gate (a plain Engine socket). */
  async gateImage(): Promise<string | null> {
    const r = await this.request<{ image?: unknown }>('GET', '/_gate/image', undefined, 3000);
    if (r.status === 401) throw new Error('the Docker gate refused DOCKER_GATE_SECRET');
    return r.status === 200 && typeof r.body?.image === 'string' && r.body.image ? r.body.image : null;
  }

  async ping(): Promise<boolean> {
    let status = 0;
    try {
      status = (await this.request('GET', '/_ping', undefined, 3000)).status;
    } catch {
      return false;
    }
    if (status === 401) throw new Error('the Docker gate refused DOCKER_GATE_SECRET');
    return status === 200;
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
  /** What the Docker gate allows (MATCH_CPUS, MATCH_MEMORY at start-up): the dashboard may only go below it. */
  readonly maxCpus: number;
  readonly maxMemoryMb: number;

  constructor(private readonly o: DockerDriverOptions) {
    this.maxCpus = o.cpus;
    this.maxMemoryMb = o.memoryMb;
  }

  limits(): { cpus: number; memoryMb: number } {
    return { cpus: this.o.cpus, memoryMb: this.o.memoryMb };
  }

  /** Limits for containers started from now on (running ones keep theirs); clamped to what the gate allows. */
  setLimits(cpus: number, memoryMb: number): void {
    this.o.cpus = Math.max(0.1, Math.min(this.maxCpus, cpus));
    this.o.memoryMb = Math.max(96, Math.min(this.maxMemoryMb, Math.round(memoryMb)));
  }

  private policy(): MatchSpecPolicy {
    return { image: this.image, network: this.o.network, owner: this.o.owner, maxCpus: this.maxCpus, maxMemoryMb: this.maxMemoryMb, maxPids: this.o.pids };
  }

  async init(): Promise<void> {
    if (!(await this.o.api.ping())) throw new Error('Docker API (Docker gate) not reachable');
    if (this.o.image) { this.image = this.o.image; return; }
    // Through the gate: the image it lets through (its own, which is ours: the same image, the same compose update).
    const gated = await this.o.api.gateImage();
    if (gated) { this.image = gated; return; }
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

  logs(h: RunnerHandle, tail: number): Promise<LogLine[]> {
    return this.o.api.logs(h.ref, tail);
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
  /** The last MAX_LOG_TAIL lines of every child (what `docker logs` is for containers). */
  private readonly output = new Map<string, LogLine[]>();
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
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: process.env.NODE_ENV ?? '',
        ROLE: 'match', MATCH_ID: id, MATCH_TOKEN: key, CONTROL_URL: this.controlUrl, MATCH_PORT: '0', MATCH_HOST: '127.0.0.1',
        LOG_LEVEL: this.o.logLevel, BOT_PREWARM: 'off', CHUNK_WORKERS: '0', ...this.o.env,
      },
    });
    this.children.set(id, child);
    const lines: LogLine[] = [];
    this.output.set(id, lines);
    // Still shown on this process's own output (as before), and kept for the dashboard.
    const keep = (stream: LogLine['stream'], sink: NodeJS.WriteStream) => {
      let rest = '';
      return (c: Buffer) => {
        sink.write(c);
        const parts = (rest + c.toString('utf8')).split('\n');
        rest = parts.pop()!.slice(-MAX_LOG_LINE);
        for (const p of parts) pushLines(lines, stream, p);
        if (lines.length > MAX_LOG_TAIL) lines.splice(0, lines.length - MAX_LOG_TAIL);
      };
    };
    child.stdout?.on('data', keep('out', process.stdout));
    child.stderr?.on('data', keep('err', process.stderr));
    child.on('exit', (code) => {
      this.children.delete(id);
      this.output.delete(id);
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

  async logs(h: RunnerHandle, tail: number): Promise<LogLine[]> {
    const lines = this.output.get(h.id) ?? [];
    const n = Math.max(1, Math.min(MAX_LOG_TAIL, Math.floor(tail) || 1));
    return lines.slice(-n);
  }

  /** Kills every child (the control plane stops for good; tests). */
  killAll(): void {
    for (const c of this.children.values()) c.kill('SIGKILL');
    this.children.clear();
  }
}
