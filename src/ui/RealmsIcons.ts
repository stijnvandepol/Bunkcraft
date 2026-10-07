import type { GameType } from '../modes/GameTypes';

/**
 * 16×16 pixel-art icons for the Realms playlist, drawn in code (no Mojang assets) and scaled up with
 * `image-rendering: pixelated`, like a server icon in Minecraft's server list.
 */
const PALETTE: Record<string, string> = {
  k: '#141414', w: '#f2f2f2', g: '#a8a8a8', d: '#5a5a5a',
  r: '#e0463c', R: '#8e2a24', b: '#3c7ae0', B: '#244a8e',
  y: '#ffd23f', Y: '#b07a10', n: '#7a5230', G: '#5fbf4a', o: '#ff8c2a',
};

/** Background tile per mode (top and bottom of a vertical gradient in 4 bands). */
const BACKGROUND: Record<string, [string, string]> = {
  tdm: ['#3a2a4a', '#24182e'], ffa: ['#4a2a22', '#2e1814'], gungame: ['#4a3a1a', '#2e2410'], elimination: ['#3a1e22', '#241014'],
  hardpoint: ['#2a3a22', '#182414'], domination: ['#1e3040', '#101c28'], ctf: ['#22323a', '#141e24'],
  killconfirmed: ['#30302a', '#1c1c18'], snd: ['#3a2a1a', '#24180e'], infected: ['#22381e', '#122010'],
  sharpshooter: ['#2a2a3e', '#181826'], koth: ['#3e3418', '#26200c'],
};

const ART: Record<string, string[]> = {
  // Two crossed swords: red and blue hilts.
  tdm: [
    '................',
    '.kk..........kk.',
    '.kwk........kwk.',
    '..kwk......kwk..',
    '...kwk....kwk...',
    '....kwk..kwk....',
    '.....kwkkwk.....',
    '......kwwk......',
    '......kwwk......',
    '.....kwkkwk.....',
    '..kk.kgk.kgk.kk.',
    '..krkkk...kkkbk.',
    '...krk.....kbk..',
    '..krRk.....kBbk.',
    '.kRk.........kBk',
    '.kk...........kk',
  ],
  // A skull: everyone for themselves.
  ffa: [
    '................',
    '....kkkkkkkk....',
    '...kwwwwwwwwk...',
    '..kwwwwwwwwwwk..',
    '..kwwwwwwwwwwk..',
    '..kwkkkwwkkkwk..',
    '..kwkkkwwkkkwk..',
    '..kwkkkwwkkkwk..',
    '..kwwwwkkwwwwk..',
    '...kwwwkkwwwk...',
    '....kwwwwwwk....',
    '....kwkwkwkk....',
    '....kgkgkgkk....',
    '.....kkkkkk.....',
    '................',
    '................',
  ],
  // Rising bars topped by a gold arrow: climb the weapon ladder.
  gungame: [
    '................',
    '...........k....',
    '..........kyk...',
    '.........kyyyk..',
    '........kyyyyyk.',
    '.........kkykk..',
    '..........kyk...',
    '.......kk.kyk...',
    '.......kgkkyk...',
    '....kk.kgkkyk...',
    '....kgkkgkkYk...',
    '.kk.kgkkgkkYk...',
    '.kdkkgkkgkkYk...',
    '.kdkkdkkdkkYk...',
    '.kkkkkkkkkkkk...',
    '................',
  ],
  // One heart: one life per round.
  elimination: [
    '................',
    '................',
    '..kkk.....kkk...',
    '.krrrk...krrrk..',
    'krrwwrk.krrrrrk.',
    'krwwrrrkrrrrrrk.',
    'krwrrrrrrrrrrrk.',
    'krrrrrrrrrrrrrk.',
    '.krrrrrrrrrrRk..',
    '..krrrrrrrrRk...',
    '...krrrrrrRk....',
    '....krrrrRk.....',
    '.....krrRk......',
    '......kRk.......',
    '.......k........',
    '................',
  ],
  // A capture ring with a flag in the middle: hold the hill.
  hardpoint: [
    '................',
    '.......kk.......',
    '.......kykkk....',
    '.......kyyyyk...',
    '.......kyyyk....',
    '.......kkkk.....',
    '.......kgk......',
    '...kkkkkgkkkkk..',
    '..kyyyykgkyyyyk.',
    '.kyykkkkgkkkkyyk',
    '.kyk...kdk...kyk',
    '.kyykkkkkkkkkyyk',
    '..kyyyyyyyyyyyk.',
    '...kkkkkkkkkkk..',
    '................',
    '................',
  ],
  // Three points: blue, neutral and red.
  domination: [
    '................',
    '................',
    '...kkk..........',
    '..kbbbk.........',
    '..kbwbk...kkk...',
    '..kbbbk..kwwwk..',
    '...kgk...kwgwk..',
    '...kgk...kwwwk..',
    '...kgk....kgk...',
    '..kdddk...kgk...',
    '..kkkkk...kgk.k.',
    '.........kdddkrk',
    '.........kkkkkrk',
    '............kRk.',
    '............kkk.',
    '................',
  ],
  // A red flag on a pole.
  ctf: [
    '................',
    '...kk...........',
    '...kgkkkkkkk....',
    '...kgkrrrrrrkk..',
    '...kgkrrrrrrrrk.',
    '...kgkrrwwrrrrk.',
    '...kgkrrrrrrrRk.',
    '...kgkrrrrrRkk..',
    '...kgkkkkkkk....',
    '...kgk..........',
    '...kgk..........',
    '...kgk..........',
    '..kkgkk.........',
    '.kddddddk.......',
    '.kkkkkkkk.......',
    '................',
  ],
  // A dog tag on its chain.
  killconfirmed: [
    '................',
    '.....kkk........',
    '....kg.gk.......',
    '....kg..gk......',
    '.....kg..gk.....',
    '......kgkkkkkk..',
    '.......kwwwwwwk.',
    '.......kwgkwwwk.',
    '.......kwwwwwwk.',
    '.......kwddddwk.',
    '.......kwwwwwwk.',
    '.......kwddddwk.',
    '.......kwwwwwwk.',
    '.......kgwwwwgk.',
    '........kkkkkk..',
    '................',
  ],
  // The bomb: a dark crate with a red light and a wire.
  snd: [
    '................',
    '................',
    '..........kk....',
    '.........kook...',
    '........ko..k...',
    '..kkkkkkkokkkkk.',
    '.kddddddddddddk.',
    '.kdkkkkkkkkkkdk.',
    '.kdkrrkGGGGkdk..',
    '.kdkrrkGkGGkdk..',
    '.kdkkkkkkkkkkdk.',
    '.kddddddddddddk.',
    '.kdyyddddddyydk.',
    '.kddddddddddddk.',
    '..kkkkkkkkkkkk..',
    '................',
  ],
  // A green infected head with red eyes.
  infected: [
    '................',
    '....kkkkkkkk....',
    '...kGGGGGGGGk...',
    '..kGGgGGGGGGGk..',
    '..kGGGGGGGGgGk..',
    '..kGkkkGGkkkGk..',
    '..kGkrkGGkrkGk..',
    '..kGGGGGGGGGGk..',
    '..kGGGGkkGGGGk..',
    '...kGGGGGGGGk...',
    '...kGkwkwkwGk...',
    '...kGGGGGGGGk...',
    '....kGGGGGGk....',
    '.....kkkkkk.....',
    '................',
    '................',
  ],
  // A scope crosshair with a question mark: a random weapon.
  sharpshooter: [
    '................',
    '.......kk.......',
    '.....kkwwkk.....',
    '....kw.kk.wk....',
    '...kw..kk..wk...',
    '..kw.kyyyk..wk..',
    '..kw..k.yk..wk..',
    '.kkkkk.yk.kkkkk.',
    '.kkkkk.yk.kkkkk.',
    '..kw..kkk...wk..',
    '..kw...yk...wk..',
    '...kw..kk..wk...',
    '....kw.kk.wk....',
    '.....kkwwkk.....',
    '.......kk.......',
    '................',
  ],
  // A crown on a hill.
  koth: [
    '................',
    '................',
    '..k...k...k.....',
    '.kyk.kyk.kyk....',
    '.kyyk.y.kyyk....',
    '.kyyyyyyyyyk....',
    '.kyyrryybyyk....',
    '.kYYYYYYYYYk....',
    '..kkkkkkkkk.....',
    '................',
    '.....kkkkkk.....',
    '...kkGGGGGGkk...',
    '..kGGGGGGGGGGk..',
    '.kGGGGnGGGnGGGk.',
    'knnnnnnnnnnnnnnk',
    'kkkkkkkkkkkkkkkk',
  ],
};

const cache = new Map<string, string>();

/** Data URL of a mode's 16×16 icon (cached); a plain tile for unknown modes. */
export function realmsIcon(mode: GameType): string {
  const hit = cache.get(mode);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const [top, bottom] = BACKGROUND[mode] ?? ['#333', '#222'];
  for (let y = 0; y < 16; y++) {
    ctx.fillStyle = y < 8 ? top : bottom;
    ctx.fillRect(0, y, 16, 1);
  }
  const rows = ART[mode] ?? [];
  rows.forEach((row, y) => {
    for (let x = 0; x < 16; x++) {
      const col = PALETTE[row[x] ?? '.'];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  const url = c.toDataURL();
  cache.set(mode, url);
  return url;
}
