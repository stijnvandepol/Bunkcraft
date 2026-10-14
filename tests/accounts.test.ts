import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPassword, checkUsername } from '../src/modes/progression/AccountRules';
import { AccountService, type ProfileHooks, newRecoveryCode, normalizeRecoveryCode } from '../server/accounts/AccountService';
import { ProfileService } from '../server/progression/ProfileService';

let dir: string;
let svc: AccountService;
let profiles: Set<string>;
let n = 0;
const hooks = (): ProfileHooks => ({
  create: () => { const id = `profile${String(++n).padStart(10, '0')}`; profiles.add(id); return id; },
  exists: (id) => profiles.has(id),
  rename: () => undefined,
  remove: (id) => { profiles.delete(id); },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunk-acc-'));
  profiles = new Set();
  svc = new AccountService({ dataDir: dir, maxAccounts: 100, profiles: hooks(), lockBaseMs: 1000 });
});
afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('account rules', () => {
  it('follows the gamertag rules', () => {
    expect(checkUsername('Stijn_01')).toBeNull();
    expect(checkUsername('ab')).toBe('username_format');
    expect(checkUsername('a'.repeat(17))).toBe('username_format');
    expect(checkUsername('no spaces')).toBe('username_format');
    expect(checkUsername('Admin')).toBe('username_reserved');
    expect(checkUsername(42)).toBe('username_format');
  });
  it('checks password length and the common list', () => {
    expect(checkPassword('short')).toBe('password_short');
    expect(checkPassword('Password123')).toBe('password_common');
    expect(checkPassword('aaaaaaaaaa')).toBe('password_common');
    expect(checkPassword('x'.repeat(65))).toBe('password_long');
    expect(checkPassword('Stijn_01', 'stijn_01')).toBe('password_name');
    expect(checkPassword('correct horse battery')).toBeNull();
  });
});

describe('recovery codes', () => {
  it('are long, grouped and forgiving to type', () => {
    const c = newRecoveryCode();
    expect(c).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(newRecoveryCode()).not.toBe(c);
    expect(normalizeRecoveryCode(c.toLowerCase().replace(/-/g, ' '))).toBe(normalizeRecoveryCode(c));
  });
});

describe('AccountService', () => {
  const PW = 'correct horse battery';

  it('registers, stores only hashes, and the session resolves to the profile', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    expect(r.token).toMatch(/^s1\./);
    expect(svc.verifySession(r.token)).toBe(r.profileId);
    const files = readdirSync(join(dir, 'accounts')).flatMap((s) => readdirSync(join(dir, 'accounts', s)).map((f) => join(dir, 'accounts', s, f)));
    expect(files).toHaveLength(1);
    const raw = readFileSync(files[0], 'utf8');
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain(r.recovery);
    expect(raw).not.toContain(r.token.split('.')[2]);
    expect(raw).toContain('scrypt$');
    if (process.platform !== 'win32') expect(statSync(files[0]).mode & 0o077).toBe(0);
  });

  it('refuses a taken name (case-insensitive) and bad input', async () => {
    await svc.register('Stijn_01', PW);
    expect(await svc.register('STIJN_01', PW)).toMatchObject({ ok: false, error: 'name_taken' });
    expect(await svc.register('x', PW)).toMatchObject({ ok: false, error: 'username_format' });
    expect(await svc.register('Other_1', 'short')).toMatchObject({ ok: false, error: 'password_short' });
  });

  it('links a guest profile to the account', async () => {
    profiles.add('guestprofile0001');
    const r = await svc.register('Linked_1', PW, 'guestprofile0001');
    if (!r.ok) throw new Error(r.error);
    expect(r.profileId).toBe('guestprofile0001');
    expect(svc.isLinked('guestprofile0001')).toBe(true);
    // The same guest profile cannot be claimed twice.
    const again = await svc.register('Linked_2', PW, 'guestprofile0001');
    if (!again.ok) throw new Error(again.error);
    expect(again.profileId).not.toBe('guestprofile0001');
  });

  it('logs in with the same profile, rotating the presented session', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    const l = await svc.login('stijn_01', PW, r.token);
    if (!l.ok) throw new Error(l.error);
    expect(l.profileId).toBe(r.profileId);
    expect(l.token).not.toBe(r.token);
    expect(svc.verifySession(r.token)).toBeNull();
    expect(svc.verifySession(l.token)).toBe(r.profileId);
  });

  it('answers wrong password and unknown name identically', async () => {
    await svc.register('Stijn_01', PW);
    const a = await svc.login('Stijn_01', 'wrong password!');
    const b = await svc.login('Nobody_99', 'wrong password!');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: false, status: 401, error: 'invalid_credentials' });
  });

  it('locks a name with doubling backoff, whether or not it exists', async () => {
    await svc.register('Stijn_01', PW);
    for (let i = 0; i < 5; i++) await svc.login('Stijn_01', 'nope nope nope');
    const locked = await svc.login('Stijn_01', PW);
    expect(locked).toMatchObject({ ok: false, status: 429, error: 'locked' });
    for (let i = 0; i < 5; i++) await svc.login('Ghost_01', 'nope nope nope');
    expect(await svc.login('Ghost_01', 'x')).toMatchObject({ status: 429, error: 'locked' });
  });

  it('logout kills the session on the server', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    expect(svc.logout(r.token)).toBe(true);
    expect(svc.verifySession(r.token)).toBeNull();
  });

  it('expires sessions', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    expect(svc.verifySession(r.token, Date.now() + 31 * 86_400_000)).toBeNull();
  });

  it('changes the password and ends the other sessions', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    const other = await svc.login('Stijn_01', PW);
    if (!other.ok) throw new Error(other.error);
    expect(await svc.changePassword(r.token, 'wrong wrong wrong', 'another long pass')).toMatchObject({ ok: false, error: 'invalid_credentials' });
    const c = await svc.changePassword(r.token, PW, 'another long pass');
    if (!c.ok) throw new Error(c.error);
    expect(svc.verifySession(other.token)).toBeNull();
    expect(svc.verifySession(c.token)).toBe(r.profileId);
    expect((await svc.login('Stijn_01', PW)).ok).toBe(false);
    expect((await svc.login('Stijn_01', 'another long pass')).ok).toBe(true);
  });

  it('recovers with the code once, then hands out a new code', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    expect(await svc.recover('Stijn_01', newRecoveryCode(), 'brand new password')).toMatchObject({ ok: false, error: 'invalid_credentials' });
    expect(await svc.recover('Ghost_01', newRecoveryCode(), 'brand new password')).toMatchObject({ ok: false, error: 'invalid_credentials' });
    const rec = await svc.recover('stijn_01', r.recovery.toLowerCase(), 'brand new password');
    if (!rec.ok) throw new Error(rec.error);
    expect(rec.recovery).not.toBe(r.recovery);
    expect(svc.verifySession(r.token)).toBeNull();
    expect((await svc.login('Stijn_01', 'brand new password')).ok).toBe(true);
    expect(await svc.recover('Stijn_01', r.recovery, 'yet another password')).toMatchObject({ ok: false });
  });

  it('deletes the account and its profile only with the password', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    expect(await svc.remove(r.token, 'wrong wrong wrong')).toMatchObject({ ok: false });
    expect(profiles.has(r.profileId)).toBe(true);
    expect((await svc.remove(r.token, PW)).ok).toBe(true);
    expect(profiles.has(r.profileId)).toBe(false);
    expect(svc.verifySession(r.token)).toBeNull();
    expect((await svc.login('Stijn_01', PW)).ok).toBe(false);
    // The name is free again.
    expect((await svc.register('Stijn_01', PW)).ok).toBe(true);
  });

  it('survives a restart', async () => {
    const r = await svc.register('Stijn_01', PW);
    if (!r.ok) throw new Error(r.error);
    svc.close();
    svc = new AccountService({ dataDir: dir, maxAccounts: 100, profiles: hooks() });
    expect(svc.verifySession(r.token)).toBe(r.profileId);
    expect((await svc.login('stijn_01', PW)).ok).toBe(true);
  });
});

describe('ProfileService with accounts', () => {
  it('lets a session token stand for the profile and kills the guest token once linked', async () => {
    const ps = new ProfileService({ dataDir: dir, maxProfiles: 100, secret: 'x'.repeat(32), flushMs: 60_000 });
    const acc = new AccountService({
      dataDir: dir, maxAccounts: 10,
      profiles: {
        create: (name) => ps.create(name)?.profile.id ?? null,
        exists: (id) => !!ps.get(id), rename: () => undefined, remove: (id) => ps.remove(id),
      },
    });
    ps.attachAccounts(acc);
    const guest = ps.create('Guesty')!;
    expect(ps.verify(guest.token)).toBe(guest.profile.id);
    const r = await acc.register('Linked_1', 'correct horse battery', guest.profile.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.profileId).toBe(guest.profile.id);
    expect(ps.verify(guest.token)).toBeNull();
    expect(ps.verify(r.token)).toBe(guest.profile.id);
    expect(ps.resolve(r.token)?.id).toBe(guest.profile.id);
    ps.seen(guest.profile.id, 'Other_Name');
    expect(ps.get(guest.profile.id)?.name).toBe('Linked_1');
    acc.close();
    ps.close();
  });
});
