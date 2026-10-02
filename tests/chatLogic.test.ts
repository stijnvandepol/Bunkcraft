import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChatHistory, LOCAL_COMMAND_USAGE, SERVER_COMMAND_USAGE, commonPrefix, parseChatColors, suggestCommands } from '../src/ui/chatLogic';

describe('command table', () => {
  it('matches the commands and usage lines in server/Commands.ts', () => {
    const src = readFileSync(new URL('../server/Commands.ts', import.meta.url), 'utf8');
    const found = [...src.matchAll(/^ {2}(\w+): \{\s*\n?\s*usage: '([^']+)'/gm)].map((m) => [m[1], m[2]] as const);
    expect(found.length).toBeGreaterThan(10);
    expect(Object.fromEntries(found)).toEqual(SERVER_COMMAND_USAGE);
  });
});

describe('suggestCommands', () => {
  it('completes command names', () => {
    expect(suggestCommands('/we')).toEqual(['/weather']);
    expect(suggestCommands('/b')).toEqual(['/ban', '/banlist']);
    expect(suggestCommands('/')).toContain('/gamemode');
    expect(suggestCommands('/zzz')).toEqual([]);
    expect(suggestCommands('hello')).toEqual([]);
  });

  it('completes fixed arguments from the usage line', () => {
    expect(suggestCommands('/weather ')).toEqual(['/weather clear', '/weather rain', '/weather thunder']);
    expect(suggestCommands('/weather r')).toEqual(['/weather rain']);
    expect(suggestCommands('/gamemode s')).toEqual(['/gamemode spectator', '/gamemode survival']);
    expect(suggestCommands('/time set n')).toEqual(['/time set night', '/time set noon']);
    expect(suggestCommands('/time ')).toEqual(['/time set']);
  });

  it('does not suggest for free text arguments or finished words', () => {
    expect(suggestCommands('/kick ')).toEqual([]);
    expect(suggestCommands('/weather rain')).toEqual([]);
  });

  it('only offers local commands in singleplayer', () => {
    expect(suggestCommands('/', LOCAL_COMMAND_USAGE)).toEqual(['/help', '/weather']);
  });

  it('finds the common prefix', () => {
    expect(commonPrefix(['/ban', '/banlist'])).toBe('/ban');
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(['/weather'])).toBe('/weather');
  });
});

describe('ChatHistory', () => {
  it('walks up and down and restores the draft', () => {
    const h = new ChatHistory();
    h.push('one');
    h.push('two');
    h.push('three');
    expect(h.up('dra')).toBe('three');
    expect(h.up('x')).toBe('two');
    expect(h.up('x')).toBe('one');
    expect(h.up('x')).toBe('one');
    expect(h.down('x')).toBe('two');
    expect(h.down('x')).toBe('three');
    expect(h.down('x')).toBe('dra');
    expect(h.down('typed')).toBe('typed');
  });

  it('ignores empty lines and consecutive duplicates and caps its size', () => {
    const h = new ChatHistory(3);
    h.push('  ');
    h.push('a');
    h.push('a');
    expect(h.length).toBe(1);
    for (const w of ['b', 'c', 'd']) h.push(w);
    expect(h.length).toBe(3);
    expect(h.up('')).toBe('d');
    expect(h.up('')).toBe('c');
    expect(h.up('')).toBe('b');
    expect(h.up('')).toBe('b');
  });

  it('does nothing when empty', () => {
    const h = new ChatHistory();
    expect(h.up('abc')).toBe('abc');
    expect(h.down('abc')).toBe('abc');
  });
});

describe('parseChatColors', () => {
  it('splits colour codes into segments', () => {
    expect(parseChatColors('a§cb§rc')).toEqual([{ text: 'a', color: null }, { text: 'b', color: '#ff5555' }, { text: 'c', color: null }]);
  });

  it('strips codes when colours are off and keeps a lone section sign', () => {
    expect(parseChatColors('§aGreen §lx', false).map((s) => s.text).join('')).toBe('Green §lx');
    expect(parseChatColors('§aGreen', false)[0].color).toBeNull();
    expect(parseChatColors('cost §')[0].text).toBe('cost §');
  });
});
