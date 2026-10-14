import { type IncomingMessage, type Server, type ServerResponse, createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { log } from '../Log';
import { bearer, safeEqual } from '../Security';
import {
  LABEL_OWNER, LABEL_ROLE, LABEL_RUNNER, type MatchSpecPolicy, containerName, matchSettingsFromEnv, validateMatchSpec,
} from './ContainerSpec';
import { MAX_LOG_TAIL, demuxDockerLogs } from './Drivers';
import { RUNNER_ID } from './Internal';

/**
 * The Docker gate: the only process with the Docker socket (MATCH_ISOLATION=container). The control plane talks to the
 * Engine API through it, and it lets through exactly what the DockerDriver needs, for our own match containers only:
 *
 *   GET  /_ping                          liveness of the Engine
 *   GET  /_gate/image                    the image match containers must run (MATCH_IMAGE, else the gate's own image)
 *   GET  /containers/json                list: always with our role+owner label filter, rows filtered again
 *   POST /containers/create?name=…       body parsed (size-capped) and checked by validateMatchSpec, then re-serialised
 *   GET  /containers/{id}/json           \
 *   POST /containers/{id}/start           |  only when the target, inspected first, carries our role and owner labels
 *   POST /containers/{id}/stop?t=N        |  and its runner's name; forwarded by the full id the inspect returned
 *   GET  /containers/{id}/stats?stream=false |
 *   GET  /containers/{id}/logs?stdout=1&stderr=1&tail=N /  N ≤ 500, never `follow`; answered as JSON lines
 *
 * Everything else is 403: exec, kill, update, delete, build, images, volumes, networks, events, system, swarm, plugins.
 * A path is matched as sent, never decoded: anything outside [A-Za-z0-9/_.-], an empty, `.` or `..` segment is refused,
 * and an optional /v1.NN prefix is dropped. Queries are rebuilt from the few allowed parameters; client headers never
 * reach the Engine. Every request carries `Authorization: Bearer <DOCKER_GATE_SECRET>` (compared with safeEqual).
 *
 * Why: whoever has the Docker API has root on the host. A generic socket proxy filters by path only, so a control
 * plane taken over by an exploit could still create a privileged container with a host mount. With this gate it can
 * only create the one container shape validateMatchSpec allows, and only touch containers that are ours.
 */

export interface DockerGateOptions {
  /** The Engine: unix:///var/run/docker.sock in production, http://host:port in tests. */
  upstream: string;
  secret: string;
  host: string;
  port: number;
  /** MATCH_IMAGE; empty = the image of the container the gate runs in (the same image as the control plane). */
  image: string;
  network: string;
  owner: string;
  maxCpus: number;
  maxMemoryMb: number;
  maxPids: number;
}

const MAX_CREATE_BODY = 64 * 1024;
const MAX_UPSTREAM_BODY = 8 * 1024 * 1024;
const SAFE_PATH = /^[A-Za-z0-9/_.-]{1,512}$/;
const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FULL_ID = /^[0-9a-f]{64}$/;
const MATCH_NAME = /^bunkcraft-match-[a-z0-9]{8,24}$/;
/** Every path the gate knows; anything else is refused before its body is read. */
const ENDPOINT = /^\/(_ping|_gate\/image|containers\/json|containers\/create|containers\/[^/]+\/(json|start|stop|stats|logs))$/;

class Refused extends Error {
  constructor(readonly status: number, why: string) { super(why); }
}

interface Upstream { status: number; type: string; body: Buffer }

/** The request path without query, version prefix or anything a path parser could read two ways; throws Refused. */
export function normalizePath(rawUrl: string | undefined): { path: string; query: URLSearchParams } {
  const raw = rawUrl ?? '';
  const q = raw.indexOf('?');
  let path = q < 0 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  if (!path.startsWith('/') || !SAFE_PATH.test(path)) throw new Refused(403, 'path');
  path = path.replace(/^\/v1\.\d{1,3}(?=\/)/, '');
  const segs = path.slice(1).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new Refused(403, 'path');
  return { path, query };
}

function onlyKeys(query: URLSearchParams, allowed: string[]): void {
  const seen = new Set<string>();
  for (const k of query.keys()) {
    if (!allowed.includes(k) || seen.has(k)) throw new Refused(403, `query ${k}`);
    seen.add(k);
  }
}

/** The whole request body, at most `limit` bytes (chunked or not); a bigger one is refused and the socket dropped. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) { reject(new Refused(413, 'body too large')); return; }
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { req.pause(); reject(new Refused(413, 'body too large')); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export class DockerGate {
  private server: Server | null = null;
  private base: { socketPath?: string; host?: string; port?: number };
  /** The image match containers must use; resolved in start(). */
  image = '';
  port = 0;
  /** Refused requests (tests, logs). */
  refused = 0;

  constructor(private readonly o: DockerGateOptions) {
    if (o.secret.length < 32) throw new Error('DOCKER_GATE_SECRET must be at least 32 characters');
    if (o.upstream.startsWith('unix://')) this.base = { socketPath: o.upstream.slice(7) };
    else {
      const u = new URL(o.upstream);
      if (u.protocol !== 'http:') throw new Error('upstream must be unix:///path or http://host:port');
      this.base = { host: u.hostname, port: Number(u.port || 80) };
    }
  }

  private policy(): MatchSpecPolicy {
    return { image: this.image, network: this.o.network, owner: this.o.owner, maxCpus: this.o.maxCpus, maxMemoryMb: this.o.maxMemoryMb, maxPids: this.o.maxPids };
  }

  /** Resolves the image (retrying while the Engine is not reachable yet) and listens. */
  async start(): Promise<void> {
    this.image = this.o.image;
    for (let i = 0; !this.image; i++) {
      try {
        const self = await this.up('GET', `/containers/${encodeURIComponent(hostname())}/json`);
        const img = (JSON.parse(self.body.toString('utf8')) as { Image?: unknown }).Image;
        if (self.status !== 200 || typeof img !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(img)) {
          throw new Error(`MATCH_IMAGE is not set and the gate's own container was not found (${self.status})`);
        }
        this.image = img;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (i === 0 || i % 30 === 0) {
          log.error('docker gate: Engine not usable yet', {
            error: msg, hint: /EACCES/.test(msg) ? 'the socket is not readable: set DOCKER_GID to the group of /var/run/docker.sock' : undefined,
          });
        }
        if (i >= 120) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 60_000;
    this.server.maxHeadersCount = 32;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.o.port, this.o.host, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    log.info('docker gate listening', { port: this.port, image: this.image, owner: this.o.owner, network: this.o.network });
  }

  close(): Promise<void> {
    return new Promise((r) => { if (!this.server) r(); else { this.server.close(() => r()); this.server.closeAllConnections(); } });
  }

  // ------------------------------------------------------------------------------------------ the Engine

  private up(method: 'GET' | 'POST', path: string, body?: Buffer, timeoutMs = 20_000): Promise<Upstream> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        ...this.base, method, path, timeout: timeoutMs,
        headers: { host: 'docker', ...(body ? { 'content-type': 'application/json' } : {}), 'content-length': String(body?.length ?? 0) },
      }, (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_UPSTREAM_BODY) { res.destroy(new Error('upstream answer too large')); return; }
          parts.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 502, type: String(res.headers['content-type'] ?? 'application/json'), body: Buffer.concat(parts) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('docker api timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** The full id of `ref` when it is one of our match containers; 404 when it does not exist, 403 when it is not ours. */
  private async owned(ref: string): Promise<{ id: string; inspect: Upstream }> {
    if (!CONTAINER_REF.test(ref)) throw new Refused(403, 'container reference');
    const r = await this.up('GET', `/containers/${ref}/json`);
    if (r.status === 404) throw new Refused(404, 'no such container');
    if (r.status !== 200) throw new Refused(502, `inspect ${r.status}`);
    let c: { Id?: unknown; Name?: unknown; Config?: { Labels?: Record<string, unknown> | null } };
    try { c = JSON.parse(r.body.toString('utf8')) as typeof c; } catch { throw new Refused(502, 'inspect'); }
    const labels = c.Config?.Labels ?? {};
    const runner = labels[LABEL_RUNNER];
    const ours = typeof c.Id === 'string' && FULL_ID.test(c.Id)
      && labels[LABEL_ROLE] === 'match' && labels[LABEL_OWNER] === this.o.owner
      && typeof runner === 'string' && RUNNER_ID.test(runner) && c.Name === `/${containerName(runner)}`;
    if (!ours) throw new Refused(403, 'not a match container of this install');
    return { id: c.Id as string, inspect: r };
  }

  // ------------------------------------------------------------------------------------------ requests

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, type: string, body: Buffer | string) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (status: number, body: unknown) => send(status, 'application/json', JSON.stringify(body));
    let what = `${req.method} ${String(req.url).slice(0, 200)}`;
    try {
      // Health of the gate process itself (compose healthcheck): no secret, no Engine call, no information.
      if (req.method === 'GET' && req.url === '/_gate/health') { json(200, { ok: true }); return; }
      const token = bearer(req.headers.authorization);
      if (!token || !safeEqual(token, this.o.secret)) throw new Refused(401, 'secret');
      const { path, query } = normalizePath(req.url);
      what = `${req.method} ${path}`;
      const method = req.method;
      if (method !== 'GET' && method !== 'POST') throw new Refused(403, 'method');
      if (!ENDPOINT.test(path)) throw new Refused(403, 'endpoint not allowed');
      // Only a create carries a body; anything else must come empty (chunked or not).
      const body = await readBody(req, path === '/containers/create' ? MAX_CREATE_BODY : 0);
      const fwd = (r: Upstream) => send(r.status, r.type, r.body);

      if (method === 'GET' && path === '/_ping') { onlyKeys(query, []); fwd(await this.up('GET', '/_ping')); return; }
      if (method === 'GET' && path === '/_gate/image') { onlyKeys(query, []); json(200, { image: this.image }); return; }
      if (method === 'GET' && path === '/containers/json') {
        // Whatever filter was asked for: ours. And the rows are checked again, so nothing else on the host shows.
        onlyKeys(query, ['filters']);
        const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL_ROLE}=match`, `${LABEL_OWNER}=${this.o.owner}`] }));
        const r = await this.up('GET', `/containers/json?filters=${filters}`);
        if (r.status !== 200) { fwd(r); return; }
        const rows = JSON.parse(r.body.toString('utf8')) as { Labels?: Record<string, unknown> | null }[];
        json(200, Array.isArray(rows) ? rows.filter((c) => c?.Labels?.[LABEL_ROLE] === 'match' && c.Labels[LABEL_OWNER] === this.o.owner) : []);
        return;
      }
      if (method === 'POST' && path === '/containers/create') {
        onlyKeys(query, ['name']);
        const name = query.get('name') ?? '';
        if (!MATCH_NAME.test(name)) throw new Refused(403, 'container name');
        if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new Refused(415, 'content type');
        let spec: unknown;
        try { spec = JSON.parse(body.toString('utf8')); } catch { throw new Refused(400, 'body is not JSON'); }
        try {
          validateMatchSpec({ name, body: spec as Record<string, unknown> }, this.policy());
        } catch (e) {
          throw new Refused(403, e instanceof Error ? e.message : 'spec');
        }
        // Re-serialised: the Engine gets exactly what was validated (no duplicate keys, no second reading).
        fwd(await this.up('POST', `/containers/create?name=${name}`, Buffer.from(JSON.stringify(spec))));
        return;
      }
      const m = /^\/containers\/([^/]+)\/(json|start|stop|stats|logs)$/.exec(path);
      if (m) {
        const [, ref, op] = m;
        if ((op === 'json' || op === 'stats' || op === 'logs') !== (method === 'GET')) throw new Refused(403, 'method');
        if (op === 'logs') {
          // The ops dashboard: the last lines, once. No follow (a stream that never ends), no since/until, no timestamps.
          onlyKeys(query, ['stdout', 'stderr', 'tail']);
          for (const k of ['stdout', 'stderr']) if (query.has(k) && !/^(0|1|true|false)$/.test(query.get(k)!)) throw new Refused(403, `logs ${k}`);
          const tail = query.get('tail') ?? '100';
          if (!/^\d{1,3}$/.test(tail) || Number(tail) < 1 || Number(tail) > MAX_LOG_TAIL) throw new Refused(403, 'logs tail');
          const { id } = await this.owned(ref);
          const r = await this.up('GET', `/containers/${id}/logs?stdout=1&stderr=1&follow=0&tail=${Number(tail)}`, undefined, 10_000);
          if (r.status !== 200) { fwd(r); return; }
          json(200, { lines: demuxDockerLogs(r.body, Number(tail)) });
          return;
        }
        if (op === 'json' || op === 'start') onlyKeys(query, []);
        if (op === 'stop') onlyKeys(query, ['t']);
        if (op === 'stats') { onlyKeys(query, ['stream']); if (query.get('stream') !== 'false') throw new Refused(403, 'stats must not stream'); }
        const t = Number(query.get('t') ?? 10);
        if (op === 'stop' && !(Number.isInteger(t) && t >= 0 && t <= 30)) throw new Refused(403, 'stop timeout');
        const { id, inspect } = await this.owned(ref);
        if (op === 'json') fwd(inspect);
        else if (op === 'stats') fwd(await this.up('GET', `/containers/${id}/stats?stream=false`, undefined, 10_000));
        else if (op === 'start') fwd(await this.up('POST', `/containers/${id}/start`));
        else fwd(await this.up('POST', `/containers/${id}/stop?t=${t}`, undefined, (t + 15) * 1000));
        return;
      }
      throw new Refused(403, 'endpoint not allowed');
    } catch (e) {
      const status = e instanceof Refused ? e.status : 502;
      if (status !== 404) {
        this.refused++;
        log.warn('docker gate refused', { request: what, status, why: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
      // A body we stopped reading: the connection is not reused.
      if (status === 413) { res.shouldKeepAlive = false; res.once('finish', () => req.socket.destroy()); }
      json(status, { message: status === 502 ? 'docker gate: upstream error' : `docker gate: ${e instanceof Error ? e.message.slice(0, 200) : 'refused'}` });
    }
  }
}

/** ROLE=dockergate settings (docker-compose.matches.yml); the match settings are the control plane's (matchSettingsFromEnv). */
export function gateFromEnv(env: NodeJS.ProcessEnv): DockerGate {
  const m = matchSettingsFromEnv(env);
  return new DockerGate({
    upstream: env.DOCKER_UPSTREAM || 'unix:///var/run/docker.sock',
    secret: env.DOCKER_GATE_SECRET ?? '',
    host: env.DOCKER_GATE_HOST || '0.0.0.0',
    port: Number(env.DOCKER_GATE_PORT || 2375),
    image: m.matchImage, network: m.matchNetwork, owner: m.matchOwner, maxCpus: m.matchCpus, maxMemoryMb: m.matchMemoryMb, maxPids: m.matchPids,
  });
}
