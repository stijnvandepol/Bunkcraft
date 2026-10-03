import { AudioEngine } from '../Audio';
import { BLOCK_SOUND_KINDS, SOUND_PROFILES } from './profiles';
import { UI_SOUND_NAMES } from './synth';
import { BIOME } from '../../world/Biomes';

/**
 * Every sound the engine can make, as a named recipe that plays it on a fresh engine (usually on an
 * OfflineAudioContext, see `offlineRender.ts`). The audio report renders each one and checks level and
 * clipping, so a new sound only needs a line here to be covered. Names match the `onSound` event names
 * where there is one.
 */
export interface CatalogEntry {
  name: string;
  /** Seconds to render. */
  seconds: number;
  /** Plays the sound on a prepared engine (all volumes at 100%). */
  play(engine: AudioEngine): void;
  /** Loose bounds for the report: RMS (dBFS over the whole render) must lie within them. */
  rmsMin?: number;
}

export const at = (x: number, z: number) => ({ x, y: 64, z });

function setupEnv(e: AudioEngine, fn: (env: AudioEngine['env']) => void): void {
  e.setListener(0, 65.6, 0, 0);
  const env = e.env;
  env.x = 0; env.y = 65; env.z = 0;
  fn(env);
}

export function buildCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const add = (name: string, seconds: number, play: (e: AudioEngine) => void, rmsMin = -75) => out.push({ name, seconds, play, rmsMin });

  for (const sound of Object.keys(SOUND_PROFILES)) {
    for (const kind of BLOCK_SOUND_KINDS) add(`block.${kind}.${sound}`, kind === 'break' ? 0.8 : 0.5, (e) => e.play(kind, sound));
  }
  for (const s of ['stone', 'grass', 'gravel', 'sand', 'wood', 'wool', 'snow', 'glass', 'metal', 'water', 'ladder']) {
    add(`player.step.${s}`, 0.4, (e) => e.playStep(s, 'walk', 0));
  }
  add('player.step.sprint', 0.4, (e) => e.playStep('stone', 'sprint', 1));
  add('player.step.sneak', 0.4, (e) => e.playStep('stone', 'sneak', 0));
  add('player.step.armor', 0.5, (e) => { e.setArmor('iron'); e.playStep('stone', 'walk', 0); });
  add('player.land.soft', 0.6, (e) => e.playLand('grass', 1.2));
  add('player.land.medium', 0.7, (e) => e.playLand('stone', 2.5));
  add('player.land.heavy', 0.9, (e) => e.playLand('stone', 8));
  add('player.jump', 0.4, (e) => e.playJump('grass'));
  add('player.splash', 1.2, (e) => e.playSplash(9));
  add('player.swim', 0.6, (e) => e.playSwim());
  add('player.armor', 0.5, (e) => e.playArmorClink('iron'));
  add('player.hurt', 0.4, (e) => e.playHurt());

  for (const [kind, ev] of [['pig', 'idle'], ['pig', 'hurt'], ['cow', 'idle'], ['sheep', 'idle'], ['chicken', 'idle'], ['zombie', 'idle'], ['zombie', 'death'], ['creeper', 'idle'], ['creeper', 'fuse']] as const) {
    add(`mob.${kind}.${ev}`, ev === 'fuse' ? 1.8 : 1.2, (e) => e.playMob(kind, ev, 1));
  }
  add('mob.zombie.idle.positional', 1.4, (e) => { setupEnv(e, () => {}); e.playMob('zombie', 'idle', 1, at(-8, -4)); });
  for (const kind of ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'skeleton', 'spider']) {
    add(`mob.${kind}.step`, 0.5, (e) => { setupEnv(e, () => {}); e.playMobStep(kind, 'grass', at(3, -2)); }, -90);
  }

  add('explosion', 3, (e) => e.playExplosion(1));
  add('explosion.far', 3, (e) => { setupEnv(e, () => {}); e.playExplosion(1, at(0, -60)); });
  add('weapon.bow', 0.6, (e) => e.playBow(1));
  add('weapon.arrow_hit', 0.4, (e) => e.playArrowHit(1));
  add('block.ignite', 1.8, (e) => e.playIgnite(1));
  add('block.door.open', 0.5, (e) => e.playDoor(true));
  add('block.door.close', 0.5, (e) => e.playDoor(false));
  add('block.fizz', 0.8, (e) => e.playFizz(1));
  add('block.click.on', 0.3, (e) => e.playClick(true));
  add('block.click.off', 0.3, (e) => e.playClick(false));
  add('block.piston.extend', 0.5, (e) => e.playPiston(true));
  add('block.piston.contract', 0.5, (e) => e.playPiston(false));
  for (const n of ['harp', 'basedrum', 'snare', 'hat', 'bass', 'chime']) add(`block.note.${n}`, 1, (e) => e.playNote(n, 1));
  add('item.bucket.water', 0.6, (e) => e.playBucket(false));
  add('item.bucket.lava', 0.6, (e) => e.playBucket(true));
  add('item.pickup', 0.3, (e) => e.playPop());
  add('player.eat', 0.3, (e) => e.playEat());
  add('player.burp', 0.5, (e) => e.playBurp());
  for (const w of ['rifle', 'smg', 'shotgun', 'sniper', 'pistol', 'knife']) add(`weapon.${w}`, w === 'shotgun' ? 1.2 : 0.9, (e) => e.playGun(w, 1));
  add('weapon.reload', 1.6, (e) => e.playReload(1.5));
  add('weapon.empty', 0.3, (e) => e.playEmpty());
  add('weapon.hitmarker', 0.4, (e) => e.playHitMarker(false));
  add('weapon.hitmarker.head', 0.4, (e) => e.playHitMarker(true));
  add('weapon.kill', 0.7, (e) => e.playKillDing());
  add('weapon.impact', 0.3, (e) => e.playBulletImpact(1));
  add('player.spawn', 0.5, (e) => e.playSpawn());
  for (const n of UI_SOUND_NAMES) add(`ui.${n}`, 1.0, (e) => e.playUi(n));

  // ---- ambience: let the beds run for a few seconds
  const bed = (e: AudioEngine, secs: number, fn: (env: AudioEngine['env']) => void) => {
    setupEnv(e, fn);
    for (let t = 0; t < secs; t += 0.2) e.update(0.2);
  };
  add('ambient.rain', 6, (e) => { e.setWeather(1, false); bed(e, 0.6, (env) => { env.enclosure = 0.1; env.skyLight = 15; }); });
  add('ambient.rain.indoors', 6, (e) => { e.setWeather(1, false); bed(e, 0.6, (env) => { env.enclosure = 0.8; env.skyLight = 7; }); }, -90);
  add('ambient.wind', 6, (e) => bed(e, 0.6, (env) => { env.y = 110; env.biome = BIOME.MOUNTAINS; env.skyLight = 15; env.enclosure = 0.05; }));
  add('ambient.crickets', 4, (e) => bed(e, 0.6, (env) => { env.y = 66; env.biome = BIOME.PLAINS; env.dayFactor = 0; env.skyLight = 12; env.enclosure = 0.1; }));
  add('ambient.birds', 4, (e) => { setupEnv(e, () => {}); for (let i = 0; i < 4; i++) e.internals.ambience.bird(1); });
  add('ambient.cave.drip', 1.5, (e) => { setupEnv(e, () => {}); e.internals.ambience.drip(1); });
  add('ambient.cave.drone', 10, (e) => { setupEnv(e, () => {}); e.internals.ambience.drone(); });
  add('ambient.cave.rumble', 6, (e) => { setupEnv(e, () => {}); e.internals.ambience.rumble(); });
  add('ambient.cave.bed', 6, (e) => bed(e, 0.6, (env) => { env.y = 30; env.skyLight = 0; env.enclosure = 0.9; }), -85);
  add('ambient.underwater', 4, (e) => { e.internals.ambience.bubbles(); bed(e, 0.6, (env) => { env.underwater = true; }); });
  add('ambient.lava', 4, (e) => bed(e, 1.6, (env) => { env.lavaDist = 3; env.lavaX = 3; env.lavaY = 64; env.lavaZ = -1; }));
  add('ambient.water_flow', 4, (e) => bed(e, 0.6, (env) => { env.waterDist = 3; env.waterX = -3; env.waterY = 64; env.waterZ = 0; }));
  add('ambient.fire', 3, (e) => bed(e, 1.6, (env) => { env.fireDist = 2; }));
  add('weather.thunder.near', 8, (e) => e.playThunder(60));
  add('weather.thunder.far', 12, (e) => e.playThunder(400));

  // ---- music
  const music = (e: AudioEngine, mode: 'menu' | 'game' | 'arcade', biome: number, day: number, cave: number) => {
    const m = e.internals.music;
    m.setMode(mode);
    m.setContext(biome, day, cave, false);
    m.playPhrase(0.05);
  };
  add('music.menu', 28, (e) => music(e, 'menu', BIOME.PLAINS, 1, 0), -70);
  add('music.game.day', 28, (e) => music(e, 'game', BIOME.FOREST, 1, 0), -70);
  add('music.game.night', 28, (e) => music(e, 'game', BIOME.PLAINS, 0, 0), -70);
  add('music.game.cave', 28, (e) => music(e, 'game', BIOME.PLAINS, 1, 1), -70);
  add('music.arcade.pulse', 8, (e) => {
    const m = e.internals.music;
    e.setMusicMode('arcade');
    e.setMusicIntensity(1);
    m.update(5, true);
    m.schedulePulse(8);
  }, -70);
  return out;
}
