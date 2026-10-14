/**
 * The Docker driver and the runner pool against a fake Docker Engine API (what the socket proxy forwards): which
 * calls are made, what the create body looks like, and that containers of other owners are never touched.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABEL_OWNER, LABEL_ROLE, LABEL_RUNNER, validateMatchSpec } from '../../server/match/ContainerSpec';
import { DockerApi, DockerDriver } from '../../server/match/Drivers';
import { MatchPool } from '../../server/match/MatchPool';

interface Call { method: string; path: string; body: unknown }
const calls: Call[] = [];
let server: Server;
let base = '';
let createStatus = 201;
const IMAGE = 'sha256:' + 'b'.repeat(64);

const read = (req: IncomingMessage) => new Promise<unknown>((r) => {
  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => parts.push(c));
  req.on('end', () => { const t = Buffer.concat(parts).toString(); r(t ? JSON.parse(t) : null); });
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await read(req);
    const path = (req.url ?? '').replace(/^\/v1\.41/, '');
    calls.push({ method: req.method!, path, body });
    const send = (status: number, b?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
    if (path === '/_ping') return send(200, 'OK');
    if (req.method === 'GET' && path === `/containers/${hostname()}/json`) return send(200, { Id: 'self', Image: IMAGE, Config: { Image: 'ghcr.io/x/bunkcraft:latest' } });
    if (req.method === 'POST' && path.startsWith('/containers/create')) return createStatus === 201 ? send(201, { Id: `c-${calls.length}` }) : send(createStatus, { message: 'denied by proxy' });
    if (req.method === 'POST' && /\/containers\/[^/]+\/(start|stop)/.test(path)) return send(204);
    if (req.method === 'GET' && path.startsWith('/containers/json')) {
      return send(200, [
        { Id: 'ours', Image: 'x', ImageID: IMAGE, State: 'running', Labels: { [LABEL_ROLE]: 'match', [LABEL_OWNER]: 'bunkcraft', [LABEL_RUNNER]: 'abcdef0123456789' } },
        // The socket proxy shows every container on the host: a foreign one must be ignored even if it lies in its labels.
        { Id: 'snackspot', Image: 'snackspot', ImageID: 'sha256:c', State: 'running', Labels: { [LABEL_ROLE]: 'match', [LABEL_OWNER]: 'snackspot', [LABEL_RUNNER]: 'abcdef0123456780' } },
        { Id: 'weird', Image: 'x', ImageID: 'x', State: 'running', Labels: { [LABEL_ROLE]: 'match', [LABEL_OWNER]: 'bunkcraft', [LABEL_RUNNER]: '../../etc' } },
        { Id: 'exited', Image: 'x', ImageID: 'x', State: 'exited', Labels: { [LABEL_ROLE]: 'match', [LABEL_OWNER]: 'bunkcraft', [LABEL_RUNNER]: 'abcdef0123456781' } },
      ]);
    }
    if (req.method === 'GET' && /\/containers\/[^/]+\/stats/.test(path)) {
      return send(200, {
        cpu_stats: { cpu_usage: { total_usage: 3e9 }, system_cpu_usage: 20e9, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 10e9 },
        memory_stats: { usage: 120e6, limit: 256 * 1048576, stats: { inactive_file: 20e6 } },
      });
    }
    send(404, { message: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const driver = () => new DockerDriver({
  api: new DockerApi(base), image: '', network: 'bunkcraft_match', controlUrl: 'http://bunkcraft:3001', owner: 'bunkcraft',
  cpus: 1, memoryMb: 256, pids: 64, logLevel: 'info', version: '1.1.7+abc',
});

describe('Docker driver against a fake Engine API', () => {
  it('pins new matches to the image of its own container', async () => {
    const d = driver();
    await d.init();
    expect(d.image).toBe(IMAGE);
  });

  it('creates and starts exactly the validated spec, and stops by container id', async () => {
    const d = driver();
    await d.init();
    calls.length = 0;
    const h = await d.start('abcdef0123456789', 'k'.repeat(43));
    expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['POST /containers/create', `POST /containers/${h.ref}/start`]);
    expect(calls[0].path).toContain('name=bunkcraft-match-abcdef0123456789');
    const body = calls[0].body as Record<string, unknown>;
    expect(() => validateMatchSpec({ name: 'bunkcraft-match-abcdef0123456789', body }, {
      image: IMAGE, network: 'bunkcraft_match', owner: 'bunkcraft', maxCpus: 1, maxMemoryMb: 256, maxPids: 64,
    })).not.toThrow();
    expect(d.urlFor(h)).toBe('http://bunkcraft-match-abcdef0123456789:3100');
    calls.length = 0;
    await d.stop(h);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /containers/${h.ref}/stop?t=10`]);
  });

  it('lists only running containers of its own owner with a valid runner id', async () => {
    const d = driver();
    const found = await d.list();
    expect(found).toEqual([{ id: 'abcdef0123456789', ref: 'ours', image: IMAGE, version: undefined }]);
    const list = calls.find((c) => c.path.startsWith('/containers/json'))!;
    const filters = JSON.parse(decodeURIComponent(list.path.split('filters=')[1])) as { label: string[] };
    expect(filters.label).toEqual([`${LABEL_ROLE}=match`, `${LABEL_OWNER}=bunkcraft`]);
  });

  it('reads CPU and memory like docker stats', async () => {
    const s = await driver().stats({ id: 'abcdef0123456789', ref: 'ours' });
    expect(s!.cpu).toBeCloseTo(0.4, 5); // 1e9 of 10e9 system time on 4 CPUs
    expect(s!.memBytes).toBe(100e6);
    expect(s!.memLimitBytes).toBe(256 * 1048576);
  });

  it('a create the socket proxy refuses fails the lease and is counted, nothing is left behind', async () => {
    const d = driver();
    await d.init();
    createStatus = 403;
    try {
      const pool = new MatchPool({ driver: d, secret: 's'.repeat(32), warm: 0, max: 2 });
      calls.length = 0;
      await expect(pool.lease()!).rejects.toThrow(/denied by proxy/);
      expect(pool.counters.startFailures).toBe(1);
      expect(pool.count()).toBe(0);
      expect(calls.some((c) => c.path.includes('/start'))).toBe(false);
    } finally {
      createStatus = 201;
    }
  });
});
