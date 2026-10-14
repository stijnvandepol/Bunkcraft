/**
 * Account rules shared by the server (which enforces them) and the register dialog (which only previews them).
 * The username follows the gamertag rules (letters, digits, underscore, 3-16); the password is 8-64 characters
 * (64 is what the scrypt helper hashes) and not one of the most common ones.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;

/** Names nobody may register (they look official or collide with the defaults). */
const RESERVED = new Set(['player', 'admin', 'administrator', 'moderator', 'mod', 'staff', 'system', 'server', 'bunkcraft', 'bunkhosting', 'gast', 'guest', 'root', 'null', 'undefined']);

/** A small list of passwords that are tried first by every attacker. All lower case. */
const COMMON = new Set((
  '12345678 123456789 1234567890 11111111 00000000 87654321 password password1 password12 password123 passw0rd p@ssw0rd p@ssword ' +
  'qwertyui qwerty123 qwertyuiop qwerty12 1q2w3e4r 1q2w3e4r5t 1qaz2wsx zaq12wsx asdfghjk asdfghjkl zxcvbnm1 zxcvbnm123 abc12345 abcd1234 ' +
  'abcdefgh iloveyou iloveyou1 letmein1 welcome1 welcome123 admin123 administrator monkey123 dragon123 football1 baseball1 superman ' +
  'trustno1 sunshine princess1 master123 shadow123 michael1 charlie1 jordan23 starwars minecraft minecraft1 minecraft123 fortnite ' +
  'bunkcraft bunkcraft1 bunkcraft123 bunkhosting wachtwoord wachtwoord1 wachtwoord123 welkom123 welkom01 geheim123 voetbal1 amsterdam ' +
  'changeme changeme1 default123 test1234 testtest guest123 login123 secret123 football letmein123 whatever1 freedom1 batman123 pokemon1'
).split(/\s+/));

export type AccountIssue = 'username_format' | 'username_reserved' | 'password_short' | 'password_long' | 'password_common' | 'password_name';

export function checkUsername(v: unknown): AccountIssue | null {
  if (typeof v !== 'string' || !USERNAME_PATTERN.test(v)) return 'username_format';
  return RESERVED.has(v.toLowerCase()) ? 'username_reserved' : null;
}

/** Why a password is refused (null = fine). `username` stops "name = password". */
export function checkPassword(v: unknown, username?: string): AccountIssue | null {
  if (typeof v !== 'string') return 'password_short';
  const p = v.normalize('NFKC');
  if ([...p].length < PASSWORD_MIN) return 'password_short';
  if (p.length > PASSWORD_MAX) return 'password_long';
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p)) return 'password_common';
  if (username && low === username.toLowerCase()) return 'password_name';
  return null;
}

/** Key a username is stored and compared under (names are unique case-insensitively). */
export const usernameKey = (v: string): string => v.toLowerCase();

/**
 * Key a name is compared under when it must not be mistaken for another (impersonation): case, underscores and
 * look-alike characters (0/o, 1/i/l, 5/s, 3/e) are folded away. Registered account names are reserved under this
 * key, so "Bob", "b0b" and "B_o_b" are one name as far as accounts and guests go.
 */
export const identityKey = (v: string): string =>
  v.toLowerCase().replace(/_/g, '').replace(/0/g, 'o').replace(/[1il]/g, 'l').replace(/5/g, 's').replace(/3/g, 'e');
