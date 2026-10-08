import { type SkinErrorCode, SKIN_SIZE, canonicalSkin, checkSkinBytes } from '../skins/SkinFormat';
import { type I18nKey, t } from '../ui/i18n';
import { validSavedName } from '../ui/playerName';
import { currentProfile, loadProfile, profileToken, refreshProfile } from './ProfileApi';
import { serverInfo } from './RoomApi';

/**
 * The browser side of custom skins: pre-checks a file, shows it as other players will see it, and uploads or removes the
 * skin of this browser's profile. The server validates everything again and re-encodes the file; what comes back is the
 * hash other players fetch (`/skins/<hash>.png`).
 */
export type SkinResult = { ok: true } | { ok: false; code: SkinErrorCode };

/** The text for an error code, in the player's language. */
export function skinErrorText(code: SkinErrorCode): string {
  return t(`skin.err.${code}` as I18nKey);
}

/** Whether the server this page came from can store skins (needs a recent server with profiles and SKINS on). */
export async function skinsSupported(): Promise<boolean> {
  const info = await serverInfo();
  return !!info?.features?.skins;
}

/** Decodes a PNG file with the browser and returns the canonical 64x64 pixels others will see, or an error code. */
export async function previewPixels(bytes: Uint8Array): Promise<{ ok: true; rgba: Uint8Array } | { ok: false; code: SkinErrorCode }> {
  const early = checkSkinBytes(bytes);
  if (early) return { ok: false, code: early };
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const w = bitmap.width, h = bitmap.height;
    bitmap.close();
    const rgba = canonicalSkin(data.data, w, h);
    return rgba ? { ok: true, rgba } : { ok: false, code: 'size' };
  } catch {
    return { ok: false, code: 'corrupt' };
  }
}

/** The profile of this browser; creates it on first use (the skin hangs on it). Null when the server keeps no profiles. */
export async function ensureProfile(): Promise<boolean> {
  if (currentProfile() && profileToken()) return true;
  await loadProfile(validSavedName() ?? 'Player');
  return !!currentProfile() && !!profileToken();
}

async function call(method: 'POST' | 'DELETE', body?: Uint8Array): Promise<SkinResult> {
  const token = profileToken();
  if (!token) return { ok: false, code: 'auth' };
  let res: Response;
  try {
    res = await fetch('/api/profile/skin', {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'image/png' } : {}) },
      ...(body ? { body: new Blob([body as BlobPart], { type: 'image/png' }) } : {}),
    });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (res.ok) {
    await refreshProfile();
    return { ok: true };
  }
  const data = (await res.json().catch(() => ({}))) as { code?: SkinErrorCode };
  return { ok: false, code: data.code ?? (res.status === 401 ? 'auth' : res.status === 429 ? 'rate' : 'network') };
}

/** Uploads a skin file as the skin of this browser's profile. */
export async function uploadSkin(bytes: Uint8Array): Promise<SkinResult> {
  const early = checkSkinBytes(bytes);
  if (early) return { ok: false, code: early };
  if (!(await ensureProfile())) return { ok: false, code: 'auth' };
  return call('POST', bytes);
}

/** Back to the default skin. */
export async function removeSkin(): Promise<SkinResult> {
  if (!profileToken()) return { ok: true };
  return call('DELETE');
}

/** Reads the skin of this browser's profile as canonical pixels (for the preview), or null for the default skin. */
export async function currentSkinPixels(): Promise<Uint8Array | null> {
  const hash = currentProfile()?.skin;
  if (!hash) return null;
  try {
    const res = await fetch(`/skins/${hash}.png`);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (bitmap.width !== SKIN_SIZE || bitmap.height !== SKIN_SIZE) { bitmap.close(); return null; }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SKIN_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Uint8Array(ctx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data);
  } catch {
    return null;
  }
}
