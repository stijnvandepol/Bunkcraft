import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodePng } from '../server/skins/Png';
import { ProfileService } from '../server/progression/ProfileService';
import { SkinService, skinHashOf } from '../server/skins/SkinService';
import type { ClientMessage, RosterEntry, ServerMessage } from '../src/net/protocol';
import { canonicalSkin, isSkinHash, isUsedPixel } from '../src/skins/SkinFormat';
import { coordinateRgba, makePng, noise, pngOfRgba } from './helpers/png';
import { type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';

const stoppers: TestServer[] = [];
const dirs: string[] = [];
const services: ProfileService[] = [];
afterEach(async () => {
  const all = stoppers.splice(0);
  for (const t of all) await t.stop();
  for (const t of all) cleanup(t.dir);
  services.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function start(env: Record<string, string> = {}): Promise<TestServer> {
  const t = await startTestServer({ ADMIN_TOKEN: 'admin-token-for-skin-tests', ...env });
  stoppers.push(t);
  return t;
}

const ADMIN = { authorization: 'Bearer admin-token-for-skin-tests' };

async function newProfile(t: TestServer, name = 'alice'): Promise<{ token: string; id: string }> {
  const res = await fetch(`${t.base}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  expect(res.status).toBe(201);
  const body = await res.json() as { token: string; profile: { id: string } };
  return { token: body.token, id: body.profile.id };
}

function upload(t: TestServer, token: string | null, body: Uint8Array | string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${t.base}/api/profile/skin`, {
    method: 'POST', headers: { 'content-type': 'image/png', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : new Blob([Buffer.from(body)]),
  });
}

const skinFile = (seed = 0): Uint8Array => {
  const px = coordinateRgba();
  px[(10 * 64 + 10) * 4] = seed & 0xff;
  px[(10 * 64 + 11) * 4] = (seed >> 8) & 0xff;
  return pngOfRgba(px);
};

describe('skin upload API', () => {
  it('stores a valid skin canonically, tied to the profile, and serves it with long cache headers', async () => {
    const t = await start();
    const { token } = await newProfile(t);
    const file = skinFile(1);
    const res = await upload(t, token, file);
    expect(res.status).toBe(200);
    const body = await res.json() as { hash: string; created: boolean; profile: { skin: string } };
    expect(isSkinHash(body.hash)).toBe(true);
    expect(body.created).toBe(true);
    expect(body.profile.skin).toBe(body.hash);

    const served = await fetch(`${t.base}/skins/${body.hash}.png`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(served.headers.get('cache-control')).toContain('max-age=31536000');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await served.arrayBuffer());
    // What we serve is OUR encoding of the pixels, not the uploaded bytes, and hashes to the id.
    expect(Buffer.from(bytes).equals(Buffer.from(file))).toBe(false);
    const decoded = decodePng(bytes);
    expect(skinHashOf(decoded.rgba)).toBe(body.hash);
    expect(Buffer.from(decoded.rgba).equals(Buffer.from(canonicalSkin(decodePng(file).rgba, 64, 64)!))).toBe(true);

    // The profile remembers it.
    const prof = await (await fetch(`${t.base}/api/profile`, { headers: { authorization: `Bearer ${token}` } })).json() as { profile: { skin: string } };
    expect(prof.profile.skin).toBe(body.hash);
    expect(readdirSync(join(t.dir, 'skins'))).toEqual([`${body.hash}.png`]);
  });

  it('needs a valid profile token', async () => {
    const t = await start();
    expect((await upload(t, null, skinFile())).status).toBe(401);
    expect((await upload(t, 'v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', skinFile())).status).toBe(401);
    expect((await upload(t, 'garbage', skinFile())).status).toBe(401);
    expect(readdirSync(join(t.dir, 'skins'))).toEqual([]);
  });

  it('dedups: the same pixels from two profiles, in different encodings, are one file', async () => {
    const t = await start();
    const a = await newProfile(t, 'alice');
    const b = await newProfile(t, 'bobby');
    const px = coordinateRgba();
    const first = await (await upload(t, a.token, pngOfRgba(px, 64, 64, 0))).json() as { hash: string; created: boolean };
    const second = await (await upload(t, b.token, pngOfRgba(px, 64, 64, 4))).json() as { hash: string; created: boolean };
    expect(second.hash).toBe(first.hash);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(readdirSync(join(t.dir, 'skins'))).toHaveLength(1);
    expect(t.server.skins!.count).toBe(1);
  });

  it('rate limits uploads per profile, not per address', async () => {
    const t = await start({ SKIN_UPLOAD_LIMIT: '3' });
    const a = await newProfile(t, 'alice');
    const b = await newProfile(t, 'bobby');
    for (let i = 0; i < 3; i++) expect((await upload(t, a.token, skinFile(i))).status).toBe(200);
    const limited = await upload(t, a.token, skinFile(9));
    expect(limited.status).toBe(429);
    expect((await limited.json() as { code: string }).code).toBe('rate');
    // Invalid files count too (they cost CPU), and another profile on the same address is not affected.
    expect((await upload(t, b.token, 'not a png')).status).toBe(400);
    expect((await upload(t, b.token, skinFile(20))).status).toBe(200);
  });

  it('refuses everything that is not a clean classic skin, with a reason', async () => {
    const t = await start({ SKIN_UPLOAD_LIMIT: '50' });
    const { token } = await newProfile(t);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>';
    const cases: [string, Uint8Array | string, number, string][] = [
      ['svg', svg, 400, 'not-png'],
      ['garbage', noise(500), 400, 'not-png'],
      ['wrong size', pngOfRgba(new Uint8Array(32 * 32 * 4), 32, 32), 400, 'size'],
      ['corrupt', makePng({ badCrc: 'IDAT' }), 400, 'corrupt'],
      ['animated', makePng({ extra: [['acTL', new Uint8Array(8)]] }), 400, 'animated'],
      ['interlaced', makePng({ interlace: 1 }), 400, 'interlaced'],
      ['too large', makePng({ extra: [['tEXt', new Uint8Array(20000)]] }), 413, 'too-large'],
    ];
    for (const [label, body, status, code] of cases) {
      const res = await upload(t, token, body);
      expect(res.status, label).toBe(status);
      expect((await res.json() as { code: string }).code, label).toBe(code);
    }
    expect(readdirSync(join(t.dir, 'skins'))).toEqual([]);
  });

  it('converts a legacy 64x32 file to the canonical 64x64 skin', async () => {
    const t = await start();
    const { token } = await newProfile(t);
    const res = await upload(t, token, makePng({ height: 32, pixels: coordinateRgba(64, 32) }));
    expect(res.status).toBe(200);
    const { hash } = await res.json() as { hash: string };
    const decoded = decodePng(new Uint8Array(await (await fetch(`${t.base}/skins/${hash}.png`)).arrayBuffer()));
    expect(decoded.height).toBe(64);
    // The left leg (mirrored copy) exists in the stored skin.
    expect(decoded.rgba[(52 * 64 + 20) * 4 + 3]).toBe(255);
  });

  it('removes a skin with DELETE and serves 404 for unknown hashes and odd paths', async () => {
    const t = await start();
    const { token } = await newProfile(t);
    const { hash } = await (await upload(t, token, skinFile())).json() as { hash: string };
    const del = await fetch(`${t.base}/api/profile/skin`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { profile: { skin: string } }).profile.skin).toBe('');
    for (const path of [`/skins/${'0'.repeat(64)}.png`, '/skins/nothing.png', `/skins/${hash.toUpperCase()}.png`, `/skins/../package.json`, `/skins/${hash}.png.html`]) {
      expect((await fetch(`${t.base}${path}`)).status, path).toBe(404);
    }
  });

  it('is off with SKINS=off', async () => {
    const t = await start({ SKINS: 'off' });
    const { token } = await newProfile(t);
    expect((await upload(t, token, skinFile())).status).toBe(404);
    expect((await fetch(`${t.base}/api/server`).then((r) => r.json()) as { features: { skins: boolean } }).features.skins).toBe(false);
    expect((await fetch(`${t.base}/api/admin/skins`, { headers: ADMIN })).status).toBe(404);
  });

  it('announces the feature on /api/server', async () => {
    const t = await start();
    expect((await fetch(`${t.base}/api/server`).then((r) => r.json()) as { features: { skins: boolean } }).features.skins).toBe(true);
  });
});

describe('moderation: reports and banned hashes', () => {
  it('never serves, accepts or distributes a banned hash', async () => {
    const t = await start();
    const a = await newProfile(t, 'alice');
    const file = skinFile(5);
    const { hash } = await (await upload(t, a.token, file)).json() as { hash: string };
    expect((await fetch(`${t.base}/skins/${hash}.png`)).status).toBe(200);

    expect((await fetch(`${t.base}/api/admin/skins/ban`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ hash }) })).status).toBe(200);
    expect((await fetch(`${t.base}/skins/${hash}.png`)).status).toBe(404);
    // Uploading the same pixels again is refused, whatever the file looks like.
    const again = await upload(t, a.token, skinFile(5));
    expect(again.status).toBe(403);
    expect((await again.json() as { code: string }).code).toBe('banned');
    // The profile does not hand it out any more.
    const prof = await (await fetch(`${t.base}/api/profile`, { headers: { authorization: `Bearer ${a.token}` } })).json() as { profile: { skin: string } };
    expect(prof.profile.skin).toBe('');
    const list = await (await fetch(`${t.base}/api/admin/skins`, { headers: ADMIN })).json() as { bans: string[] };
    expect(list.bans).toEqual([hash]);

    // Unbanning serves it again.
    await fetch(`${t.base}/api/admin/skins/unban`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ hash }) });
    expect((await fetch(`${t.base}/skins/${hash}.png`)).status).toBe(200);
  });

  it('the admin routes need the admin token and a real hash', async () => {
    const t = await start();
    expect((await fetch(`${t.base}/api/admin/skins`)).status).toBe(401);
    expect((await fetch(`${t.base}/api/admin/skins/ban`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ hash: '../../x' }) })).status).toBe(400);
  });

  it('shows the skin to other players in welcome, join and skin messages; reports reach the admin list; a ban clears it live', async () => {
    const t = await start();
    const alice = await newProfile(t, 'alice');
    const bob = await newProfile(t, 'bobby');
    const { hash } = await (await upload(t, alice.token, skinFile(7))).json() as { hash: string };
    const { code } = await createRoom(t.base);

    const a = await joinGame(t, code, 'alice', { profile: alice.token });
    const b = await joinGame(t, code, 'bobby', { profile: bob.token });
    // Bob's welcome lists Alice with her skin; Bob has none.
    expect(b.welcome.players.find((p) => p.name === 'alice')?.skin).toBe(hash);
    expect(b.welcome.players.find((p) => p.name === 'bobby')?.skin).toBeUndefined();
    // Alice saw Bob join without a skin field.
    const join = await a.client.waitFor('join', (m) => m.name === 'bobby');
    expect(join.skin).toBeUndefined();

    // Bob uploads one while playing: both are told with a `skin` message.
    const bobSkin = await (await upload(t, bob.token, skinFile(8))).json() as { hash: string };
    const seen = await a.client.waitFor('skin', (m) => m.skin === bobSkin.hash);
    expect(seen.id).toBe(b.welcome.id);
    await b.client.waitFor('skin', (m) => m.skin === bobSkin.hash);

    // Bob reports Alice's skin (by player id): the admin list has it, once per reporter.
    b.client.send({ t: 'skinreport', id: a.welcome.id } satisfies ClientMessage);
    b.client.send({ t: 'skinreport', id: a.welcome.id } satisfies ClientMessage);
    b.client.send({ t: 'skinreport', id: b.welcome.id } satisfies ClientMessage); // yourself: ignored
    await new Promise((r) => setTimeout(r, 200));
    const reports = await (await fetch(`${t.base}/api/admin/skins`, { headers: ADMIN })).json() as { reports: { hash: string; count: number; names: string[] }[] };
    expect(reports.reports).toHaveLength(1);
    expect(reports.reports[0]).toMatchObject({ hash, count: 1, names: ['alice'] });

    // Ban: everybody in the game is told her skin is gone, and a late joiner never sees it.
    await fetch(`${t.base}/api/admin/skins/ban`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ hash }) });
    const gone = await b.client.waitFor('skin', (m) => m.id === a.welcome.id && m.skin === '');
    expect(gone.skin).toBe('');
    const late = await joinGame(t, code, 'carol1', {});
    expect(late.welcome.players.find((p) => p.name === 'alice')?.skin).toBeUndefined();
    for (const c of [a.client, b.client, late.client]) c.close();
  });

  it('puts the skin in the arcade roster (sk) for lobbies', async () => {
    const t = await start({ QUICKPLAY_BOTS: '0' });
    const alice = await newProfile(t, 'alice');
    const { hash } = await (await upload(t, alice.token, skinFile(11))).json() as { hash: string };
    const { code } = await createRoom(t.base, { gameType: 'tdm' });
    const a = await joinGame(t, code, 'alice', { profile: alice.token });
    const roster = await a.client.waitFor('roster', (m) => m.players.some((p) => p.sk === hash));
    expect((roster.players as RosterEntry[]).find((p) => p.name === 'alice')?.sk).toBe(hash);
    a.client.close();
  });

  it('round-trips the protocol fields through JSON', () => {
    const msgs: ServerMessage[] = [
      { t: 'skin', id: 3, skin: 'a'.repeat(64) },
      { t: 'join', id: 3, name: 'alice', skin: 'b'.repeat(64) },
    ];
    for (const m of msgs) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    const report: ClientMessage = { t: 'skinreport', id: 4 };
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('SkinService storage', () => {
  it('stops accepting new skins at the storage cap but still serves and dedups the existing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-skinstore-'));
    dirs.push(dir);
    const profiles = new ProfileService({ dataDir: dir, maxProfiles: 10, secret: 'skin-store-test-secret-1' });
    services.push(profiles);
    const alice = profiles.create('alice')!;
    const noisy = (seed: number) => {
      // Noise in every pixel a skin uses: the worst case for the size of the stored file.
      const px = new Uint8Array(64 * 64 * 4);
      const n = noise(64 * 64 * 4, seed);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (isUsedPixel(x, y)) { px.set(n.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4), (y * 64 + x) * 4); px[(y * 64 + x) * 4 + 3] = 255; }
      return pngOfRgba(px);
    };
    // Room for one noisy skin (about 11.5 KB) but not two.
    const skins = new SkinService({ dataDir: dir, profiles, maxBytes: 20_000, uploadsPerHour: 50 });
    const id = alice.profile.id;
    const first = skins.upload(id, noisy(1));
    expect(first.ok).toBe(true);
    const second = skins.upload(id, noisy(2));
    expect(second).toMatchObject({ ok: false, status: 507, code: 'storage' });
    expect(skins.storedBytes).toBeLessThanOrEqual(20_000);
    // The same skin again is a dedup hit: no new bytes, no storage error.
    expect(skins.upload(id, noisy(1))).toMatchObject({ ok: true, created: false });
    expect(skins.count).toBe(1);
    // A fresh service on the same directory finds what is stored.
    const reopened = new SkinService({ dataDir: dir, profiles, maxBytes: 20_000, uploadsPerHour: 50 });
    expect(reopened.count).toBe(1);
    expect(reopened.storedBytes).toBe(skins.storedBytes);
  });

  it('keeps bans and reports across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-skinmod-'));
    dirs.push(dir);
    const profiles = new ProfileService({ dataDir: dir, maxProfiles: 10, secret: 'skin-store-test-secret-2' });
    services.push(profiles);
    const p = profiles.create('alice')!;
    const skins = new SkinService({ dataDir: dir, profiles, maxBytes: 1_000_000, uploadsPerHour: 50 });
    const up = skins.upload(p.profile.id, skinFile(3));
    if (!up.ok) throw new Error('upload failed');
    expect(skins.report(up.hash, 'someone', 'alice')).toBe(true);
    expect(skins.report(up.hash, 'someone', 'alice')).toBe(false);
    expect(skins.report('f'.repeat(64), 'someone', 'x')).toBe(false); // unknown skin
    skins.ban(up.hash);
    const again = new SkinService({ dataDir: dir, profiles, maxBytes: 1_000_000, uploadsPerHour: 50 });
    expect(again.isBanned(up.hash)).toBe(true);
    expect(again.read(up.hash)).toBeNull();
    expect(again.listReports()).toMatchObject([{ hash: up.hash, count: 1, banned: true }]);
  });
});
