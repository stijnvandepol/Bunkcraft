import { describe, expect, it } from 'vitest';
import { type CommandHost, emptyModeration, runCommand } from '../server/Commands';

/** A command host that records what the commands did. */
function stubHost(moderated: boolean) {
  const replies: string[] = [];
  const times: unknown[] = [];
  const host: CommandHost = {
    mod: emptyModeration(), arcade: false, gameMode: 'survival', moderated,
    online: () => [], find: () => null,
    reply: (_to, text) => { replies.push(text); },
    broadcastSystem: () => undefined, say: () => undefined, kick: () => undefined, ban: () => undefined,
    unban: () => false, setOp: () => undefined, save: () => undefined, teleport: () => undefined,
    setGameMode: () => undefined, setTime: (t) => { times.push(t); }, give: () => false, seed: () => 1, spawn: () => undefined,
  };
  return { host, replies, times };
}

describe('/time', () => {
  it('only accepts the presets, never Object.prototype names', () => {
    for (const moderated of [true, false]) {
      const { host, times } = stubHost(moderated);
      const actor = { name: 'boss', op: true, owner: true };
      for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) runCommand(host, actor, `/time set ${bad}`);
      expect(times).toEqual([]);
      runCommand(host, actor, '/time set noon');
      expect(times).toEqual([0.25]);
    }
  });
});
