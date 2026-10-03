import { describe, expect, it } from 'vitest';
import { BLOCK_DEFS } from '../src/world/BlockRegistry';
import { SOUND_PROFILES, isBlockSound, pickVariant, profileFor, stepSurface } from '../src/core/audio/profiles';
import { StepCadence, STEP_DISTANCE, landingKind, landingVolume, moveMode, splashVolume } from '../src/core/audio/cadence';
import { Priority, VoiceLimiter } from '../src/core/audio/voiceLimiter';
import { countSolidAlong, distanceGain, occlusionCutoff, occlusionGain, panFor } from '../src/core/audio/spatial';
import { caveFactor, cricketFactor, createEnvironment, estimateEnclosure, birdFactor, windFactor } from '../src/core/audio/environment';
import { SCALES, chooseMood, generatePhrase, mulberry32, pulseAt, scaleNote, midiToHz, type PulseEvent } from '../src/core/audio/musicTheory';
import { softClipCurve } from '../src/core/audio/mixer';
import { BIOME } from '../src/world/Biomes';
import { buildCatalog } from '../src/core/audio/catalog';
import { WEAPONS } from '../src/modes/Weapons';

describe('sound profiles', () => {
  it('every block declares a sound type that has a profile', () => {
    for (const def of BLOCK_DEFS) expect(isBlockSound(def.sound), `${def.name}: ${def.sound}`).toBe(true);
  });

  it('every profile is sane (positive levels, ordered pitch range, valid filters)', () => {
    for (const [name, p] of Object.entries(SOUND_PROFILES)) {
      expect(p.gain, name).toBeGreaterThan(0);
      expect(p.pitch[0], name).toBeLessThan(p.pitch[1]);
      expect(p.noise.freq, name).toBeGreaterThan(50);
      expect(p.noise.q, name).toBeGreaterThan(0);
    }
  });

  it('falls back to stone for unknown types instead of throwing', () => {
    expect(profileFor('nonsense')).toBe(SOUND_PROFILES.stone);
    expect(stepSurface('nonsense')).toBe('stone');
  });

  it('water and ladder override the block sound underfoot', () => {
    expect(stepSurface('grass')).toBe('grass');
    expect(stepSurface('grass', { inWater: true })).toBe('water');
    expect(stepSurface('stone', { onLadder: true, inWater: true })).toBe('ladder');
  });

  it('never repeats the previous variant and uses all of them', () => {
    const rng = mulberry32(5);
    const seen = new Set<number>();
    let last = -1;
    for (let i = 0; i < 400; i++) {
      const v = pickVariant(4, last, rng());
      expect(v).not.toBe(last);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
      seen.add(v);
      last = v;
    }
    expect(seen.size).toBe(4);
    expect(pickVariant(1, 0, 0.9)).toBe(0);
  });
});

describe('footstep cadence', () => {
  it('steps every STEP_DISTANCE and alternates feet', () => {
    const c = new StepCadence();
    let steps = 0;
    const feet: number[] = [];
    for (let i = 0; i < 100; i++) {
      if (c.advance(0.1, 'walk')) { steps++; feet.push(c.foot); }
    }
    expect(steps).toBe(Math.floor(10 / STEP_DISTANCE.walk));
    expect(feet.slice(0, 4)).toEqual([1, 0, 1, 0]);
  });

  it('sprinting steps faster than walking, sneaking slower', () => {
    const count = (mode: 'walk' | 'sprint' | 'sneak') => {
      const c = new StepCadence();
      let n = 0;
      for (let i = 0; i < 200; i++) if (c.advance(0.1, mode)) n++;
      return n;
    };
    expect(count('sprint')).toBeGreaterThan(count('walk'));
    expect(count('walk')).toBeGreaterThan(count('sneak'));
  });

  it('a teleport gives one step, not a burst', () => {
    const c = new StepCadence();
    expect(c.advance(50, 'walk')).toBe(true);
    expect(c.advance(0, 'walk')).toBe(false);
  });

  it('mode selection prefers sneak over sprint', () => {
    expect(moveMode(true, true)).toBe('sneak');
    expect(moveMode(true, false)).toBe('sprint');
    expect(moveMode(false, false)).toBe('walk');
  });

  it('landing volume grows with fall height and ignores tiny drops', () => {
    expect(landingVolume(0.5)).toBeNull();
    expect(landingVolume(3)!).toBeGreaterThan(landingVolume(1)!);
    expect(landingVolume(100)!).toBeLessThanOrEqual(1.2);
    expect(landingKind(1)).toBe('soft');
    expect(landingKind(2)).toBe('medium');
    expect(landingKind(6)).toBe('heavy');
  });

  it('splash needs speed', () => {
    expect(splashVolume(1)).toBeNull();
    expect(splashVolume(10)!).toBeGreaterThan(splashVolume(3)!);
  });
});

describe('voice limiter', () => {
  it('allows up to max voices at the same time', () => {
    const lim = new VoiceLimiter(4);
    for (let i = 0; i < 4; i++) expect(lim.request(0, Priority.Normal, 0.5, 10, null)).toBe(true);
    expect(lim.activeCount(0)).toBe(4);
  });

  it('refuses a quieter newcomer when full of louder voices of the same priority', () => {
    const lim = new VoiceLimiter(2);
    lim.request(0, Priority.Normal, 0.8, 10, null);
    lim.request(0, Priority.Normal, 0.9, 10, null);
    expect(lim.request(0, Priority.Normal, 0.1, 10, null)).toBe(false);
    expect(lim.dropped).toBe(1);
  });

  it('steals the quietest voice for a more important newcomer', () => {
    const lim = new VoiceLimiter(2);
    let stoppedQuiet = false, stoppedLoud = false;
    lim.request(0, Priority.Normal, 0.2, 10, () => { stoppedQuiet = true; });
    lim.request(0, Priority.Normal, 0.9, 10, () => { stoppedLoud = true; });
    expect(lim.request(0, Priority.Player, 0.5, 10, null)).toBe(true);
    expect(stoppedQuiet).toBe(true);
    expect(stoppedLoud).toBe(false);
    expect(lim.stolen).toBe(1);
  });

  it('priority beats loudness', () => {
    const lim = new VoiceLimiter(1);
    lim.request(0, Priority.Ui, 0.1, 10, null);
    expect(lim.request(0, Priority.Normal, 1.2, 10, null)).toBe(false);
  });

  it('steals the oldest among equally weak voices', () => {
    const lim = new VoiceLimiter(2);
    const stopped: string[] = [];
    lim.request(0, Priority.Normal, 0.5, 10, () => stopped.push('old'));
    lim.request(1, Priority.Normal, 0.5, 10, () => stopped.push('new'));
    lim.request(2, Priority.Player, 0.5, 10, null);
    expect(stopped).toEqual(['old']);
  });

  it('does not thrash: an equal newcomer does not steal a slot', () => {
    const lim = new VoiceLimiter(2);
    lim.request(0, Priority.Normal, 0.5, 10, null);
    lim.request(0, Priority.Normal, 0.5, 10, null);
    expect(lim.canAccept(1, Priority.Normal, 0.5)).toBe(false);
    expect(lim.request(1, Priority.Normal, 0.5, 10, null)).toBe(false);
    expect(lim.stolen).toBe(0);
    expect(lim.canAccept(1, Priority.Player, 0.5)).toBe(true);
    expect(lim.canAccept(11, Priority.Ambient, 0.1)).toBe(true); // everything ended
  });

  it('frees voices that ended', () => {
    const lim = new VoiceLimiter(1);
    lim.request(0, Priority.Normal, 0.5, 1, null);
    expect(lim.request(2, Priority.Ambient, 0.01, 3, null)).toBe(true);
    expect(lim.stolen).toBe(0);
  });

  it('never exceeds max under a flood', () => {
    const lim = new VoiceLimiter(16);
    const rng = mulberry32(9);
    let t = 0;
    for (let i = 0; i < 5000; i++) {
      t += rng() * 0.01;
      lim.request(t, Math.floor(rng() * 3), rng(), t + 0.1 + rng() * 0.5, null);
      expect(lim.activeCount(t)).toBeLessThanOrEqual(16);
    }
  });
});

describe('spatial audio', () => {
  it('attenuates smoothly to silence', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(2)).toBe(1);
    expect(distanceGain(10)).toBeGreaterThan(distanceGain(20));
    expect(distanceGain(48)).toBe(0);
    expect(distanceGain(100)).toBe(0);
  });

  it('pans towards the side the source is on (three.js camera: yaw 0 looks down -z, right is +x)', () => {
    expect(panFor(10, 0, 0)).toBeGreaterThan(0.5);
    expect(panFor(-10, 0, 0)).toBeLessThan(-0.5);
    expect(Math.abs(panFor(0, -10, 0))).toBeLessThan(0.01); // straight ahead
    // Turned 90 degrees left (yaw +pi/2) the camera looks down -x and its right hand points to -z.
    expect(Math.abs(panFor(-10, 0, Math.PI / 2))).toBeLessThan(0.01);
    expect(panFor(0, -10, Math.PI / 2)).toBeGreaterThan(0.5);
    expect(panFor(0, 0.1, 0)).toBeCloseTo(0, 1);
  });

  it('occlusion muffles and quietens with each wall block', () => {
    expect(occlusionGain(0)).toBe(1);
    expect(occlusionCutoff(0)).toBe(1);
    expect(occlusionGain(2)).toBeLessThan(occlusionGain(1));
    expect(occlusionCutoff(2)).toBeLessThan(occlusionCutoff(1));
    expect(occlusionCutoff(50)).toBeGreaterThan(0);
  });

  it('counts the blocks of a wall along a line, not the open air', () => {
    const wall = (x: number) => x >= 5 && x < 7; // 2 thick
    expect(countSolidAlong((x) => wall(x), 0.5, 0.5, 0.5, 12.5, 0.5, 0.5)).toBe(2);
    expect(countSolidAlong(() => false, 0, 0, 0, 20, 5, 3)).toBe(0);
    expect(countSolidAlong(() => true, 0, 0, 0, 1, 0, 0)).toBe(0); // too short to count
  });
});

describe('environment', () => {
  const solidGround = (_x: number, y: number) => y < 0;
  it('is open outdoors and enclosed in a tunnel', () => {
    const outdoors = estimateEnclosure(solidGround, 0.5, 0.5, 0.5);
    const tunnel = estimateEnclosure((x, y, z) => !(y === 0 && z === 0 && Math.abs(x) < 50) , 0.5, 0.5, 0.5);
    expect(outdoors).toBeLessThan(0.35);
    expect(tunnel).toBeGreaterThan(0.6);
    expect(tunnel).toBeGreaterThan(outdoors);
  });

  it('detects caves: dark, enclosed and deep, not a dark house on the surface', () => {
    expect(caveFactor(0, 0.9, 30)).toBeGreaterThan(0.8);
    expect(caveFactor(15, 0.9, 30)).toBe(0);
    expect(caveFactor(0, 0.1, 30)).toBe(0);
    expect(caveFactor(0, 0.9, 70)).toBeLessThan(caveFactor(0, 0.9, 30));
  });

  it('ambient beds follow biome and time of day', () => {
    const env = createEnvironment();
    env.y = 70; env.skyLight = 15; env.enclosure = 0.1;
    env.biome = BIOME.FOREST; env.dayFactor = 1;
    expect(birdFactor(env)).toBeGreaterThan(0.8);
    expect(cricketFactor(env)).toBe(0);
    env.dayFactor = 0;
    expect(birdFactor(env)).toBe(0);
    expect(cricketFactor(env)).toBeGreaterThan(0.8);
    env.biome = BIOME.DESERT;
    expect(cricketFactor(env)).toBe(0);
    env.biome = BIOME.MOUNTAINS; env.y = 100; env.dayFactor = 1;
    expect(windFactor(env)).toBeGreaterThan(0.5);
    env.enclosure = 0.9;
    expect(windFactor(env)).toBeLessThan(0.1);
    env.enclosure = 0.1; env.y = 66; env.biome = BIOME.PLAINS;
    expect(windFactor(env)).toBe(0);
    env.underwater = true; env.biome = BIOME.FOREST; env.dayFactor = 1;
    expect(birdFactor(env)).toBe(0);
  });
});

describe('music theory', () => {
  it('scale degrees map to the right pitches across octaves', () => {
    expect(scaleNote('majorPent', 60, 0)).toBe(60);
    expect(scaleNote('majorPent', 60, 4)).toBe(69);
    expect(scaleNote('majorPent', 60, 5)).toBe(72);
    expect(scaleNote('majorPent', 60, -1)).toBe(57);
    expect(midiToHz(69)).toBeCloseTo(440, 5);
  });

  it('every phrase uses only scale notes, is deterministic per seed and has timing in order', () => {
    for (const biome of [BIOME.PLAINS, BIOME.FOREST, BIOME.DESERT, BIOME.SNOWY, BIOME.MOUNTAINS, BIOME.OCEAN]) {
      for (const day of [1, 0]) {
        const mood = chooseMood('game', biome, day, 0);
        const scale = SCALES[mood.scale] as readonly number[];
        const a = generatePhrase(mulberry32(42), mood);
        const b = generatePhrase(mulberry32(42), mood);
        expect(a).toEqual(b);
        expect(a.length).toBeGreaterThanOrEqual(mood.notes[0]);
        for (const n of a) {
          expect(scale).toContain((((n.midi - mood.root) % 12) + 12) % 12);
          expect(n.at).toBeGreaterThanOrEqual(0);
          expect(n.vel).toBeGreaterThan(0);
          expect(n.vel).toBeLessThan(0.6);
        }
      }
    }
  });

  it('mood differs by mode, time and depth; menu is chattier than the game', () => {
    const menu = chooseMood('menu', BIOME.PLAINS, 1, 0);
    const day = chooseMood('game', BIOME.PLAINS, 1, 0);
    const night = chooseMood('game', BIOME.PLAINS, 0, 0);
    const cave = chooseMood('game', BIOME.PLAINS, 1, 1);
    expect(menu.gap[1]).toBeLessThan(day.gap[0]);
    expect(night.gap[0]).toBeGreaterThan(day.gap[0]);
    expect(day.scale).not.toBe(night.scale);
    expect(cave.scale).toBe('sus');
    expect(chooseMood('arcade', BIOME.PLAINS, 1, 0).scale).toBe('minorPent');
  });

  it('the arcade pulse has a kick on every beat, hats off-beat and is silent at zero intensity', () => {
    const out: PulseEvent[] = [];
    let kicks = 0, hats = 0, bass = 0;
    for (let s = 0; s < 16; s++) {
      pulseAt(s, 1, out);
      for (const e of out) {
        if (e.kind === 'kick') kicks++;
        if (e.kind === 'hat') hats++;
        if (e.kind === 'bass') bass++;
      }
    }
    expect(kicks).toBe(4);
    expect(hats).toBe(4);
    expect(bass).toBeGreaterThan(0);
    pulseAt(0, 0, out);
    expect(out.every((e) => e.vel === 0)).toBe(true);
  });
});

describe('mix', () => {
  it('soft clip curve is transparent below 0.7 and never exceeds 0.95', () => {
    const c = softClipCurve(2049);
    const mid = (c.length - 1) / 2;
    const at = (x: number) => c[Math.round(mid + x * mid)];
    expect(at(0.5)).toBeCloseTo(0.5, 2);
    expect(at(-0.5)).toBeCloseTo(-0.5, 2);
    expect(Math.max(...c)).toBeLessThan(0.95);
    expect(Math.min(...c)).toBeGreaterThan(-0.95);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]); // monotonic
  });
});

describe('weapon sounds', () => {
  it('every arcade weapon has a catalog entry', () => {
    const names = new Set(buildCatalog().map((e) => e.name));
    for (const w of WEAPONS) expect(names.has(`weapon.${w.id}`), w.id).toBe(true);
  });
});
