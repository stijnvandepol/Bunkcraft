/**
 * The Docker gate (server/match/DockerGate.ts) against a fake Docker Engine: what passes (exactly the DockerDriver's
 * calls, for our own match containers) and everything that must not reach the Engine (privileged or foreign creates,
 * other containers on the host, exec and friends, path tricks, oversized bodies, a missing secret).
 */
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_OWNER, LABEL_ROLE, LABEL_RUNNER, buildMatchSpec } from '../../server/match/ContainerSpec';
import { DockerGate, normalizePath } from '../../server/match/DockerGate';
import { DockerApi, DockerDriver } from '../../server/match/Drivers';

const SECRET = 's'.repeat(40);
const IMAGE = 'sha256:' + 'c'.repeat(64);
const OURS = 'a'.repeat(64);
const FOREIGN = 'b'.repeat(64);
const IMPOSTOR = 'd'.repeat(64);
const RUNNER = 'abcdef0123456789';

interface Call { method: string; path: string; body: string; headers: IncomingMessage['headers'] }
const calls: Call[] = [];
let engine: Server;
let gate: DockerGate;
let gateBase = '';

const ourLabels = { [LABEL_ROLE]: 'match', [LABEL_OWNER]: 'bunkcraft', [LABEL_RUNNER]: RUNNER };
const containers: Record<string, { Id: string; Name: string; Config: { Labels: Record<string, string> } }> = {
  [OURS]: { Id: OURS, Name: `/bunkcraft-match-${RUNNER}`, Config: { Labels: ourLabels } },
  [FOREIGN]: { Id: FOREIGN, Name: '/snackspot-db', Config: { Labels: { 'com.docker.compose.project': 'snackspot' } } },
  // Our labels on someone else's container (anyone on the host can set labels): the name gives it away.
  [IMPOSTOR]: { Id: IMPOSTOR, Name: '/snackspot-web', Config: { Labels: ourLabels } },
};
const byRef = (ref: string) => Object.values(containers).find((c) => c.Id.startsWith(ref) || c.Name === `/${ref}`);

const readAll = (req: IncomingMessage) => new Promise<string>((r) => {
  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => parts.push(c));
  req.on('end', () => r(Buffer.concat(parts).toString()));
});

beforeAll(async () => {
  engine = createServer(async (req, res) => {
    const body = await readAll(req);
    const path = req.url ?? '';
    calls.push({ method: req.method!, path, body, headers: req.headers });
    const send = (status: number, b?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
    if (path === '/_ping') return send(200, 'OK');
    if (path === `/containers/${hostname()}/json`) return send(200, { Id: 'e'.repeat(64), Image: IMAGE });
    if (req.method === 'POST' && path.startsWith('/containers/create')) return send(201, { Id: OURS, Warnings: [] });
    if (req.method === 'GET' && path.startsWith('/containers/json')) {
      return send(200, [
        { Id: OURS, Labels: ourLabels, State: 'running', Image: 'x', ImageID: IMAGE },
        { Id: FOREIGN, Labels: containers[FOREIGN].Config.Labels, State: 'running', Image: 'snackspot', ImageID: 'sha256:f' },
      ]);
    }
    const m = /^\/containers\/([^/]+)\/(json|start|stop|stats|logs)/.exec(path);
    if (m) {
      const c = byRef(m[1]);
      if (!c) return send(404, { message: 'No such container' });
      if (m[2] === 'logs') {
        // The Engine's multiplexed log stream: 8-byte frame headers, a line split over two stdout frames.
        const frame = (stream: number, text: string) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
        res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' });
        res.end(Buffer.concat([frame(1, 'match runner ready\nplayer jo'), frame(1, 'ined\n'), frame(2, 'warning: slow tick\n'), frame(1, 'match ended\n')]));
        return;
      }
      if (m[2] === 'json') return send(200, c);
      if (m[2] === 'stats') return send(200, {});
      return send(204);
    }
    send(200, { message: 'the engine would have done this' });
  });
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', () => r()));
  gate = new DockerGate({
    upstream: `http://127.0.0.1:${(engine.address() as AddressInfo).port}`, secret: SECRET, host: '127.0.0.1', port: 0,
    image: '', network: 'bunkcraft_match', owner: 'bunkcraft', maxCpus: 1, maxMemoryMb: 256, maxPids: 64,
  });
  await gate.start();
  gateBase = `http://127.0.0.1:${gate.port}`;
});
afterAll(async () => { await gate.close(); engine.close(); });
beforeEach(() => { calls.length = 0; });

/** A raw request: the path goes out exactly as written (fetch would normalise it). */
function raw(method: string, path: string, opts: { body?: string | Buffer; headers?: Record<string, string>; secret?: string | null; chunked?: boolean } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.secret === null ? {} : { authorization: `Bearer ${opts.secret ?? SECRET}` }), ...opts.headers };
    if (opts.body !== undefined && !opts.chunked) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = request(`${gateBase}${path.startsWith('/') ? '' : '/'}`, { method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
      res.on('error', reject);
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (opts.chunked && opts.body !== undefined) { req.write(opts.body); req.end(); } else req.end(opts.body);
  });
}

const spec = () => buildMatchSpec({
  id: RUNNER, key: 'k'.repeat(43), image: IMAGE, network: 'bunkcraft_match', controlUrl: 'http://bunkcraft:3001', owner: 'bunkcraft',
  cpus: 1, memoryMb: 256, pids: 64, logLevel: 'info', version: '1.1.7',
});
const create = (body: unknown, name = `bunkcraft-match-${RUNNER}`, extra = '') =>
  raw('POST', `/containers/create?name=${name}${extra}`, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const engineSaw = (pred: (c: Call) => boolean) => calls.some(pred);

describe('Docker gate: what passes', () => {
  it('resolves the image of its own container and tells the control plane', async () => {
    expect(gate.image).toBe(IMAGE);
    const r = await raw('GET', '/_gate/image');
    expect(JSON.parse(r.body)).toEqual({ image: IMAGE });
  });

  it('the DockerDriver works through it end to end: ping, image, create, start, list, stats, stop', async () => {
    const d = new DockerDriver({
      api: new DockerApi(gateBase, SECRET), image: '', network: 'bunkcraft_match', controlUrl: 'http://bunkcraft:3001', owner: 'bunkcraft',
      cpus: 1, memoryMb: 256, pids: 64, logLevel: 'info', version: '1.1.7',
    });
    await d.init();
    expect(d.image).toBe(IMAGE);
    const h = await d.start(RUNNER, 'k'.repeat(43));
    expect(h.ref).toBe(OURS);
    expect(await d.list()).toEqual([{ id: RUNNER, ref: OURS, image: IMAGE, version: undefined }]);
    expect(await d.stats(h)).toBeNull(); // the fake has no numbers; the call itself passed
    await d.stop(h);
    expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      'GET /_ping', 'POST /containers/create', `GET /containers/${OURS}/json`, `POST /containers/${OURS}/start`,
      'GET /containers/json', `GET /containers/${OURS}/json`, `GET /containers/${OURS}/stats`, `GET /containers/${OURS}/json`, `POST /containers/${OURS}/stop`,
    ]);
  });

  it('forwards the create body it validated, re-serialised', async () => {
    const s = spec();
    expect((await create(s.body)).status).toBe(201);
    const sent = calls.find((c) => c.path.startsWith('/containers/create'))!;
    expect(sent.path).toBe(`/containers/create?name=bunkcraft-match-${RUNNER}`);
    expect(JSON.parse(sent.body)).toEqual(s.body);
  });

  it('accepts an API version prefix and acts on our container by name or id, by its full id', async () => {
    expect((await raw('POST', `/v1.41/containers/bunkcraft-match-${RUNNER}/stop?t=5`)).status).toBe(204);
    expect(calls.at(-1)!.path).toBe(`/containers/${OURS}/stop?t=5`);
    expect((await raw('GET', `/v1.47/containers/${OURS.slice(0, 12)}/json`)).status).toBe(200);
  });

  it('lists only our containers, whatever filter was asked for', async () => {
    const r = await raw('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['x=y'] }))}`);
    expect(JSON.parse(r.body).map((c: { Id: string }) => c.Id)).toEqual([OURS]);
    const filters = JSON.parse(decodeURIComponent(calls[0].path.split('filters=')[1])) as { label: string[] };
    expect(filters.label).toEqual([`${LABEL_ROLE}=match`, `${LABEL_OWNER}=bunkcraft`]);
  });

  it('hands out the last log lines of our container, demultiplexed, never following', async () => {
    const r = await raw('GET', `/v1.41/containers/${OURS}/logs?stdout=1&stderr=1&tail=200`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).lines).toEqual([
      { stream: 'out', text: 'match runner ready' }, { stream: 'out', text: 'player joined' },
      { stream: 'err', text: 'warning: slow tick' }, { stream: 'out', text: 'match ended' },
    ]);
    const asked = calls.find((c) => c.path.includes('/logs'))!;
    expect(asked.path).toBe(`/containers/${OURS}/logs?stdout=1&stderr=1&follow=0&tail=200`);
    // The driver reads it through the gate the same way.
    const api = new DockerApi(gateBase, SECRET);
    expect((await api.logs(OURS, 2)).map((l) => l.text)).toEqual(['warning: slow tick', 'match ended']);
  });

  it('refuses the logs of containers that are not ours', async () => {
    expect((await raw('GET', `/containers/${FOREIGN}/logs?tail=10`)).status).toBe(403);
    expect((await raw('GET', `/containers/${IMPOSTOR}/logs?tail=10`)).status).toBe(403);
    expect(engineSaw((c) => c.path.includes('/logs'))).toBe(false);
  });

  it('has a health endpoint that needs no secret and says nothing', async () => {
    const r = await raw('GET', '/_gate/health', { secret: null });
    expect(r).toEqual({ status: 200, body: '{"ok":true}' });
    expect(calls).toEqual([]);
  });
});

describe('Docker gate: what never reaches the Engine', () => {
  const mutate = (f: (b: Record<string, any>) => void) => { const b = JSON.parse(JSON.stringify(spec().body)); f(b); return b; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const badCreates: [string, () => Promise<{ status: number }>][] = [
    ['a privileged container', () => create(mutate((b) => { b.HostConfig.Privileged = true; }))],
    ['a lower-case privileged key (the Engine matches keys case-insensitively)', () => create(mutate((b) => { b.HostConfig.privileged = true; }))],
    ['another image', () => create(mutate((b) => { b.Image = 'alpine:latest'; }))],
    ['a bind mount of /', () => create(mutate((b) => { b.HostConfig.Binds = ['/:/host']; }))],
    ['the Docker socket as a mount', () => create(mutate((b) => { b.HostConfig.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/s' }]; }))],
    ['the host network', () => create(mutate((b) => { b.HostConfig.NetworkMode = 'host'; }))],
    ['the host PID namespace', () => create(mutate((b) => { b.HostConfig.PidMode = 'host'; }))],
    ['an added capability', () => create(mutate((b) => { b.HostConfig.CapAdd = ['SYS_ADMIN']; }))],
    ['a device', () => create(mutate((b) => { b.HostConfig.Devices = [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }]; }))],
    ['root', () => create(mutate((b) => { b.User = 'root'; }))],
    ['an entrypoint', () => create(mutate((b) => { b.Entrypoint = ['sh', '-c', 'id']; }))],
    ['a foreign owner label', () => create(mutate((b) => { b.Labels[LABEL_OWNER] = 'snackspot'; }))],
    ['a name outside our prefix', () => create(spec().body, 'snackspot-db')],
    ['a name that does not match the runner id', () => create(spec().body, 'bunkcraft-match-0000000000000000')],
    ['an extra create parameter', () => create(spec().body, `bunkcraft-match-${RUNNER}`, '&platform=linux/arm64')],
    ['a body that is not JSON', () => raw('POST', `/containers/create?name=bunkcraft-match-${RUNNER}`, { body: '{"Image":', headers: { 'content-type': 'application/json' } })],
    ['a body without a JSON content type', () => raw('POST', `/containers/create?name=bunkcraft-match-${RUNNER}`, { body: JSON.stringify(spec().body), headers: { 'content-type': 'text/plain' } })],
  ];
  for (const [what, send] of badCreates) {
    it(`refuses a create with ${what}`, async () => {
      const r = await send();
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(engineSaw((c) => c.path.startsWith('/containers/create'))).toBe(false);
    });
  }

  it('refuses an oversized create body, declared or chunked, without passing it on', async () => {
    const big = JSON.stringify({ ...spec().body, Pad: 'x'.repeat(200 * 1024) });
    const declared = await create(JSON.parse(big));
    expect(declared.status === 413 || declared.status === 0).toBe(true);
    const chunked = await raw('POST', `/containers/create?name=bunkcraft-match-${RUNNER}`, { body: big, chunked: true, headers: { 'content-type': 'application/json' } });
    expect(chunked.status === 413 || chunked.status === 0).toBe(true);
    expect(engineSaw((c) => c.path.startsWith('/containers/create'))).toBe(false);
    // The gate is fine afterwards.
    expect((await raw('GET', '/_ping')).status).toBe(200);
  });

  const foreign: [string, string, string][] = [
    ['stop a foreign container', 'POST', `/containers/${FOREIGN}/stop`],
    ['start a foreign container by name', 'POST', '/containers/snackspot-db/start'],
    ['inspect a foreign container', 'GET', `/containers/${FOREIGN}/json`],
    ['read stats of a foreign container', 'GET', `/containers/${FOREIGN}/stats?stream=false`],
    ['stop an impostor with our labels', 'POST', `/containers/${IMPOSTOR}/stop`],
  ];
  for (const [what, method, path] of foreign) {
    it(`refuses to ${what}`, async () => {
      expect((await raw(method, path)).status).toBe(403);
      // Only the ownership inspect reached the Engine, never the action.
      expect(calls.every((c) => c.method === 'GET' && c.path.endsWith('/json'))).toBe(true);
    });
  }

  it('answers 404 for a container that does not exist (the driver treats that as already gone)', async () => {
    expect((await raw('POST', `/containers/${'f'.repeat(64)}/stop?t=10`)).status).toBe(404);
  });

  const endpoints: [string, string, string, string?][] = [
    ['exec create on our container', 'POST', `/containers/${OURS}/exec`, '{"Cmd":["sh"]}'],
    ['exec start', 'POST', '/exec/0000/start', '{}'],
    ['kill', 'POST', `/containers/${OURS}/kill`],
    ['update (limits)', 'POST', `/containers/${OURS}/update`, '{"Memory":0}'],
    ['delete', 'DELETE', `/containers/${OURS}`],
    ['restart', 'POST', `/containers/${OURS}/restart`],
    ['attach', 'POST', `/containers/${OURS}/attach?stream=1`],
    ['archive (copy files in)', 'PUT', `/containers/${OURS}/archive?path=/`],
    ['logs that follow', 'GET', `/containers/${OURS}/logs?follow=1`],
    ['logs with timestamps', 'GET', `/containers/${OURS}/logs?tail=10&timestamps=1`],
    ['logs since a time', 'GET', `/containers/${OURS}/logs?since=0`],
    ['more than 500 log lines', 'GET', `/containers/${OURS}/logs?tail=501`],
    ['all log lines', 'GET', `/containers/${OURS}/logs?tail=all`],
    ['logs with a POST', 'POST', `/containers/${OURS}/logs?tail=10`],
    ['images', 'GET', '/images/json'],
    ['image pull', 'POST', '/images/create?fromImage=alpine'],
    ['build', 'POST', '/build'],
    ['volumes', 'GET', '/volumes'],
    ['networks', 'GET', '/networks'],
    ['network connect', 'POST', '/networks/bridge/connect', '{"Container":"x"}'],
    ['events', 'GET', '/events'],
    ['info', 'GET', '/info'],
    ['system df', 'GET', '/system/df'],
    ['swarm', 'GET', '/swarm'],
    ['plugins', 'GET', '/plugins'],
    ['secrets', 'GET', '/secrets'],
    ['session', 'POST', '/session'],
    ['a streaming stats call', 'GET', `/containers/${OURS}/stats`],
    ['start with a GET', 'GET', `/containers/${OURS}/start`],
    ['inspect with a POST', 'POST', `/containers/${OURS}/json`],
    ['a stop with a huge timeout', 'POST', `/containers/${OURS}/stop?t=99999`],
    ['a start with a body', 'POST', `/containers/${OURS}/start`, '{"Binds":["/:/h"]}'],
  ];
  for (const [what, method, path, body] of endpoints) {
    it(`refuses ${what}`, async () => {
      const r = await raw(method, path, body ? { body, headers: { 'content-type': 'application/json' } } : {});
      // 403 for an endpoint the gate does not know (before reading any body), 413 for a body where none belongs.
      expect(r.status).toBe(what === 'a start with a body' ? 413 : 403);
      expect(engineSaw((c) => !(c.method === 'GET' && c.path.endsWith('/json')))).toBe(false);
    });
  }

  const tricks: [string, string, string][] = [
    ['a dot-dot segment', 'GET', `/containers/${OURS}/../../images/json`],
    ['a percent-encoded slash', 'POST', `/containers/${OURS}%2F..%2Fexec/start`],
    ['a percent-encoded dot-dot', 'GET', '/containers/%2e%2e/images/json'],
    ['a double slash', 'GET', '//containers/json'],
    ['a backslash', 'GET', '/containers\\json'],
    ['a version prefix on a forbidden endpoint', 'GET', '/v1.41/images/json'],
    ['two version prefixes', 'GET', '/v1.41/v1.41/containers/json'],
    ['an absolute URL', 'GET', 'http://evil/containers/json'],
    ['a dot segment', 'GET', '/./images/json'],
    ['a query that adds a parameter to inspect', 'GET', `/containers/${OURS}/json?size=1`],
    ['a repeated query parameter', 'POST', `/containers/${OURS}/stop?t=1&t=2`],
  ];
  for (const [what, method, path] of tricks) {
    it(`refuses ${what}`, async () => {
      expect((await raw(method, path)).status).toBeGreaterThanOrEqual(400);
      expect(engineSaw((c) => c.path.includes('images') || c.path.includes('exec') || !c.path.endsWith('/json'))).toBe(false);
    });
  }

  it('refuses every request without the secret, or with a wrong one', async () => {
    expect((await raw('GET', '/_ping', { secret: null })).status).toBe(401);
    expect((await raw('GET', '/containers/json', { secret: 'x'.repeat(40) })).status).toBe(401);
    expect((await create(spec().body).then(() => raw('POST', `/containers/${OURS}/start`, { secret: SECRET.slice(1) }))).status).toBe(401);
    expect(engineSaw((c) => c.path.includes('/start'))).toBe(false);
  });

  it('never passes client headers on', async () => {
    await raw('GET', '/_ping', { headers: { 'x-registry-auth': 'secret', 'x-forwarded-for': '1.2.3.4' } });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].headers).sort()).toEqual(['connection', 'content-length', 'host']);
  });

  it('normalizePath strips only a leading API version', () => {
    expect(normalizePath('/v1.41/containers/json?x=1').path).toBe('/containers/json');
    expect(() => normalizePath('/containers/a%2Fb/json')).toThrow();
    expect(() => normalizePath('')).toThrow();
  });

  it('will not start without a real secret', () => {
    expect(() => new DockerGate({
      upstream: 'unix:///var/run/docker.sock', secret: 'short', host: '127.0.0.1', port: 0, image: IMAGE, network: 'n', owner: 'o', maxCpus: 1, maxMemoryMb: 256, maxPids: 64,
    })).toThrow(/at least 32/);
  });
});
