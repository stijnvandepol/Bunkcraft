import * as THREE from 'three';
import { SKIN_SIZE, SOLID_STRIP } from '../skins/SkinFormat';
import { skinUrl } from '../skins/skinUrl';
import { SKIN_SLOT } from '../entities/MobTypes';
import { SHIRTS, paintDefaultSkin } from './DefaultSkins';

/** The atlas is CELLS x CELLS skins of 64x64 pixels: 512x512, one texture for every player in the scene. */
export const SKIN_ATLAS_CELLS = 8;
const ATLAS_PX = SKIN_ATLAS_CELLS * SKIN_SIZE;
/** Cells 0..2 hold the default skins, the rest custom skins. */
const FIRST_CUSTOM = SKIN_SLOT.firstCustom;

interface Entry {
  slot: number;
  state: 'loading' | 'ready' | 'failed';
  /** Players that currently want this skin; a skin nobody wants stays cached until its cell is needed. */
  refs: number;
  lastUsed: number;
}

/**
 * All player skins on the GPU in one texture, so a hundred different skins still cost one draw call per body part.
 * Cells 0-2 are the default skins; custom skins are fetched by hash (`/skins/<hash>.png`, long-cache headers, canonical
 * 64x64 PNGs written by the server) into the cell of the least recently used skin nobody wears any more. The mob shader
 * picks the cell per instance (see MobRenderer). Until a skin arrives its wearer is drawn with the default skin.
 */
export class SkinAtlas {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  /** Bumps whenever a cell finished loading or was freed: players re-resolve their cell. */
  version = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly entries = new Map<string, Entry>();
  private readonly owner: (string | null)[] = new Array(SKIN_ATLAS_CELLS * SKIN_ATLAS_CELLS).fill(null);
  private clock = 0;

  constructor() {
    this.canvas.width = this.canvas.height = ATLAS_PX;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!;
    this.ctx.imageSmoothingEnabled = false;
    for (const [slot, shirt] of [[SKIN_SLOT.neutral, SHIRTS.neutral], [SKIN_SLOT.red, SHIRTS.red], [SKIN_SLOT.blue, SHIRTS.blue]] as const) {
      const [x, y] = this.origin(slot);
      paintDefaultSkin(this.ctx, x, y, shirt);
      this.paintStrip(slot);
    }
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
  }

  private origin(slot: number): [number, number] {
    return [(slot % SKIN_ATLAS_CELLS) * SKIN_SIZE, Math.floor(slot / SKIN_ATLAS_CELLS) * SKIN_SIZE];
  }

  /** The strip the team head band samples is white in every cell, so its colour is only the part's tint. */
  private paintStrip(slot: number): void {
    const [x, y] = this.origin(slot);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(x + SOLID_STRIP.x, y + SOLID_STRIP.y, SOLID_STRIP.w, SOLID_STRIP.h);
  }

  /** The cell of a custom skin that is loaded, or −1 (not asked for, still loading, failed). */
  slotOf(hash: string): number {
    const e = this.entries.get(hash);
    return e && e.state === 'ready' ? e.slot : -1;
  }

  /** A player wants this skin: starts loading it if needed. Returns false when there is no cell for it (then do not `release`). */
  acquire(hash: string): boolean {
    let e = this.entries.get(hash);
    if (!e) {
      const slot = this.freeCell();
      if (slot < 0) return false; // every cell is in use by a skin somebody wears: stay on the default
      e = { slot, state: 'loading', refs: 0, lastUsed: 0 };
      this.owner[slot] = hash;
      this.entries.set(hash, e);
      void this.load(hash, e);
    }
    e.refs++;
    e.lastUsed = ++this.clock;
    return true;
  }

  release(hash: string): void {
    const e = this.entries.get(hash);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    // A failed download is forgotten once nobody wants it, so the next request tries again.
    if (e.refs === 0 && e.state === 'failed') this.forget(hash, e);
  }

  private forget(hash: string, e: Entry): void {
    this.entries.delete(hash);
    if (this.owner[e.slot] === hash) this.owner[e.slot] = null;
  }

  /** An empty cell, else the cell of the least recently used skin nobody wears; −1 when there is none. */
  private freeCell(): number {
    for (let slot = FIRST_CUSTOM; slot < this.owner.length; slot++) if (this.owner[slot] === null) return slot;
    let victim: [string, Entry] | null = null;
    for (const kv of this.entries) if (kv[1].refs === 0 && kv[1].state !== 'loading' && (!victim || kv[1].lastUsed < victim[1].lastUsed)) victim = kv;
    if (!victim) return -1;
    this.forget(victim[0], victim[1]);
    this.version++;
    return victim[1].slot;
  }

  private async load(hash: string, e: Entry): Promise<void> {
    try {
      const res = await fetch(skinUrl(hash));
      if (!res.ok) throw new Error(`skin ${res.status}`);
      const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (bitmap.width !== SKIN_SIZE || bitmap.height !== SKIN_SIZE) throw new Error('not a canonical skin');
      // Dropped while loading (evicted and the cell reused)?
      if (this.entries.get(hash) !== e) { bitmap.close(); return; }
      const [x, y] = this.origin(e.slot);
      this.ctx.clearRect(x, y, SKIN_SIZE, SKIN_SIZE);
      this.ctx.drawImage(bitmap, x, y);
      bitmap.close();
      this.paintStrip(e.slot);
      e.state = 'ready';
      this.texture.needsUpdate = true;
    } catch {
      if (this.entries.get(hash) !== e) return;
      e.state = 'failed';
      if (e.refs === 0) this.forget(hash, e);
    }
    this.version++;
  }
}

let shared: SkinAtlas | null = null;

/** The one atlas of the page (created on first use, when a renderer needs it). */
export function skinAtlas(): SkinAtlas {
  return (shared ??= new SkinAtlas());
}
