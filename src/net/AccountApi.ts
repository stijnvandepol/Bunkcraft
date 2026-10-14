import { type ProfileData } from '../modes/progression/Profile';
import { adoptSession, currentProfile, forgetSession, isAccountSession, profileToken, replaceToken } from './ProfileApi';

/**
 * The browser side of player accounts. A login hands the browser a session token (`s1.…`) that replaces the guest
 * token in localStorage, so every call that already sends the profile token (matches, parties, skins, rejoin)
 * now acts as the account. Passwords only travel in the body of these POSTs and are never stored here.
 */
export class AccountError extends Error {
  constructor(readonly code: string, readonly retryAfter = 0, readonly guest?: { name: string; xp: number; prestige: number }) {
    super(code);
  }
}

interface Reply {
  token?: string;
  recovery?: string;
  profile?: unknown;
  account?: { name?: string };
  error?: string;
  retryAfter?: number;
  guest?: { name: string; xp: number; prestige: number };
}

async function call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Reply> {
  const token = profileToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new AccountError('network');
  }
  const data = (await res.json().catch(() => ({}))) as Reply;
  if (!res.ok) throw new AccountError(data.error ?? 'invalid_request', data.retryAfter ?? 0, data.guest);
  return data;
}

/** Whether this browser is logged in (a session token is stored; the server decides whether it is still valid). */
export function loggedIn(): boolean {
  return isAccountSession();
}

/** The account name of the loaded profile, when logged in. */
export function accountName(): string | null {
  return isAccountSession() ? currentProfile()?.name ?? null : null;
}

export interface AccountResult { profile: ProfileData | null; name: string; recovery?: string }

function adopt(r: Reply): AccountResult {
  if (!r.token) throw new AccountError('invalid_request');
  const profile = adoptSession(r.token, r.profile);
  return { profile, name: r.account?.name ?? profile?.name ?? '', ...(r.recovery ? { recovery: r.recovery } : {}) };
}

/** Makes an account; a guest profile of this browser becomes its profile. The recovery code is in the result, shown once. */
export async function register(name: string, password: string): Promise<AccountResult> {
  return adopt(await call('POST', '/api/account/register', { name, password }));
}

/** Logs in. Throws AccountError('guest_progress') while this browser holds guest progress and `discardGuest` is not set. */
export async function login(name: string, password: string, discardGuest = false): Promise<AccountResult> {
  return adopt(await call('POST', '/api/account/login', { name, password, ...(discardGuest ? { discardGuest: true } : {}) }));
}

export async function recover(name: string, code: string, password: string): Promise<AccountResult> {
  return adopt(await call('POST', '/api/account/recover', { name, code, password }));
}

/** Ends the session on the server first, then forgets it here (the browser is a guest again). */
export async function logout(): Promise<void> {
  try { await call('POST', '/api/account/logout', {}); } catch { /* the token is dropped here either way */ }
  forgetSession();
}

export async function changePassword(password: string, newPassword: string): Promise<void> {
  const r = await call('POST', '/api/account/password', { password, newPassword });
  if (r.token) replaceToken(r.token);
}

/** A new recovery code (the old one stops working). */
export async function newRecoveryCode(password: string): Promise<string> {
  const r = await call('POST', '/api/account/recovery/new', { password });
  if (!r.recovery) throw new AccountError('invalid_request');
  return r.recovery;
}

/** Deletes the account and its profile; the browser becomes a guest. */
export async function deleteAccount(password: string): Promise<void> {
  await call('POST', '/api/account/delete', { password });
  forgetSession();
}
