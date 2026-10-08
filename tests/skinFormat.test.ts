import { describe, expect, it } from 'vitest';
import {
  SKIN_BOXES, SKIN_RGBA_BYTES, SKIN_SIZE, SOLID_STRIP, canonicalSkin, checkSkinBytes, isSkinHash, isUsedPixel,
} from '../src/skins/SkinFormat';
import { skinHashOf } from '../server/skins/SkinService';
import { coordinateRgba, noise, pngOfRgba, makePng } from './helpers/png';

const at = (px: Uint8Array, x: number, y: number): number[] => [...px.subarray((y * SKIN_SIZE + x) * 4, (y * SKIN_SIZE + x) * 4 + 4)];

describe('skin layout', () => {
  it('uses 3264 pixels, none of them in the strip the team band samples', () => {
    let used = 0;
    for (let y = 0; y < SKIN_SIZE; y++) for (let x = 0; x < SKIN_SIZE; x++) if (isUsedPixel(x, y)) used++;
    expect(used).toBe(3264);
    for (let y = SOLID_STRIP.y; y < SOLID_STRIP.y + SOLID_STRIP.h; y++) {
      for (let x = SOLID_STRIP.x; x < SOLID_STRIP.x + SOLID_STRIP.w; x++) expect(isUsedPixel(x, y)).toBe(false);
    }
  });

  it('matches the classic layout: the face of the head is at (8,8), the body front at (20,20)', () => {
    expect(SKIN_BOXES.head.u + SKIN_BOXES.head.d).toBe(8);
    expect(SKIN_BOXES.head.v + SKIN_BOXES.head.d).toBe(8);
    expect(SKIN_BOXES.body.u + SKIN_BOXES.body.d).toBe(20);
    expect(SKIN_BOXES.body.v + SKIN_BOXES.body.d).toBe(20);
    expect(SKIN_BOXES.rightArm.u).toBe(40);
    expect(SKIN_BOXES.leftArm.u).toBe(32);
    expect(SKIN_BOXES.leftArm.v).toBe(48);
  });
});

describe('canonicalSkin', () => {
  it('keeps a 64x64 skin, makes the base layer opaque and clears what no face uses', () => {
    const src = coordinateRgba();
    src[(10 * 64 + 10) * 4 + 3] = 0; // a transparent pixel on the head: base layer pixels are opaque
    const px = canonicalSkin(src, 64, 64)!;
    expect(px.length).toBe(SKIN_RGBA_BYTES);
    expect(at(px, 12, 12)).toEqual(at(src, 12, 12));
    expect(at(px, 10, 10)[3]).toBe(255);
    // (0,0) is a corner of the head net that no face uses; the strip right of the arm is free too.
    expect(at(px, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(px, 60, 20)).toEqual([0, 0, 0, 0]);
  });

  it('makes the overlay layer binary: transparent pixels lose their colour', () => {
    const src = coordinateRgba();
    // Hat front face at (40,8).
    src.set([200, 100, 50, 10], (8 * 64 + 40) * 4);
    src.set([200, 100, 50, 200], (8 * 64 + 41) * 4);
    const px = canonicalSkin(src, 64, 64)!;
    expect(at(px, 40, 8)).toEqual([0, 0, 0, 0]);
    expect(at(px, 41, 8)).toEqual([200, 100, 50, 255]);
  });

  it('mirrors the right limbs onto the left ones for the legacy 64x32 format', () => {
    const src = coordinateRgba(64, 32);
    const px = canonicalSkin(src, 64, 32)!;
    // Right leg front is at (4,20) 4 px wide; the left leg front is at (20,52), flipped left-right.
    for (let i = 0; i < 4; i++) expect(at(px, 20 + i, 52)).toEqual(at(src, 4 + 3 - i, 20));
    // The right side of the right leg (0,20) becomes the LEFT side of the left leg (24,52), flipped.
    for (let i = 0; i < 4; i++) expect(at(px, 24 + i, 53)).toEqual(at(src, 0 + 3 - i, 21));
    // Arms: right arm front at (44,20) -> left arm front at (36,52).
    for (let i = 0; i < 4; i++) expect(at(px, 36 + i, 60)).toEqual(at(src, 44 + 3 - i, 28));
    // The legacy format has no second layer: the jacket stays empty.
    expect(at(px, 20, 36)).toEqual([0, 0, 0, 0]);
  });

  it('widens slim (3 px) arms to the 4 px model', () => {
    const src = coordinateRgba();
    // A slim skin has nothing in the outer arm columns: (54..55, 20..31) and (46..47, 52..63).
    for (let y = 20; y < 32; y++) for (const x of [54, 55]) src.set([0, 0, 0, 0], (y * 64 + x) * 4);
    for (let y = 52; y < 64; y++) for (const x of [46, 47]) src.set([0, 0, 0, 0], (y * 64 + x) * 4);
    const px = canonicalSkin(src, 64, 64)!;
    // Slim front is x 44..46 of the right arm; the wide front is 44..47 with the middle column doubled.
    expect(at(px, 44, 24)).toEqual(at(src, 44, 24));
    expect(at(px, 45, 24)).toEqual(at(src, 45, 24));
    expect(at(px, 46, 24)).toEqual(at(src, 45, 24));
    expect(at(px, 47, 24)).toEqual(at(src, 46, 24));
    // The back moved from 51..53 to 52..55.
    expect(at(px, 52, 24)).toEqual(at(src, 51, 24));
    expect(at(px, 55, 24)).toEqual(at(src, 53, 24));
    // A wide skin is left alone.
    const wide = canonicalSkin(coordinateRgba(), 64, 64)!;
    expect(at(wide, 46, 24)).toEqual(at(coordinateRgba(), 46, 24));
  });

  it('refuses other sizes', () => {
    expect(canonicalSkin(new Uint8Array(32 * 32 * 4), 32, 32)).toBeNull();
    expect(canonicalSkin(new Uint8Array(64 * 48 * 4), 64, 48)).toBeNull();
    expect(canonicalSkin(new Uint8Array(10), 64, 64)).toBeNull();
  });

  it('is idempotent and its hash depends on the pixels only', () => {
    const once = canonicalSkin(coordinateRgba(), 64, 64)!;
    const twice = canonicalSkin(once, 64, 64)!;
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
    const hash = skinHashOf(once);
    expect(isSkinHash(hash)).toBe(true);
    // Junk in unused pixels of the source changes nothing: hidden data does not survive.
    const dirty = coordinateRgba();
    dirty.set(noise(16, 4), (0 * 64 + 0) * 4);
    expect(skinHashOf(canonicalSkin(dirty, 64, 64)!)).toBe(hash);
    expect(isSkinHash(hash.toUpperCase())).toBe(false);
    expect(isSkinHash('../../etc/passwd')).toBe(false);
  });
});

describe('checkSkinBytes (client pre-check)', () => {
  it('passes real skins and explains the common mistakes', () => {
    expect(checkSkinBytes(pngOfRgba(coordinateRgba()))).toBeNull();
    expect(checkSkinBytes(makePng({ height: 32, pixels: coordinateRgba(64, 32) }))).toBeNull();
    expect(checkSkinBytes(pngOfRgba(new Uint8Array(32 * 32 * 4), 32, 32))).toBe('size');
    expect(checkSkinBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>'))).toBe('not-png');
    expect(checkSkinBytes(new Uint8Array(20000))).toBe('too-large');
    expect(checkSkinBytes(new Uint8Array(0))).toBe('not-png');
  });
});
