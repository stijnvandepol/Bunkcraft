import { describe, expect, it } from 'vitest';
import { BIOME } from '../src/world/Biomes';
import { BLOCK } from '../src/world/BlockRegistry';
import {
  CLEAR_TICKS, Precip, RAIN_TICKS, THUNDER_TICKS, Weather, type WeatherWorld, blocksPrecipitation, isExposed, parseWeatherCommand, parseWeatherKind,
  precipitationFor,
} from '../src/world/Weather';

/** Deterministic random numbers for the tests. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(w: Weather, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.tick();
}

describe('Weather state machine', () => {
  it('starts clear with a random first timer inside Minecraft\'s range', () => {
    const w = new Weather(seeded(1));
    expect(w.kind).toBe('clear');
    expect(w.rainTime).toBeGreaterThanOrEqual(CLEAR_TICKS[0]);
    expect(w.rainTime).toBeLessThanOrEqual(CLEAR_TICKS[1]);
  });

  it('rain lasts 12000–24000 ticks and clear 12000–180000 over many cycles', () => {
    const w = new Weather(seeded(7));
    const rainSpans: number[] = [];
    const clearSpans: number[] = [];
    let last = w.raining, since = 0;
    for (let i = 0; i < 8_000_000 && rainSpans.length < 40; i++) {
      w.tick();
      since++;
      if (w.raining !== last) {
        (last ? rainSpans : clearSpans).push(since);
        last = w.raining;
        since = 0;
      }
    }
    expect(rainSpans.length).toBeGreaterThanOrEqual(40);
    for (const s of rainSpans) { expect(s).toBeGreaterThanOrEqual(RAIN_TICKS[0]); expect(s).toBeLessThanOrEqual(RAIN_TICKS[1] + 1); }
    for (const s of clearSpans) { expect(s).toBeGreaterThanOrEqual(CLEAR_TICKS[0]); expect(s).toBeLessThanOrEqual(CLEAR_TICKS[1] + 1); }
  });

  it('thunder lasts 3600–15600 ticks', () => {
    const w = new Weather(seeded(3));
    const spans: number[] = [];
    let last = w.thundering, since = 0;
    for (let i = 0; i < 8_000_000 && spans.length < 30; i++) {
      w.tick();
      since++;
      if (w.thundering !== last) {
        if (last) spans.push(since);
        last = w.thundering;
        since = 0;
      }
    }
    expect(spans.length).toBeGreaterThanOrEqual(30);
    for (const s of spans) { expect(s).toBeGreaterThanOrEqual(THUNDER_TICKS[0]); expect(s).toBeLessThanOrEqual(THUNDER_TICKS[1] + 1); }
  });

  it('fades the rain level by 0.01 per tick (5 s) and back', () => {
    const w = new Weather(seeded(1));
    w.set('rain', 100000);
    run(w, 50);
    expect(w.rain).toBeCloseTo(0.5, 5);
    run(w, 50);
    expect(w.rain).toBe(1);
    w.set('clear', 100000);
    run(w, 100);
    expect(w.rain).toBe(0);
  });

  it('thunder needs rain: the effective level is thunderLevel × rainLevel', () => {
    const w = new Weather(seeded(1));
    w.thundering = true;
    run(w, 100);
    expect(w.thunderLevel).toBe(1);
    expect(w.thunder).toBe(0);
    expect(w.skyDarkness).toBe(0);
    w.raining = true;
    run(w, 100);
    expect(w.thunder).toBe(1);
    expect(w.skyDarkness).toBe(5);
  });

  it('/weather commands set flags and durations', () => {
    const w = new Weather(seeded(2));
    w.set('thunder', 6000);
    expect(w.kind).toBe('thunder');
    expect(w.rainTime).toBe(6000);
    run(w, 6000);
    // Both timers ran out together: the storm is over.
    expect(w.kind).toBe('clear');

    w.set('rain');
    expect(w.kind).toBe('rain');
    expect(w.rainTime).toBeGreaterThanOrEqual(RAIN_TICKS[0]);
    expect(w.rainTime).toBeLessThanOrEqual(RAIN_TICKS[1]);

    w.set('clear', 1200);
    expect(w.kind).toBe('clear');
    expect(w.clearTime).toBe(1200);
    run(w, 1200);
    expect(w.clearTime).toBe(0);
    expect(w.kind).toBe('clear');
    // After the forced clear period the normal random cycle takes over (a fresh long timer).
    run(w, 2);
    expect(w.rainTime).toBeGreaterThanOrEqual(CLEAR_TICKS[0] - 2);
  });

  it('a running timer cannot end the weather command early while clearTime is left', () => {
    const w = new Weather(seeded(2));
    w.set('rain', 100);
    w.set('clear', 5000);
    run(w, 4999);
    expect(w.kind).toBe('clear');
  });

  it('a version bump marks every change so the server knows when to broadcast', () => {
    const w = new Weather(seeded(2));
    const v = w.version;
    run(w, 10);
    expect(w.version).toBe(v);
    w.set('rain', 50);
    expect(w.version).toBeGreaterThan(v);
    const v2 = w.version;
    run(w, 50);
    expect(w.version).toBeGreaterThan(v2);
  });

  it('advance() converts seconds to 20 Hz ticks and caps catch-up', () => {
    const w = new Weather(seeded(2));
    expect(w.advance(0.5)).toBe(10);
    expect(w.advance(0.03)).toBe(0); // 0.6 tick, kept
    expect(w.advance(0.03)).toBe(1);
    expect(w.advance(60)).toBe(100);
  });

  it('serializes and restores, also from damaged data', () => {
    const w = new Weather(seeded(5));
    w.set('thunder', 7000);
    run(w, 1000);
    const s = JSON.parse(JSON.stringify(w.serialize()));
    const r = new Weather(seeded(9));
    r.restore(s);
    expect(r.kind).toBe('thunder');
    expect(r.rainTime).toBe(6000);
    expect(r.rain).toBe(1);
    expect(r.thunder).toBe(1);

    const bad = new Weather(seeded(9));
    bad.restore({ raining: 'yes', rainTime: -5, thunderTime: NaN } as never);
    expect(bad.kind).toBe('clear');
    expect(bad.rainTime).toBeGreaterThan(0);
    bad.restore(null);
    bad.restore(undefined);
  });

  it('a remote client follows the server targets without running timers', () => {
    const c = new Weather(seeded(1));
    c.applyRemote(1, 1, false, 5000);
    expect(c.kind).toBe('thunder');
    expect(c.rain).toBe(0);
    run(c, 30);
    expect(c.rain).toBeCloseTo(0.3, 5);
    expect(c.rainTime).toBe(5000); // frozen
    c.applyRemote(0, 0, true);
    expect(c.rain).toBe(0);
    c.applyRemote(1, 0, true);
    expect(c.rain).toBe(1);
    expect(c.thunder).toBe(0);
  });

  it('lightning only strikes during a full thunderstorm, within range', () => {
    const w = new Weather(seeded(4));
    const out = { dx: 0, dz: 0 };
    let hits = 0;
    for (let i = 0; i < 10000; i++) if (w.rollLightning(out)) hits++;
    expect(hits).toBe(0);
    w.set('thunder', 1e6);
    run(w, 100);
    for (let i = 0; i < 60000; i++) {
      if (w.rollLightning(out)) {
        hits++;
        const d = Math.hypot(out.dx, out.dz);
        expect(d).toBeGreaterThanOrEqual(11.99);
        expect(d).toBeLessThanOrEqual(64.01);
      }
    }
    // 1/600 per tick: about 100 in 60000 ticks.
    expect(hits).toBeGreaterThan(50);
    expect(hits).toBeLessThan(200);
  });

  it('parses command words', () => {
    expect(parseWeatherKind('Rain')).toBe('rain');
    expect(parseWeatherKind('storm')).toBeNull();
    expect(parseWeatherKind(undefined)).toBeNull();
  });
});

describe('/weather command parsing', () => {
  it('accepts a kind with an optional duration in seconds', () => {
    expect(parseWeatherCommand(['rain'])).toEqual({ kind: 'rain' });
    expect(parseWeatherCommand(['thunder', '60'])).toEqual({ kind: 'thunder', ticks: 1200 });
    expect(parseWeatherCommand(['clear', '600'])).toEqual({ kind: 'clear', ticks: 12000 });
  });
  it('rejects nonsense', () => {
    expect(parseWeatherCommand([])).toBeNull();
    expect(parseWeatherCommand(['snow'])).toBeNull();
    expect(parseWeatherCommand(['rain', 'abc'])).toBeNull();
    expect(parseWeatherCommand(['rain', '-5'])).toBeNull();
    expect(parseWeatherCommand(['rain', '0'])).toBeNull();
    expect(parseWeatherCommand(['rain', '99999999'])).toBeNull();
  });
});

describe('precipitation rules', () => {
  it('rain in temperate biomes, snow in cold biomes and high up, none in deserts', () => {
    expect(precipitationFor(BIOME.PLAINS, 70)).toBe(Precip.RAIN);
    expect(precipitationFor(BIOME.FOREST, 70)).toBe(Precip.RAIN);
    expect(precipitationFor(BIOME.OCEAN, 62)).toBe(Precip.RAIN);
    expect(precipitationFor(BIOME.SNOWY, 70)).toBe(Precip.SNOW);
    expect(precipitationFor(BIOME.DESERT, 70)).toBe(Precip.NONE);
    expect(precipitationFor(BIOME.DESERT, 120)).toBe(Precip.NONE);
    expect(precipitationFor(BIOME.PLAINS, 110)).toBe(Precip.SNOW);
    expect(precipitationFor(BIOME.MOUNTAINS, 96)).toBe(Precip.SNOW);
    expect(precipitationFor(BIOME.MOUNTAINS, 80)).toBe(Precip.RAIN);
  });

  it('plants and air let rain through, solid blocks and water stop it', () => {
    expect(blocksPrecipitation(BLOCK.AIR)).toBe(false);
    expect(blocksPrecipitation(BLOCK.STONE)).toBe(true);
    expect(blocksPrecipitation(BLOCK.WATER)).toBe(true);
    expect(blocksPrecipitation(BLOCK.OAK_LEAVES)).toBe(true);
  });

  const world = (roofY: number | null, biome: number): WeatherWorld => ({
    getBlock: (_x, y) => (roofY !== null && y === roofY ? BLOCK.STONE : BLOCK.AIR),
    biomeAt: () => biome,
  });

  it('no rain under a roof, rain in the open', () => {
    expect(isExposed(world(null, BIOME.PLAINS), 0, 64, 0)).toBe(true);
    expect(isExposed(world(70, BIOME.PLAINS), 0, 64, 0)).toBe(false);
    expect(isExposed(world(60, BIOME.PLAINS), 0, 64, 0)).toBe(true);
  });

  it('isRainingAt combines level, exposure and biome (farmland, fire and burning hook)', () => {
    const w = new Weather(seeded(1));
    expect(w.isRainingAt(world(null, BIOME.PLAINS), 0, 64, 0)).toBe(false);
    w.set('rain', 1e6);
    run(w, 100);
    expect(w.isRainingAt(world(null, BIOME.PLAINS), 0, 64, 0)).toBe(true);
    expect(w.isRainingAt(world(70, BIOME.PLAINS), 0, 64, 0)).toBe(false);
    expect(w.isRainingAt(world(null, BIOME.SNOWY), 0, 64, 0)).toBe(false);
    expect(w.precipitationAt(world(null, BIOME.SNOWY), 0, 64, 0)).toBe(Precip.SNOW);
    expect(w.isRainingAt(world(null, BIOME.DESERT), 0, 64, 0)).toBe(false);
  });
});
