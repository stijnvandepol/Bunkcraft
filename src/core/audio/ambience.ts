import { birdFactor, caveFactor, cricketFactor, windFactor, type AudioEnvironment } from './environment';
import { distanceGain, panFor } from './spatial';
import { Priority } from './voiceLimiter';
import type { Synth } from './synth';

/** Listener state shared by the engine and the ambience (scalars only: updated every frame, no allocation). */
export interface ListenerState {
  x: number; y: number; z: number; yaw: number;
}

export type SoundEmit = (name: string, x: number, y: number, z: number, volume: number) => void;

function sstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Looping noise through a filter chain with a smoothly controlled level; stops itself when silent for a while. */
class Loop {
  private src: AudioBufferSourceNode | null = null;
  private readonly out: GainNode;
  readonly pan: StereoPannerNode;
  private level = 0;
  private silentFor = 0;
  /** Nodes whose parameters the owner wants to tweak (filters, LFO gains). */
  readonly nodes: AudioNode[] = [];
  private extras: AudioScheduledSourceNode[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly buffer: AudioBuffer,
    dest: AudioNode,
    private readonly build: (src: AudioBufferSourceNode, loop: Loop) => AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(dest);
  }

  /** Keep an auxiliary oscillator (LFO) alive with the loop. */
  addExtra(o: AudioScheduledSourceNode): void {
    this.extras.push(o);
  }

  get running(): boolean {
    return this.src !== null;
  }

  set(level: number, dt: number, pan = 0): void {
    this.level = level;
    const t = this.ctx.currentTime;
    if (level > 0.002) {
      this.silentFor = 0;
      if (!this.src) this.start();
    } else if (this.src) {
      this.silentFor += dt;
      if (this.silentFor > 4) this.stop();
    }
    if (this.src || level > 0) {
      this.out.gain.setTargetAtTime(level, t, 0.35);
      this.pan.pan.setTargetAtTime(pan, t, 0.2);
    }
  }

  private start(): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.buffer.duration;
    this.nodes.length = 0;
    const tail = this.build(src, this);
    tail.connect(this.out);
    src.start(this.ctx.currentTime, Math.random() * this.buffer.duration);
    this.src = src;
  }

  private stop(): void {
    try { this.src?.stop(); } catch { /* already stopped */ }
    for (const e of this.extras) { try { e.stop(); } catch { /* already stopped */ } }
    this.extras = [];
    this.src = null;
    this.out.gain.value = 0;
  }

  /** Hard stop (engine suspended or torn down). */
  dispose(): void {
    this.stop();
  }

  get current(): number {
    return this.level;
  }
}

/**
 * Environmental sound: looping beds (rain, wind, water, lava, cave hum, underwater) and randomly timed
 * events (cave drips, drones, birds, crickets, bubbles, lava pops, fire crackle, thunder). Driven by
 * {@link AudioEnvironment}; all levels follow the world, nothing here touches the game.
 */
export class Ambience {
  private readonly rainLoop: Loop;
  private readonly windLoop: Loop;
  private readonly waterLoop: Loop;
  private readonly lavaLoop: Loop;
  private readonly caveLoop: Loop;
  private readonly underLoop: Loop;
  private cricketNodes: { o: OscillatorNode[]; g: GainNode } | null = null;
  private cricketLevel = 0;
  private cricketSilent = 0;

  private accum = 0;
  private tDrip = 3;
  private tDrone = 20;
  private tRumble = 50;
  private tBird = 4;
  private tBubble = 1;
  private tLava = 1;
  private tFire = 1;
  private tThunder = 12;
  rain = 0;
  thunder = false;
  autoThunder = true;
  /** 0..1 as last computed from the environment (read by the engine for music muffling and cave reverb). */
  cave = 0;
  /** Called when the internal lightning timer fires: (distance in blocks). The weather visuals can sync a flash. */
  onLightning: ((distance: number) => void) | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly synth: Synth,
    private readonly bus: AudioNode,
    pink: AudioBuffer,
    brown: AudioBuffer,
    private readonly listener: ListenerState,
    private readonly emit: SoundEmit,
  ) {
    // Rain: hiss band + low body, both from one pink noise loop.
    this.rainLoop = new Loop(ctx, pink, bus, (src, loop) => {
      const hi = ctx.createBiquadFilter();
      hi.type = 'bandpass'; hi.frequency.value = 4800; hi.Q.value = 0.35;
      const lo = ctx.createBiquadFilter();
      lo.type = 'lowpass'; lo.frequency.value = 1100;
      const hg = ctx.createGain(); hg.gain.value = 0.55;
      const lg = ctx.createGain(); lg.gain.value = 0.6;
      const mix = ctx.createBiquadFilter(); // indoor muffling: cut-off driven by the owner
      mix.type = 'lowpass'; mix.frequency.value = 9000;
      src.connect(hi).connect(hg).connect(mix);
      src.connect(lo).connect(lg).connect(mix);
      loop.nodes.push(mix);
      return mix;
    });
    // Wind: brown noise through a band-pass that slowly wanders, plus a slow level swell.
    this.windLoop = new Loop(ctx, brown, bus, (src, loop) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.9;
      const swell = ctx.createGain(); swell.gain.value = 0.7;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
      const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 220;
      lfo.connect(lfoDepth).connect(bp.frequency);
      const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.063;
      const lfo2Depth = ctx.createGain(); lfo2Depth.gain.value = 0.3;
      lfo2.connect(lfo2Depth).connect(swell.gain);
      lfo.start(); lfo2.start();
      loop.addExtra(lfo); loop.addExtra(lfo2);
      src.connect(bp).connect(swell);
      return swell;
    });
    this.waterLoop = new Loop(ctx, pink, bus, (src) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
      src.connect(bp);
      return bp;
    });
    this.lavaLoop = new Loop(ctx, brown, bus, (src) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 160;
      src.connect(lp);
      return lp;
    });
    this.caveLoop = new Loop(ctx, brown, bus, (src) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 110;
      src.connect(lp);
      return lp;
    });
    this.underLoop = new Loop(ctx, brown, bus, (src) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 260;
      src.connect(lp);
      return lp;
    });
  }

  setWeather(rain: number, thunder: boolean, autoThunder = true): void {
    this.rain = Math.min(1, Math.max(0, rain));
    this.thunder = thunder;
    this.autoThunder = autoThunder;
  }

  update(dt: number, env: AudioEnvironment): void {
    this.accum += dt;
    if (this.accum < 0.1) return;
    const step = this.accum;
    this.accum = 0;
    const l = this.listener;
    const cave = caveFactor(env.skyLight, env.enclosure, env.y);
    this.cave = cave;
    const submerged = env.underwater ? 1 : 0;

    // ---- beds
    const open = (1 - sstep(0.3, 0.65, env.enclosure)) * sstep(5, 13, env.skyLight);
    const roof = 1 - open; // covered: indoors, under trees, in a cave
    const rainLevel = this.rain * (0.1 + 0.34 * open + 0.1 * (1 - cave) * roof) * (1 - 0.8 * submerged);
    this.rainLoop.set(rainLevel, step);
    const rainFilter = this.rainLoop.nodes[0] as BiquadFilterNode | undefined;
    if (rainFilter) rainFilter.frequency.setTargetAtTime(1300 + 7500 * open, this.ctx.currentTime, 0.4);
    this.windLoop.set(windFactor(env) * 0.32 * (1 - submerged) + this.rain * 0.05 * open, step);
    this.caveLoop.set(cave * 0.09 * (1 - submerged), step);
    this.underLoop.set(submerged * 0.2, step);

    const water = env.waterDist < 12 ? distanceGain(env.waterDist, 12) * 0.28 : 0;
    this.waterLoop.set(water * (1 - submerged), step, panFor(env.waterX - l.x, env.waterZ - l.z, l.yaw));
    const lava = env.lavaDist < 10 ? distanceGain(env.lavaDist, 10) * 0.3 : 0;
    this.lavaLoop.set(lava, step, panFor(env.lavaX - l.x, env.lavaZ - l.z, l.yaw));

    // ---- crickets
    this.updateCrickets(cricketFactor(env) * 0.045, step);

    // ---- random events
    const s = this.synth;
    s.priority = Priority.Ambient;
    s.out = this.bus;

    if (cave > 0.25 && !env.underwater) {
      this.tDrip -= step;
      if (this.tDrip <= 0) {
        this.tDrip = 1.5 + Math.random() * 7 / (0.3 + cave);
        this.drip(cave);
      }
      this.tDrone -= step;
      if (this.tDrone <= 0) {
        this.tDrone = 45 + Math.random() * 90;
        if (cave > 0.5) this.drone();
      }
      this.tRumble -= step;
      if (this.tRumble <= 0) {
        this.tRumble = 60 + Math.random() * 140;
        if (cave > 0.5) this.rumble();
      }
    }

    const birds = birdFactor(env) * (1 - this.rain * 0.8);
    if (birds > 0.05) {
      this.tBird -= step;
      if (this.tBird <= 0) {
        this.tBird = (2 + Math.random() * 6) / birds;
        this.bird(birds);
      }
    }

    if (env.underwater) {
      this.tBubble -= step;
      if (this.tBubble <= 0) {
        this.tBubble = 0.6 + Math.random() * 2.4;
        this.bubbles();
      }
    }

    if (env.lavaDist < 12) {
      this.tLava -= step;
      if (this.tLava <= 0) {
        this.tLava = 0.25 + Math.random() * 1.6;
        this.lavaPop(env, distanceGain(env.lavaDist, 12));
      }
    }
    if (env.fireDist < 10) {
      this.tFire -= step;
      if (this.tFire <= 0) {
        this.tFire = 0.08 + Math.random() * 0.5;
        this.firePop(distanceGain(env.fireDist, 10));
      }
    }

    if (this.thunder && this.autoThunder) {
      this.tThunder -= step;
      if (this.tThunder <= 0) {
        this.tThunder = 7 + Math.random() * 20;
        const d = 60 + Math.random() * 380;
        this.onLightning?.(d);
        this.playThunder(d);
      }
    }
  }

  // ---------------------------------------------------------------- events

  private panned(pan: number): AudioNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.bus);
    return p;
  }

  /** A water drop in a cave, with two fading echoes. */
  drip(cave: number): void {
    const s = this.synth;
    const out = this.panned((Math.random() * 2 - 1) * 0.8);
    s.out = out;
    const f = 1100 + Math.random() * 1500;
    const v = 0.1 + 0.08 * cave;
    s.tone('sine', f * 1.15, f * 0.85, 0.09, v, 0, { lp: 0, attack: 0.002 });
    s.noiseBurst(f * 2, 1.5, 0.02, v * 0.4, 'bandpass');
    s.tone('sine', f * 1.12, f * 0.86, 0.1, v * 0.35, 0.16, { lp: 0, attack: 0.002 });
    s.tone('sine', f * 1.1, f * 0.88, 0.1, v * 0.15, 0.34, { lp: 0, attack: 0.002 });
    s.out = this.bus;
    this.emit('ambient.cave.drip', NaN, NaN, NaN, v);
  }

  /** Slow deep drone: two detuned sines swelling in and out. */
  drone(): void {
    const s = this.synth;
    const f = 48 + Math.random() * 22;
    s.tone('sine', f, f * 0.98, 9, 0.16, 0, { attack: 3, lp: 300 });
    s.tone('sine', f * 1.012, f, 9, 0.12, 0, { attack: 3.4, lp: 300 });
    s.tone('triangle', f * 2.01, f * 2, 7, 0.04, 0.5, { attack: 3, lp: 400 });
    this.emit('ambient.cave.drone', NaN, NaN, NaN, 0.16);
  }

  /** Distant rumble: a swell of low noise, as if rock shifts far away. */
  rumble(): void {
    const s = this.synth;
    const out = this.panned((Math.random() * 2 - 1) * 0.6);
    s.out = out;
    s.noiseBurst(95, 0.6, 4.5, 0.45, 'lowpass', 0, { attack: 1.4 });
    s.noiseBurst(220, 0.7, 3, 0.15, 'lowpass', 0.3, { attack: 1.2 });
    s.out = this.bus;
    this.emit('ambient.cave.rumble', NaN, NaN, NaN, 0.45);
  }

  /** One bird call from a random direction. */
  bird(factor: number): void {
    const s = this.synth;
    const pan = (Math.random() * 2 - 1) * 0.9;
    s.out = this.panned(pan);
    const dist = 0.35 + Math.random() * 0.65; // loudness stands in for distance
    const v = 0.06 * dist * Math.min(1, 0.5 + factor);
    const base = 2200 + Math.random() * 2300;
    const kind = Math.floor(Math.random() * 3);
    if (kind === 0) {
      for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) {
        s.tone('sine', base * (1 + i * 0.08), base * (1.25 + i * 0.1), 0.07, v, i * 0.1 + Math.random() * 0.02, { lp: 0, attack: 0.012 });
      }
    } else if (kind === 1) {
      for (let i = 0; i < 6; i++) s.tone('sine', base * 0.8, base * 0.95, 0.04, v * 0.8, i * 0.055, { lp: 0, attack: 0.006 });
    } else {
      s.tone('sine', base * 1.3, base * 0.8, 0.28, v, 0, { lp: 0, attack: 0.04 });
      s.tone('sine', base * 2.6, base * 1.6, 0.2, v * 0.15, 0, { lp: 0, attack: 0.04 });
    }
    s.out = this.bus;
    this.emit('ambient.bird', NaN, NaN, NaN, v);
  }

  /** A few rising bubbles while submerged. */
  bubbles(): void {
    const s = this.synth;
    s.out = this.panned((Math.random() * 2 - 1) * 0.5);
    const n = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const f = 350 + Math.random() * 450;
      s.tone('sine', f, f * 2.4, 0.06, 0.1, i * (0.05 + Math.random() * 0.07), { lp: 0, attack: 0.004 });
    }
    s.out = this.bus;
  }

  private lavaPop(env: AudioEnvironment, near: number): void {
    const s = this.synth;
    const l = this.listener;
    s.out = this.panned(panFor(env.lavaX - l.x, env.lavaZ - l.z, l.yaw));
    const v = 0.22 * near;
    if (Math.random() < 0.55) {
      s.noiseBurst(300 + Math.random() * 250, 1, 0.12, v, 'bandpass');
      s.tone('sine', 140 + Math.random() * 80, 70, 0.1, v * 0.7, 0, { lp: 0 });
    } else {
      s.noiseBurst(1200 + Math.random() * 1500, 1.2, 0.025, v * 0.6, 'bandpass', 0, { grains: 1 });
    }
    s.out = this.bus;
    this.emit('ambient.lava.pop', env.lavaX, env.lavaY, env.lavaZ, v);
  }

  private firePop(near: number): void {
    const s = this.synth;
    s.out = this.panned((Math.random() * 2 - 1) * 0.4);
    s.noiseBurst(1800 + Math.random() * 2500, 1.4, 0.02 + Math.random() * 0.03, 0.2 * near, 'bandpass');
    s.out = this.bus;
  }

  /** Thunder: a crack (if close) and a long irregular rumble, delayed by the speed of sound (exaggerated). */
  playThunder(distance: number): void {
    const delay = Math.min(6, distance / 70);
    const near = 1 - Math.min(1, distance / 600);
    const v = 0.35 + 0.65 * near;
    const s = this.synth;
    const prev = s.priority;
    s.priority = Priority.Player;
    s.out = this.bus;
    if (distance < 160) {
      s.noiseBurst(3200, 0.5, 0.35, v * 0.9, 'highpass', delay, { attack: 0.001 });
      s.noiseBurst(1200, 0.6, 0.5, v * 0.7, 'bandpass', delay);
    }
    const len = 2.8 + 2.2 * near + Math.random();
    s.noiseBurst(180, 0.6, len, v * 1.1, 'lowpass', delay + 0.05, { attack: 0.08 });
    s.noiseBurst(90, 0.7, len * 1.2, v * 0.9, 'lowpass', delay + 0.1, { attack: 0.3 });
    // Rolling re-bumps.
    for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) {
      s.noiseBurst(140 + Math.random() * 120, 0.6, 1.4 + Math.random(), v * (0.7 - i * 0.12), 'lowpass', delay + 0.5 + i * (0.5 + Math.random() * 0.7), { attack: 0.15 });
    }
    s.tone('sine', 55, 32, len * 0.7, v * 0.5, delay + 0.05, { lp: 0, attack: 0.15 });
    s.priority = prev;
    this.emit('weather.thunder', NaN, NaN, NaN, v);
  }

  // ---------------------------------------------------------------- crickets

  private updateCrickets(level: number, dt: number): void {
    const ctx = this.ctx;
    this.cricketLevel = level;
    if (level > 0.002) {
      this.cricketSilent = 0;
      if (!this.cricketNodes) this.startCrickets();
    } else if (this.cricketNodes) {
      this.cricketSilent += dt;
      if (this.cricketSilent > 4) {
        for (const o of this.cricketNodes.o) { try { o.stop(); } catch { /* stopped */ } }
        this.cricketNodes.g.disconnect();
        this.cricketNodes = null;
        return;
      }
    }
    this.cricketNodes?.g.gain.setTargetAtTime(this.cricketLevel, ctx.currentTime, 0.8);
  }

  private startCrickets(): void {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(this.bus);
    const oscs: OscillatorNode[] = [];
    // Two crickets: carrier, fast chirp AM (pulses), slow gating AM (chirp groups).
    for (const [carrier, pulse, gate, pan] of [[4300, 21, 2.3, -0.5], [4850, 17, 1.7, 0.55]] as const) {
      const c = ctx.createOscillator(); c.frequency.value = carrier;
      const am1 = ctx.createGain(); am1.gain.value = 0.5;
      const l1 = ctx.createOscillator(); l1.frequency.value = pulse;
      const d1 = ctx.createGain(); d1.gain.value = 0.5;
      l1.connect(d1).connect(am1.gain);
      const am2 = ctx.createGain(); am2.gain.value = 0.35;
      const l2 = ctx.createOscillator(); l2.frequency.value = gate;
      const d2 = ctx.createGain(); d2.gain.value = 0.65;
      l2.connect(d2).connect(am2.gain);
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      c.connect(am1).connect(am2).connect(p).connect(master);
      c.start(); l1.start(); l2.start();
      oscs.push(c, l1, l2);
    }
    this.cricketNodes = { o: oscs, g: master };
  }

  /** Stop every loop (engine suspend / teardown). */
  dispose(): void {
    for (const l of [this.rainLoop, this.windLoop, this.waterLoop, this.lavaLoop, this.caveLoop, this.underLoop]) l.dispose();
    if (this.cricketNodes) {
      for (const o of this.cricketNodes.o) { try { o.stop(); } catch { /* stopped */ } }
      this.cricketNodes = null;
    }
  }

  /** Active loop count (debug overlay). */
  get activeLoops(): number {
    let n = 0;
    for (const l of [this.rainLoop, this.windLoop, this.waterLoop, this.lavaLoop, this.caveLoop, this.underLoop]) if (l.running) n++;
    return n + (this.cricketNodes ? 1 : 0);
  }
}
